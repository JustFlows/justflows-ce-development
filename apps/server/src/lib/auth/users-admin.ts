// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb, type DbClient } from "../database/db.js";
import { hashPassword } from "./password.js";
import { getGeneralSettings } from "../settings/general-settings.js";
import { isAssignableRole, listAssignableRoles } from "./assignable-roles.js";
import { STORED_ROLE_ID } from "./rbac.js";
import { PasswordSchema } from "./password-policy.js";
import { revokeUserSessions } from "./auth-session.js";
import { auditLog } from "../security/audit-log.js";
import {
  customRoleCapabilities,
  delegationAuthority,
  exceedsAuthority,
  roleCapabilitiesToDelegate,
  type DelegatingActor,
} from "./delegation.js";
import {
  availableCapabilityDefinitions,
  CAPABILITY_ID_PATTERN,
  capabilitiesOfRoles,
  getEffectiveAccess,
  listAdditionalRoles,
} from "./access-policy.js";

/**
 * Shared user administration behind both `routes/users.ts` (cookie auth) and
 * the federated management API. Covers the CRUD subset the management API
 * federates — list, read, create, update (role / access policy / display
 * name), delete — with the last-administrator floor and audit-logging intact.
 * Invitations, password resets and GDPR export/erase stay route-only.
 */

export interface UserAdminActor extends DelegatingActor {
  ip?: string | null;
  userAgent?: string | null;
}

export interface UserAdminResult {
  status: number;
  body: unknown;
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

const BEYOND_AUTHORITY = { status: 403, body: { error: "You cannot give access you don't have yourself" } };

export async function emitUserEvent(
  event: "user.created" | "user.updated" | "user.deleted",
  userId: string,
  siteId: string,
): Promise<void> {
  const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  await getRuntimeHooks().dispatchAction(event, { userId }, { siteId, source: "http" });
}

/** Administrators left on the site — the floor the CRUD guards check against. */
export async function countAdministrators(db: DbClient, siteId: string): Promise<number> {
  const rows = await db.query<{ count: number | string }>(
    "SELECT COUNT(*) as count FROM users WHERE site_id = ? AND role = 'administrator'",
    [siteId],
  );
  return Number(rows[0]?.count ?? 0);
}

function audit(
  actor: UserAdminActor,
  action: "user.created" | "user.role_changed" | "user.access_changed" | "user.deleted",
  target: string,
  detail?: string,
): void {
  void auditLog({
    siteId: actor.siteId,
    action,
    // Empty when a visitor creates their own account through a plugin (Shop checkout): no actor.
    actorId: actor.userId || null,
    actorRole: actor.role,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    target,
    detail: detail ?? null,
  });
}

export async function listUsers(siteId: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  const users = await db.query<Record<string, unknown>>(
    "SELECT id, email, username, display_name, role, created_at FROM users WHERE site_id = ? ORDER BY created_at ASC",
    [siteId],
  );
  const extra = await db
    .query<{ user_id: string; role: string }>(
      "SELECT user_id, role FROM user_additional_roles WHERE site_id = ? ORDER BY role",
      [siteId],
    )
    .catch(() => []);
  const byUser = new Map<string, string[]>();
  for (const row of extra) {
    if (row.role === "administrator") continue;
    byUser.set(String(row.user_id), [...(byUser.get(String(row.user_id)) ?? []), String(row.role)]);
  }
  return users.map((user) => ({
    ...user,
    additionalRoles: (byUser.get(String(user.id)) ?? []).filter((role) => role !== user.role),
  }));
}

/**
 * Additional roles must be built-in or plugin-registered roles (custom access
 * roles live in the access policy instead) and never administrator — admin
 * rights come only from the primary role, which every role check reads.
 */
async function validateAdditionalRoles(roles: readonly string[]): Promise<string | null> {
  const assignable = new Set((await listAssignableRoles()).map((entry) => entry.id));
  for (const role of roles) {
    if (role === "administrator") return "Administrator can only be a primary role";
    if (!assignable.has(role)) return "Unknown role";
  }
  return null;
}

async function writeAdditionalRoles(
  db: DbClient,
  siteId: string,
  userId: string,
  roles: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM user_additional_roles WHERE user_id = ? AND site_id = ?", [userId, siteId]);
    for (const role of roles) {
      await tx.run(
        "INSERT INTO user_additional_roles (user_id, site_id, role, created_at) VALUES (?, ?, ?, ?)",
        [userId, siteId, role, now()],
      );
    }
  });
}

export interface UserDetailOptions {
  /**
   * Include the user's recent audit trail. The trail holds IP addresses, so
   * only administrators may see it — the same rule as GET /api/audit.
   */
  includeActivity?: boolean;
}

/** A detail section that fails (pending migration, dialect quirk) is empty, not a failed page. */
async function optionalQuery<T>(db: DbClient, sql: string, params: string[]): Promise<T[]> {
  try {
    return await db.query<T>(sql, params);
  } catch {
    return [];
  }
}

export async function getUserWithAccess(
  siteId: string,
  userId: string,
  options: UserDetailOptions = {},
): Promise<UserAdminResult> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT id, email, username, display_name, role, created_at, updated_at, totp_confirmed_at FROM users WHERE id = ? AND site_id = ? LIMIT 1",
    [userId, siteId],
  );
  if (!rows[0]) return { status: 404, body: { error: "User not found" } };
  const row = rows[0] as Record<string, unknown> & { id: string; role: string };
  const access = await getEffectiveAccess(row.id, siteId, row.role, db);

  const statusCounts = await optionalQuery<{ status: string; count: number | string }>(
    db,
    "SELECT status, COUNT(*) AS count FROM content WHERE site_id = ? AND author_id = ? AND trashed_at IS NULL GROUP BY status",
    [siteId, row.id],
  );
  const contentByStatus = Object.fromEntries(statusCounts.map((entry) => [String(entry.status), Number(entry.count)]));
  const recentContent = await optionalQuery<Record<string, unknown>>(
    db,
    "SELECT id, type, title, status, updated_at FROM content WHERE site_id = ? AND author_id = ? AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT 10",
    [siteId, row.id],
  );
  const recentActivity = options.includeActivity
    ? await optionalQuery<Record<string, unknown>>(
        db,
        "SELECT id, occurred_at, action, outcome, target, ip FROM audit_log WHERE site_id = ? AND actor_id = ? ORDER BY occurred_at DESC LIMIT 20",
        [siteId, row.id],
      )
    : undefined;

  return {
    status: 200,
    body: {
      user: {
        // Listed explicitly: the row also carries the TOTP column, and the
        // secret-adjacent state is reported only as a boolean.
        id: row.id,
        email: row.email,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        created_at: row.created_at,
        updated_at: row.updated_at ?? null,
        twoFactorEnabled: row.totp_confirmed_at != null,
        roleId: access.roleId,
        additionalRoles: access.additionalRoles,
        accessPolicy: access.policy,
        effectiveCapabilities: access.capabilities,
        content: {
          total: Object.values(contentByStatus).reduce((sum, count) => sum + count, 0),
          byStatus: contentByStatus,
          recent: recentContent.map((item) => ({
            id: String(item.id),
            type: String(item.type),
            title: String(item.title),
            status: String(item.status),
            updatedAt: item.updated_at == null ? null : String(item.updated_at),
          })),
        },
        ...(recentActivity && {
          recentActivity: recentActivity.map((entry) => ({
            id: String(entry.id),
            occurredAt: String(entry.occurred_at ?? ""),
            action: String(entry.action),
            outcome: String(entry.outcome ?? "success"),
            target: entry.target == null ? null : String(entry.target),
            ip: entry.ip == null ? null : String(entry.ip),
          })),
        }),
      },
    },
  };
}

export const CreateUserSchema = z.object({
  email: z.string().email(),
  username: z.string().min(2).max(60),
  displayName: z.string().min(1),
  password: PasswordSchema,
  role: z.string().regex(STORED_ROLE_ID).optional(),
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export async function createUser(
  input: CreateUserInput,
  actor: UserAdminActor,
): Promise<UserAdminResult> {
  const { email, username, displayName, password } = input;
  const general = await getGeneralSettings(actor.siteId);
  const role = input.role ?? general.defaultRole;
  if (!(await isAssignableRole(role))) {
    return { status: 400, body: { error: "Unknown role" } };
  }
  const authority = await delegationAuthority(actor, await getDb());
  if (!authority.unrestricted && (role === "administrator" || exceedsAuthority(authority, await roleCapabilitiesToDelegate(authority, role)))) {
    return BEYOND_AUTHORITY;
  }
  const { enforceQuota } = await import("../tenancy/quotas.js");
  const quota = await enforceQuota("users", actor.siteId, 1);
  if (quota) return { status: quota.status, body: { error: quota.error, code: quota.code, meter: quota.meter } };
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  await (
    await getDb()
  ).run(
    `INSERT INTO users (id, site_id, email, username, display_name, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, actor.siteId, email.toLowerCase(), username, displayName, passwordHash, role, now(), now()],
  );
  audit(actor, "user.created", id, `role=${role}`);
  await emitUserEvent("user.created", id, actor.siteId);
  return { status: 201, body: { id, email, username, displayName, role } };
}

export const PatchUserSchema = z.object({
  role: z.string().regex(STORED_ROLE_ID).optional(),
  roleId: z.string().min(1).max(80).optional(),
  grants: z.array(z.string().regex(CAPABILITY_ID_PATTERN)).max(250).optional(),
  denies: z.array(z.string().regex(CAPABILITY_ID_PATTERN)).max(250).optional(),
  scopes: z
    .record(
      z.string().regex(CAPABILITY_ID_PATTERN),
      z.object({
        siteIds: z.array(z.string().uuid()).max(50).optional(),
        contentTypes: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,59}$/)).max(50).optional(),
        locales: z.array(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)).max(50).optional(),
        ownership: z.enum(["any", "self"]).optional(),
      }),
    )
    .optional(),
  displayName: z.string().min(1).optional(),
  /** Replaces the user's additional roles. See validateAdditionalRoles(). */
  additionalRoles: z.array(z.string().regex(STORED_ROLE_ID)).max(20).optional(),
});
export type PatchUserInput = z.infer<typeof PatchUserSchema>;

export async function updateUser(
  targetUserId: string,
  patch: PatchUserInput,
  actor: UserAdminActor,
): Promise<UserAdminResult> {
  const { role, roleId, grants, denies, scopes, displayName, additionalRoles } = patch;
  const db = await getDb();

  const policyChanged =
    roleId !== undefined || grants !== undefined || denies !== undefined || scopes !== undefined;
  const accessChanged = policyChanged || additionalRoles !== undefined;
  const selfChange = accessChanged && targetUserId === actor.userId;
  if (selfChange && policyChanged) {
    return { status: 400, body: { error: "You cannot change your own access policy" } };
  }
  // Your own additional roles may change as long as that grants nothing you
  // can't already do — an administrator can add Customer to themselves; a
  // users:manage custom role can't hand itself editor.
  if (selfChange && additionalRoles) {
    const current = await getEffectiveAccess(targetUserId, actor.siteId, actor.role, db);
    const held = new Set<string>(current.capabilities);
    if ((await capabilitiesOfRoles(additionalRoles)).some((capability) => !held.has(capability))) {
      return { status: 400, body: { error: "You cannot give yourself access you don't already have" } };
    }
  }
  if (accessChanged) {
    const available = new Set((await availableCapabilityDefinitions()).map(({ id }) => id));
    const requested = [...(grants ?? []), ...(denies ?? []), ...Object.keys(scopes ?? {})];
    if (requested.some((capability) => !available.has(capability))) {
      return { status: 400, body: { error: "Unknown or inactive capability" } };
    }
  }

  if (role && !(await isAssignableRole(role))) {
    return { status: 400, body: { error: "Unknown role" } };
  }
  if (additionalRoles) {
    const invalid = await validateAdditionalRoles(additionalRoles);
    if (invalid) return { status: 400, body: { error: invalid } };
  }

  let customRoleId: string | null = null;
  const assignable = new Set((await listAssignableRoles()).map((entry) => entry.id));
  if (roleId && !assignable.has(roleId)) {
    const found = await db.query<{ id: string }>(
      "SELECT id FROM access_roles WHERE id = ? AND site_id = ? LIMIT 1",
      [roleId, actor.siteId],
    );
    if (!found[0]) return { status: 400, body: { error: "Role not found" } };
    customRoleId = roleId;
  }

  const storedRole = role ?? (roleId && assignable.has(roleId) ? roleId : undefined);

  let targetRole: string | undefined;
  if (storedRole || accessChanged) {
    const target = (
      await db.query<{ role: string }>("SELECT role FROM users WHERE id = ? AND site_id = ? LIMIT 1", [
        targetUserId,
        actor.siteId,
      ])
    )[0];
    if (!target) return { status: 404, body: { error: "User not found" } };
    targetRole = target.role;
    if (
      storedRole &&
      target.role === "administrator" &&
      storedRole !== "administrator" &&
      (await countAdministrators(db, actor.siteId)) <= 1
    ) {
      return { status: 400, body: { error: "Cannot demote the last administrator" } };
    }
  }

  if (storedRole || accessChanged) {
    const authority = await delegationAuthority(actor, db);
    if (!authority.unrestricted) {
      // Administrators are only managed by administrators.
      if (targetRole === "administrator") {
        return { status: 403, body: { error: "Only an administrator can change another administrator" } };
      }
      const current = await getEffectiveAccess(targetUserId, actor.siteId, targetRole ?? "subscriber", db);
      if (storedRole === "administrator") return BEYOND_AUTHORITY;
      // Everything the user will hold afterwards, before denies: the primary
      // role (custom or built-in), additional roles, and direct grants.
      const keepsCustomRole = !policyChanged && current.roleId !== current.roles[0];
      const primaryCapabilities = customRoleId
        ? await customRoleCapabilities(db, actor.siteId, customRoleId)
        : keepsCustomRole
          ? await customRoleCapabilities(db, actor.siteId, current.roleId)
          : await roleCapabilitiesToDelegate(authority, storedRole ?? targetRole ?? "subscriber");
      const resulting = [
        ...primaryCapabilities,
        ...(await capabilitiesOfRoles(additionalRoles ?? current.additionalRoles)),
        ...(grants ?? (policyChanged ? current.policy.grants ?? [] : [])),
      ];
      if (exceedsAuthority(authority, resulting)) return BEYOND_AUTHORITY;
      // Changing a scope widens or narrows what a capability reaches; either
      // way it is delegation, so the actor must hold that capability unscoped.
      if (scopes !== undefined) {
        const before = (current.policy.scopes ?? {}) as Record<string, unknown>;
        const changed = new Set([...Object.keys(before), ...Object.keys(scopes)]);
        for (const capability of changed) {
          if (JSON.stringify(before[capability] ?? null) === JSON.stringify(scopes[capability] ?? null)) continue;
          if (exceedsAuthority(authority, [capability])) return BEYOND_AUTHORITY;
        }
      }
    }
  }

  const fields: string[] = [];
  const values: (string | number | boolean | null)[] = [];
  if (storedRole) {
    fields.push("role = ?");
    values.push(storedRole);
  }
  if (displayName) {
    fields.push("display_name = ?");
    values.push(displayName);
  }

  if (fields.length === 0 && !accessChanged) {
    return { status: 400, body: { error: "No fields to update" } };
  }

  if (fields.length > 0) {
    fields.push("updated_at = ?");
    values.push(now(), targetUserId, actor.siteId);
    await db.run(`UPDATE users SET ${fields.join(", ")} WHERE id = ? AND site_id = ?`, values);
  }
  // A role change can land on a role the user also held as an additional
  // one; drop it there so the same role is never listed twice.
  const primaryRole = storedRole ?? targetRole ?? "subscriber";
  if (additionalRoles !== undefined) {
    await writeAdditionalRoles(db, actor.siteId, targetUserId, [...new Set(additionalRoles)].filter((entry) => entry !== primaryRole));
  } else if (storedRole) {
    const held = await listAdditionalRoles(targetUserId, actor.siteId, db);
    if (held.includes(storedRole)) {
      await writeAdditionalRoles(db, actor.siteId, targetUserId, held.filter((entry) => entry !== storedRole));
    }
  }
  if (policyChanged) {
    const current = await getEffectiveAccess(targetUserId, actor.siteId, primaryRole, db);
    await db.transaction(async (tx) => {
      await tx.run("DELETE FROM user_access_policies WHERE user_id = ? AND site_id = ?", [
        targetUserId,
        actor.siteId,
      ]);
      await tx.run(
        `INSERT INTO user_access_policies
           (user_id, site_id, role_id, grants_json, denies_json, scopes_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          targetUserId,
          actor.siteId,
          customRoleId,
          JSON.stringify(grants ?? current.policy.grants ?? []),
          JSON.stringify(denies ?? current.policy.denies ?? []),
          JSON.stringify(scopes ?? current.policy.scopes ?? {}),
          now(),
        ],
      );
    });
  }
  if (accessChanged) {
    const current = await getEffectiveAccess(targetUserId, actor.siteId, primaryRole, db);
    // Signing everyone out after an access change also signs out the admin
    // who just saved their own roles. Capabilities resolve per request, and a
    // self-change can't add any, so there is nothing to cut off.
    if (!selfChange) await revokeUserSessions(targetUserId, actor.siteId);
    audit(
      actor,
      "user.access_changed",
      targetUserId,
      `role=${roleId ?? role ?? current.roleId}; additional=${current.additionalRoles.join(",") || "none"}`,
    );
    const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
    await getRuntimeHooks().dispatchAction(
      "user.accessChanged",
      { userId: targetUserId, roleId: roleId ?? role ?? current.roleId },
      { siteId: actor.siteId, source: "http", actor: { userId: actor.userId, role: actor.role } },
    );
  }
  if (storedRole) audit(actor, "user.role_changed", targetUserId, `role=${storedRole}`);
  await emitUserEvent("user.updated", targetUserId, actor.siteId);
  return { status: 200, body: { ok: true } };
}

/** One user with every role they hold, for `ctx.users.get()`. */
export async function getUserRoles(
  siteId: string,
  userId: string,
): Promise<{ id: string; email: string; username: string; displayName: string; role: string; roles: string[] } | null> {
  const db = await getDb();
  const row = (
    await db.query<Record<string, unknown>>(
      "SELECT id, email, username, display_name, role FROM users WHERE id = ? AND site_id = ? LIMIT 1",
      [userId, siteId],
    )
  )[0];
  if (!row) return null;
  const extra = (await listAdditionalRoles(String(row.id), siteId, db)).filter((entry) => entry !== row.role);
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    displayName: String(row.display_name),
    role: String(row.role),
    roles: [String(row.role), ...extra],
  };
}

export type AdditionalRoleTarget = { userId: string } | { email: string };

export type AddRoleResult =
  | {
      ok: true;
      user: { id: string; email: string; username: string; displayName: string; role: string; roles: string[] };
    }
  | { ok: false; status: number; error: string };

/**
 * Give an existing user one more role, keeping their primary role and sign-in.
 * Behind `ctx.users.addRole()`: Shop uses it to make an existing subscriber a
 * customer. The plugin loader has already checked the plugin owns the role.
 *
 * Sessions are not revoked: capabilities are resolved on every request, and
 * adding a role only ever adds them — signing a shopper out mid-checkout for
 * gaining the customer role would be the wrong trade.
 */
export async function addAdditionalRole(
  siteId: string,
  target: AdditionalRoleTarget,
  role: string,
  actor: Pick<UserAdminActor, "userId" | "role">,
): Promise<AddRoleResult> {
  const invalid = await validateAdditionalRoles([role]);
  if (invalid) return { ok: false, status: 400, error: invalid };
  const db = await getDb();
  const [column, value] = "userId" in target
    ? (["id", target.userId] as const)
    : (["email", target.email.toLowerCase()] as const);
  const row = (
    await db.query<Record<string, unknown>>(
      `SELECT id, email, username, display_name, role FROM users WHERE ${column} = ? AND site_id = ? LIMIT 1`,
      [value, siteId],
    )
  )[0];
  if (!row) return { ok: false, status: 404, error: "User not found" };
  const userId = String(row.id);
  const held = await listAdditionalRoles(userId, siteId, db);
  if (row.role !== role && !held.includes(role)) {
    await db.run(
      "INSERT INTO user_additional_roles (user_id, site_id, role, created_at) VALUES (?, ?, ?, ?)",
      [userId, siteId, role, now()],
    );
    held.push(role);
    audit({ siteId, ...actor }, "user.access_changed", userId, `additional+=${role}`);
    await emitUserEvent("user.updated", userId, siteId);
  }
  return {
    ok: true,
    user: {
      id: userId,
      email: String(row.email),
      username: String(row.username),
      displayName: String(row.display_name),
      role: String(row.role),
      roles: [String(row.role), ...held.filter((entry) => entry !== row.role)],
    },
  };
}

/**
 * Take back one additional role, behind `ctx.users.removeRole()`: Shop uses it
 * when a membership subscription ends. The primary role is never changed. The
 * plugin loader has already checked the plugin owns the role. Capabilities are
 * resolved on every request, so the user loses the role's access at once.
 */
export async function removeAdditionalRole(
  siteId: string,
  target: AdditionalRoleTarget,
  role: string,
  actor: Pick<UserAdminActor, "userId" | "role">,
): Promise<AddRoleResult> {
  const db = await getDb();
  const [column, value] = "userId" in target
    ? (["id", target.userId] as const)
    : (["email", target.email.toLowerCase()] as const);
  const row = (
    await db.query<Record<string, unknown>>(
      `SELECT id, email, username, display_name, role FROM users WHERE ${column} = ? AND site_id = ? LIMIT 1`,
      [value, siteId],
    )
  )[0];
  if (!row) return { ok: false, status: 404, error: "User not found" };
  const userId = String(row.id);
  const held = await listAdditionalRoles(userId, siteId, db);
  if (held.includes(role)) {
    await db.run("DELETE FROM user_additional_roles WHERE user_id = ? AND site_id = ? AND role = ?", [userId, siteId, role]);
    audit({ siteId, ...actor }, "user.access_changed", userId, `additional-=${role}`);
    await emitUserEvent("user.updated", userId, siteId);
  }
  const remaining = held.filter((entry) => entry !== role && entry !== row.role);
  return {
    ok: true,
    user: {
      id: userId,
      email: String(row.email),
      username: String(row.username),
      displayName: String(row.display_name),
      role: String(row.role),
      roles: [String(row.role), ...remaining],
    },
  };
}

export async function deleteUser(
  targetUserId: string,
  actor: UserAdminActor,
): Promise<UserAdminResult> {
  if (targetUserId === actor.userId) {
    return { status: 400, body: { error: "Cannot delete yourself" } };
  }
  const db = await getDb();
  const target = (
    await db.query<{ role: string }>("SELECT role FROM users WHERE id = ? AND site_id = ? LIMIT 1", [
      targetUserId,
      actor.siteId,
    ])
  )[0];
  if (!target) return { status: 404, body: { error: "User not found" } };
  if (target.role === "administrator" && (await countAdministrators(db, actor.siteId)) <= 1) {
    return { status: 400, body: { error: "Cannot delete the last administrator" } };
  }
  if (!(await delegationAuthority(actor, db)).unrestricted) {
    if (target.role === "administrator") {
      return { status: 403, body: { error: "Only an administrator can delete another administrator" } };
    }
  }
  await db.run("DELETE FROM users WHERE id = ? AND site_id = ?", [targetUserId, actor.siteId]);
  audit(actor, "user.deleted", targetUserId);
  await emitUserEvent("user.deleted", targetUserId, actor.siteId);
  return { status: 200, body: { ok: true } };
}
