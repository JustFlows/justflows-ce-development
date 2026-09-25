// SPDX-License-Identifier: MIT
import {
  ROLE_CAPABILITIES,
  USER_CAPABILITIES,
  effectiveCapabilities,
  scopeAllows,
  type AccessPolicy,
  type AccessResource,
  type UserCapability,
} from "@justflows/sdk";
import { getDb, type DbClient } from "../database/db.js";

/**
 * A capability id: `domain:action` (`content:read`) or `domain:group:action`
 * (`content:revisions:read`). Shared by the users and roles routes so both
 * accept the same set of ids the rest of the system actually issues.
 */
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9.-]{0,79}(?::[a-z][a-z0-9.-]{0,79}){1,3}$/;

export interface EffectiveAccess {
  roleId: string;
  capabilities: UserCapability[];
  policy: AccessPolicy;
}

interface PolicyRow {
  role_id: string | null;
  grants_json: string;
  denies_json: string;
  scopes_json: string;
  capabilities_json: string | null;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function validCapabilities(values: unknown, available: ReadonlySet<string>): UserCapability[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is UserCapability => typeof value === "string" && available.has(value)))];
}

export async function availableCapabilityDefinitions() {
  const core = USER_CAPABILITIES.map((id) => ({ id, pluginId: null, defaultRoles: [] as readonly string[] }));
  const { getPluginLoader } = await import("../plugins/plugin-runtime.js");
  return [...core, ...(getPluginLoader()?.capabilityRegistry.all() ?? [])];
}

export async function getEffectiveAccess(
  userId: string,
  siteId: string,
  fallbackRole: string,
  db: DbClient | undefined = undefined,
): Promise<EffectiveAccess> {
  const client = db ?? (await getDb());
  const rows = await client.query<PolicyRow>(
    `SELECT p.role_id, p.grants_json, p.denies_json, p.scopes_json, r.capabilities_json
       FROM user_access_policies p
       LEFT JOIN access_roles r ON r.id = p.role_id AND r.site_id = p.site_id
      WHERE p.user_id = ? AND p.site_id = ? LIMIT 1`,
    [userId, siteId],
  ).catch(() => []);
  const row = rows[0];
  const definitions = await availableCapabilityDefinitions();
  const available = new Set<string>(definitions.map(({ id }) => id));
  const roleId = row?.role_id ?? fallbackRole;
  const { getPluginLoader } = await import("../plugins/plugin-runtime.js");
  const pluginRole = getPluginLoader()?.roleRegistry.get(fallbackRole);
  const roleCapabilities = row?.role_id
    ? validCapabilities(parseJson(row.capabilities_json, []), available)
    : [
        ...(pluginRole ? pluginRole.capabilities : (ROLE_CAPABILITIES[fallbackRole] ?? [])),
        ...definitions.filter((definition) => definition.pluginId && (definition.defaultRoles ?? ["administrator"]).includes(fallbackRole)).map(({ id }) => id),
      ];
  // A per-user row can exist purely to carry grants/denies/scopes for a
  // built-in role (row.role_id is null) — that still gets the built-in
  // role's implicit self-ownership default. Only a *custom* role (row_id
  // set) replaces it, since custom roles define their own scopes explicitly.
  const ownershipScopes = !row?.role_id && (fallbackRole === "author" || fallbackRole === "contributor")
    ? Object.fromEntries([
        "content:update",
        "content:publish",
        "content:revisions:restore",
        "content:revisions:discard",
      ].map((capability) => [capability, { ownership: "self" }]))
    : {};
  const policy: AccessPolicy = {
    grants: validCapabilities(parseJson(row?.grants_json, []), available),
    denies: validCapabilities(parseJson(row?.denies_json, []), available),
    scopes: { ...ownershipScopes, ...parseJson(row?.scopes_json, {}) },
  };
  return { roleId, capabilities: effectiveCapabilities(roleCapabilities, policy), policy };
}

export async function userCan(
  actor: { userId: string; siteId: string; role: string },
  capability: UserCapability,
  resource: AccessResource = {},
): Promise<boolean> {
  const access = await getEffectiveAccess(actor.userId, actor.siteId, actor.role);
  return access.capabilities.includes(capability) &&
    scopeAllows(access.policy.scopes?.[capability], { siteId: actor.siteId, ...resource }, actor.userId);
}
