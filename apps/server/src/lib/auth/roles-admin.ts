// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { ROLE_CAPABILITIES } from "@justflows/sdk";
import { z } from "zod";
import { getDb } from "../database/db.js";
import { availableCapabilityDefinitions, CAPABILITY_ID_PATTERN } from "./access-policy.js";
import { auditLog } from "../security/audit-log.js";

/**
 * Shared custom-role administration behind both `routes/roles.ts` (cookie auth)
 * and the federated management API. Callers do the capability check
 * (`users:read` to list, `users:manage` to write) and supply the actor.
 */

const CapabilitySchema = z.string().regex(CAPABILITY_ID_PATTERN);
export const RoleSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  capabilities: z.array(CapabilitySchema).max(250),
});
export type RoleInput = z.infer<typeof RoleSchema>;

export interface RoleAdminActor {
  siteId: string;
  userId: string;
  role: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RoleAdminResult {
  status: number;
  body: unknown;
}

async function emitRoleEvent(
  event: "access.roleCreated" | "access.roleUpdated" | "access.roleDeleted",
  roleId: string,
  siteId: string,
): Promise<void> {
  const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  await getRuntimeHooks().dispatchAction(event, { roleId }, { siteId, source: "http" });
}

function audit(
  actor: RoleAdminActor,
  action: "access.role_created" | "access.role_updated" | "access.role_deleted",
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

export async function listRoles(siteId: string): Promise<{ roles: unknown[]; capabilities: unknown[] }> {
  const db = await getDb();
  const capabilityDefinitions = await availableCapabilityDefinitions();
  const custom = await db.query<Record<string, unknown>>(
    "SELECT id, name, description, capabilities_json, created_at, updated_at FROM access_roles WHERE site_id = ? ORDER BY name",
    [siteId],
  );
  const { getPluginLoader } = await import("../plugins/plugin-runtime.js");
  const pluginRoles = (getPluginLoader()?.roleRegistry.all() ?? []).map((role) => ({
    id: role.id,
    name: role.label,
    description: role.description ?? "Registered by a plugin",
    builtIn: false,
    pluginId: role.pluginId,
    capabilities: [...role.capabilities],
  }));
  const builtIn = Object.entries(ROLE_CAPABILITIES).map(([id, capabilities]) => ({
    id,
    name: id,
    description: "Built-in role",
    builtIn: true,
    capabilities: [
      ...capabilities,
      ...capabilityDefinitions
        .filter(
          (definition) =>
            definition.pluginId && (definition.defaultRoles ?? ["administrator"]).includes(id),
        )
        .map(({ id }) => id),
    ],
  }));
  return {
    roles: [
      ...builtIn,
      ...pluginRoles,
      ...custom.map((role) => ({
        ...role,
        builtIn: false,
        capabilities: JSON.parse(String(role.capabilities_json ?? "[]")) as string[],
      })),
    ],
    capabilities: capabilityDefinitions,
  };
}

export async function createRole(input: RoleInput, actor: RoleAdminActor): Promise<RoleAdminResult> {
  const available = new Set((await availableCapabilityDefinitions()).map(({ id }) => id));
  if (input.capabilities.some((capability) => !available.has(capability))) {
    return { status: 400, body: { error: "Unknown or inactive capability" } };
  }
  const id = randomUUID();
  await (
    await getDb()
  ).run(
    "INSERT INTO access_roles (id, site_id, name, description, capabilities_json) VALUES (?, ?, ?, ?, ?)",
    [id, actor.siteId, input.name, input.description ?? null, JSON.stringify(input.capabilities)],
  );
  audit(actor, "access.role_created", id, `name=${input.name}`);
  await emitRoleEvent("access.roleCreated", id, actor.siteId);
  return { status: 201, body: { role: { id, ...input, builtIn: false } } };
}

export async function updateRole(
  id: string,
  input: RoleInput,
  actor: RoleAdminActor,
): Promise<RoleAdminResult> {
  const db = await getDb();
  const available = new Set((await availableCapabilityDefinitions()).map(({ id }) => id));
  const current = await db.query<{ capabilities_json: string }>(
    "SELECT capabilities_json FROM access_roles WHERE id = ? AND site_id = ? LIMIT 1",
    [id, actor.siteId],
  );
  const preserved = new Set<string>(JSON.parse(current[0]?.capabilities_json ?? "[]") as string[]);
  if (
    input.capabilities.some(
      (capability) => !available.has(capability) && !preserved.has(capability),
    )
  ) {
    return { status: 400, body: { error: "Unknown or inactive capability" } };
  }
  const changed = await db.execute(
    "UPDATE access_roles SET name = ?, description = ?, capabilities_json = ?, updated_at = ? WHERE id = ? AND site_id = ?",
    [
      input.name,
      input.description ?? null,
      JSON.stringify(input.capabilities),
      new Date().toISOString(),
      id,
      actor.siteId,
    ],
  );
  if (!changed) return { status: 404, body: { error: "Role not found" } };
  audit(actor, "access.role_updated", id);
  await emitRoleEvent("access.roleUpdated", id, actor.siteId);
  return { status: 200, body: { ok: true } };
}

export async function deleteRole(id: string, actor: RoleAdminActor): Promise<RoleAdminResult> {
  const db = await getDb();
  const assigned = await db.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM user_access_policies WHERE role_id = ? AND site_id = ?",
    [id, actor.siteId],
  );
  if (Number(assigned[0]?.count ?? 0) > 0) {
    return { status: 409, body: { error: "Reassign users before deleting this role" } };
  }
  const changed = await db.execute("DELETE FROM access_roles WHERE id = ? AND site_id = ?", [
    id,
    actor.siteId,
  ]);
  if (!changed) return { status: 404, body: { error: "Role not found" } };
  audit(actor, "access.role_deleted", id);
  await emitRoleEvent("access.roleDeleted", id, actor.siteId);
  return { status: 200, body: { ok: true } };
}
