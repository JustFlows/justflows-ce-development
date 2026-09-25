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
  availableCapabilityDefinitions,
  CAPABILITY_ID_PATTERN,
  getEffectiveAccess,
} from "./access-policy.js";

/**
 * Shared user administration behind both `routes/users.ts` (cookie auth) and
 * the federated management API. Covers the CRUD subset the management API
 * federates — list, read, create, update (role / access policy / display
 * name), delete — with the last-administrator floor and audit-logging intact.
 * Invitations, password resets and GDPR export/erase stay route-only.
 */

export interface UserAdminActor {
  siteId: string;
  userId: string;
  role: string;
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
    actorId: actor.userId,
    actorRole: actor.role,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    target,
    detail: detail ?? null,
  });
}

export async function listUsers(siteId: string): Promise<Record<string, unknown>[]> {
  return (await getDb()).query<Record<string, unknown>>(
    "SELECT id, email, username, display_name, role, created_at FROM users WHERE site_id = ? ORDER BY created_at ASC",
    [siteId],
  );
}

export async function getUserWithAccess(siteId: string, userId: string): Promise<UserAdminResult> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT id, email, username, display_name, role, created_at FROM users WHERE id = ? AND site_id = ? LIMIT 1",
    [userId, siteId],
  );
  if (!rows[0]) return { status: 404, body: { error: "User not found" } };
  const user = rows[0] as Record<string, unknown> & { id: string; role: string };
  const access = await getEffectiveAccess(user.id, siteId, user.role, db);
  return {
    status: 200,
    body: {
      user: {
        ...user,
        roleId: access.roleId,
        accessPolicy: access.policy,
        effectiveCapabilities: access.capabilities,
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
});
export type PatchUserInput = z.infer<typeof PatchUserSchema>;

export async function updateUser(
  targetUserId: string,
  patch: PatchUserInput,
  actor: UserAdminActor,
): Promise<UserAdminResult> {
  const { role, roleId, grants, denies, scopes, displayName } = patch;
  const db = await getDb();

  const accessChanged =
    roleId !== undefined || grants !== undefined || denies !== undefined || scopes !== undefined;
  if (accessChanged && targetUserId === actor.userId) {
    return { status: 400, body: { error: "You cannot change your own access policy" } };
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
  if (accessChanged) {
    const current = await getEffectiveAccess(
      targetUserId,
      actor.siteId,
      storedRole ?? targetRole ?? "subscriber",
      db,
    );
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
    await revokeUserSessions(targetUserId, actor.siteId);
    audit(actor, "user.access_changed", targetUserId, `role=${roleId ?? role ?? current.roleId}`);
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
  await db.run("DELETE FROM users WHERE id = ? AND site_id = ?", [targetUserId, actor.siteId]);
  audit(actor, "user.deleted", targetUserId);
  await emitUserEvent("user.deleted", targetUserId, actor.siteId);
  return { status: 200, body: { ok: true } };
}
