// SPDX-License-Identifier: MIT

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { scopeAllows, type AccessResource, type AccessScope, type UserCapability } from "@justflows/sdk";
import { getDb } from "../database/db.js";
import { getEffectiveAccess } from "./access-policy.js";

/**
 * Revocable API keys for the headless federated management API (#135).
 *
 * A key authenticates `/api/manage/v1` as `Authorization: Bearer jfk_<secret>`.
 * Only `sha256(secret)` is stored; the plaintext is returned once, at create or
 * rotate. `capabilities` is the key's explicit set — validated against the
 * creating administrator's own effective capabilities at creation time, and
 * re-intersected with the *owner's current* access on every request, so
 * revoking the owner's role or policy access immediately neuters the key.
 * `scope` is an AccessScope applied on top of every capability.
 */

export const API_KEY_TOKEN_PREFIX = "jfk_";
const KEY_HASH_ALGO = "sha256";

export interface ApiKeyRecord {
  id: string;
  siteId: string;
  name: string;
  keyPrefix: string;
  ownerUserId: string;
  createdBy: string;
  capabilities: UserCapability[];
  scope: AccessScope;
  allowedIps: string[];
  allowedOrigins: string[];
  rateLimitPerMin: number | null;
  /** Whether MCP may list the tools that change users & roles for this key (off by default). */
  mcpUserTools: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  requestCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyOwner {
  userId: string;
  siteId: string;
  role: string;
}

export type ApiKeyRejection = "revoked" | "expired";

export interface VerifiedApiKey {
  record: ApiKeyRecord;
  owner: ApiKeyOwner;
  /** null when the key is currently usable; otherwise why it is not. */
  rejection: ApiKeyRejection | null;
}

/** Thrown for caller mistakes (bad capability set, unknown key). Mapped to 400. */
export class ApiKeyError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiKeyError";
    this.status = status;
  }
}

function sqlTime(value: Date = new Date()): string {
  return value.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const asDate = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(asDate.getTime()) ? String(value) : asDate.toISOString();
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseScope(value: unknown): AccessScope {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as AccessScope;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function hashApiKey(secret: string): string {
  return createHash(KEY_HASH_ALGO).update(secret, "utf8").digest("hex");
}

/** CSPRNG token with a visible, non-secret prefix kept for lists and logs. */
export function generateApiKeySecret(): { secret: string; keyPrefix: string; keyHash: string } {
  const raw = randomBytes(32).toString("base64url");
  const secret = `${API_KEY_TOKEN_PREFIX}${raw}`;
  return {
    secret,
    keyPrefix: `${API_KEY_TOKEN_PREFIX}${raw.slice(0, 8)}`,
    keyHash: hashApiKey(secret),
  };
}

function rowToRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    name: String(row.name),
    keyPrefix: String(row.key_prefix),
    ownerUserId: String(row.owner_user_id),
    createdBy: String(row.created_by),
    capabilities: parseJsonArray(row.capabilities_json) as UserCapability[],
    scope: parseScope(row.scopes_json),
    allowedIps: parseJsonArray(row.allowed_ips_json),
    allowedOrigins: parseJsonArray(row.allowed_origins_json),
    rateLimitPerMin: row.rate_limit_per_min == null ? null : Number(row.rate_limit_per_min),
    mcpUserTools: row.mcp_user_tools === true || Number(row.mcp_user_tools) === 1,
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    lastUsedAt: toIso(row.last_used_at),
    lastUsedIp: row.last_used_ip == null ? null : String(row.last_used_ip),
    requestCount: Number(row.request_count ?? 0),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

const SELECT_COLUMNS =
  "id, site_id, name, key_prefix, owner_user_id, created_by, capabilities_json, scopes_json, allowed_ips_json, allowed_origins_json, rate_limit_per_min, mcp_user_tools, expires_at, revoked_at, last_used_at, last_used_ip, request_count, created_at, updated_at";

export async function listApiKeys(siteId: string): Promise<ApiKeyRecord[]> {
  const rows = await (
    await getDb()
  ).query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE site_id = ? ORDER BY created_at DESC`,
    [siteId],
  );
  return rows.map(rowToRecord);
}

export async function getApiKey(siteId: string, id: string): Promise<ApiKeyRecord | null> {
  const rows = await (
    await getDb()
  ).query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE id = ? AND site_id = ?`,
    [id, siteId],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** The capabilities an actor may grant to a key: their own effective set. */
export async function creatorCapabilityCeiling(actor: ApiKeyOwner): Promise<UserCapability[]> {
  const access = await getEffectiveAccess(actor.userId, actor.siteId, actor.role);
  return [...access.capabilities];
}

/**
 * A key is wider than the actor when its scope allows a site, type, locale,
 * or owner the actor's own scope for that capability does not.
 */
function scopeFits(keyScope: AccessScope, actorScope: AccessScope | undefined): boolean {
  if (!actorScope) return true;
  if (actorScope.ownership === "self" && keyScope.ownership !== "self") return false;
  if (actorScope.siteIds?.length) {
    if (!keyScope.siteIds?.length || keyScope.siteIds.some((id) => !actorScope.siteIds!.includes(id))) return false;
  }
  if (actorScope.contentTypes?.length) {
    if (!keyScope.contentTypes?.length || keyScope.contentTypes.some((id) => !actorScope.contentTypes!.includes(id))) {
      return false;
    }
  }
  if (actorScope.locales?.length) {
    if (!keyScope.locales?.length || keyScope.locales.some((id) => !actorScope.locales!.includes(id))) return false;
  }
  return true;
}

/**
 * Reject a key the actor could not create themselves. A 403 names no
 * capability, so a weaker caller does not learn what the key can do.
 */
function assertKeyWithinActor(
  capabilities: readonly UserCapability[],
  keyScope: AccessScope,
  access: { capabilities: readonly UserCapability[]; policy: { scopes?: Partial<Record<UserCapability, AccessScope>> } },
  status = 400,
): void {
  const allowed = new Set(access.capabilities);
  const over = capabilities.filter((capability) => !allowed.has(capability));
  if (over.length > 0) {
    throw new ApiKeyError(
      status === 403
        ? "You cannot change a key that can do more than you can."
        : `A key cannot be granted capabilities its creator lacks: ${over.join(", ")}`,
      status,
    );
  }
  for (const capability of capabilities) {
    if (!scopeFits(keyScope, access.policy.scopes?.[capability])) {
      throw new ApiKeyError(
        status === 403
          ? "You cannot change a key that can do more than you can."
          : "A key cannot be wider than your own access.",
        status,
      );
    }
  }
}

function sanitizeStringList(values: unknown, max: number): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, max);
}

function normalizeScope(scope: AccessScope | undefined): AccessScope {
  if (!scope || typeof scope !== "object") return {};
  const next: {
    siteIds?: string[];
    contentTypes?: string[];
    locales?: string[];
    ownership?: "any" | "self";
  } = {};
  if (Array.isArray(scope.siteIds) && scope.siteIds.length) next.siteIds = sanitizeStringList(scope.siteIds, 20);
  if (Array.isArray(scope.contentTypes) && scope.contentTypes.length)
    next.contentTypes = sanitizeStringList(scope.contentTypes, 50);
  if (Array.isArray(scope.locales) && scope.locales.length) next.locales = sanitizeStringList(scope.locales, 50);
  if (scope.ownership === "self" || scope.ownership === "any") next.ownership = scope.ownership;
  return next;
}

export interface CreateApiKeyInput {
  siteId: string;
  name: string;
  owner: ApiKeyOwner;
  capabilities: UserCapability[];
  scope?: AccessScope;
  allowedIps?: string[];
  allowedOrigins?: string[];
  rateLimitPerMin?: number | null;
  mcpUserTools?: boolean;
  expiresAt?: string | null;
}

export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<{ record: ApiKeyRecord; secret: string }> {
  const capabilities = [...new Set(input.capabilities)];
  const scope = normalizeScope(input.scope);
  assertKeyWithinActor(capabilities, scope, await getEffectiveAccess(input.owner.userId, input.owner.siteId, input.owner.role));

  const { secret, keyPrefix, keyHash } = generateApiKeySecret();
  const id = randomUUID();
  const now = sqlTime();
  const expiresAt = input.expiresAt ? sqlTime(new Date(input.expiresAt)) : null;

  await (
    await getDb()
  ).run(
    `INSERT INTO api_keys
       (id, site_id, name, key_prefix, key_hash, owner_user_id, created_by,
        capabilities_json, scopes_json, allowed_ips_json, allowed_origins_json,
        rate_limit_per_min, mcp_user_tools, expires_at, revoked_at, last_used_at, last_used_ip,
        request_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
    [
      id,
      input.siteId,
      input.name.trim(),
      keyPrefix,
      keyHash,
      input.owner.userId,
      input.owner.userId,
      JSON.stringify(capabilities),
      JSON.stringify(scope),
      JSON.stringify(sanitizeStringList(input.allowedIps, 50)),
      JSON.stringify(sanitizeStringList(input.allowedOrigins, 50)),
      input.rateLimitPerMin ?? null,
      input.mcpUserTools === true,
      expiresAt,
      now,
      now,
    ],
  );

  const record = await getApiKey(input.siteId, id);
  if (!record) throw new ApiKeyError("Key could not be created");
  return { record, secret };
}

export interface UpdateApiKeyInput {
  name?: string;
  capabilities?: UserCapability[];
  scope?: AccessScope;
  allowedIps?: string[];
  allowedOrigins?: string[];
  rateLimitPerMin?: number | null;
  mcpUserTools?: boolean;
  expiresAt?: string | null;
}

export async function updateApiKey(
  siteId: string,
  id: string,
  patch: UpdateApiKeyInput,
  editor: ApiKeyOwner,
): Promise<ApiKeyRecord | null> {
  const existing = await getApiKey(siteId, id);
  if (!existing) return null;

  const access = await getEffectiveAccess(editor.userId, editor.siteId, editor.role);
  assertKeyWithinActor(existing.capabilities, existing.scope, access, 403);

  const sets: string[] = [];
  const params: (string | number | boolean | null)[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name.trim());
  }
  if (patch.capabilities !== undefined) {
    const capabilities = [...new Set(patch.capabilities)];
    sets.push("capabilities_json = ?");
    params.push(JSON.stringify(capabilities));
  }
  if (patch.scope !== undefined) {
    sets.push("scopes_json = ?");
    params.push(JSON.stringify(normalizeScope(patch.scope)));
  }
  if (patch.allowedIps !== undefined) {
    sets.push("allowed_ips_json = ?");
    params.push(JSON.stringify(sanitizeStringList(patch.allowedIps, 50)));
  }
  if (patch.allowedOrigins !== undefined) {
    sets.push("allowed_origins_json = ?");
    params.push(JSON.stringify(sanitizeStringList(patch.allowedOrigins, 50)));
  }
  if (patch.rateLimitPerMin !== undefined) {
    sets.push("rate_limit_per_min = ?");
    params.push(patch.rateLimitPerMin ?? null);
  }
  if (patch.mcpUserTools !== undefined) {
    sets.push("mcp_user_tools = ?");
    params.push(patch.mcpUserTools === true);
  }
  if (patch.expiresAt !== undefined) {
    sets.push("expires_at = ?");
    params.push(patch.expiresAt ? sqlTime(new Date(patch.expiresAt)) : null);
  }

  if (sets.length === 0) return existing;

  const nextCapabilities = patch.capabilities !== undefined ? [...new Set(patch.capabilities)] : existing.capabilities;
  const nextScope = patch.scope !== undefined ? normalizeScope(patch.scope) : existing.scope;
  if (patch.capabilities !== undefined || patch.scope !== undefined) {
    assertKeyWithinActor(nextCapabilities, nextScope, access);
  }

  sets.push("updated_at = ?");
  params.push(sqlTime());
  params.push(id, siteId);

  await (await getDb()).run(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ? AND site_id = ?`, params);
  return getApiKey(siteId, id);
}

export async function rotateApiKey(
  siteId: string,
  id: string,
  actor: ApiKeyOwner,
): Promise<{ record: ApiKeyRecord; secret: string } | null> {
  const existing = await getApiKey(siteId, id);
  if (!existing) return null;
  assertKeyWithinActor(
    existing.capabilities,
    existing.scope,
    await getEffectiveAccess(actor.userId, actor.siteId, actor.role),
    403,
  );
  const { secret, keyPrefix, keyHash } = generateApiKeySecret();
  await (
    await getDb()
  ).run(
    "UPDATE api_keys SET key_prefix = ?, key_hash = ?, updated_at = ? WHERE id = ? AND site_id = ?",
    [keyPrefix, keyHash, sqlTime(), id, siteId],
  );
  const record = await getApiKey(siteId, id);
  return record ? { record, secret } : null;
}

export async function revokeApiKey(siteId: string, id: string, actor: ApiKeyOwner): Promise<boolean> {
  const existing = await getApiKey(siteId, id);
  if (!existing) return false;
  assertKeyWithinActor(
    existing.capabilities,
    existing.scope,
    await getEffectiveAccess(actor.userId, actor.siteId, actor.role),
    403,
  );
  if (existing.revokedAt) return true;
  await (
    await getDb()
  ).run("UPDATE api_keys SET revoked_at = ?, updated_at = ? WHERE id = ? AND site_id = ?", [
    sqlTime(),
    sqlTime(),
    id,
    siteId,
  ]);
  return true;
}

export async function deleteApiKey(siteId: string, id: string, actor: ApiKeyOwner): Promise<boolean> {
  const existing = await getApiKey(siteId, id);
  if (!existing) return false;
  assertKeyWithinActor(
    existing.capabilities,
    existing.scope,
    await getEffectiveAccess(actor.userId, actor.siteId, actor.role),
    403,
  );
  const db = await getDb();
  // Detach any webhook endpoints the key registered so they are not orphaned by
  // the delete; an administrator can adopt or remove them afterwards.
  await db
    .run("UPDATE webhook_endpoints SET api_key_id = NULL WHERE api_key_id = ?", [id])
    .catch(() => undefined);
  await db.run("DELETE FROM api_keys WHERE id = ? AND site_id = ?", [id, siteId]);
  return true;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolve a presented bearer secret to its key and owner.
 *
 * Returns null when nothing matches (no such key). A matched-but-unusable key
 * (revoked or expired) is still returned, with `rejection` set, so the caller
 * can audit the attempt against the key id without leaking that distinction to
 * the client.
 */
export async function verifyApiKey(secret: string): Promise<VerifiedApiKey | null> {
  if (typeof secret !== "string" || !secret.startsWith(API_KEY_TOKEN_PREFIX)) return null;
  const hash = hashApiKey(secret);
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}, key_hash FROM api_keys WHERE key_hash = ? LIMIT 1`,
    [hash],
  );
  const row = rows[0];
  if (!row || !constantTimeEqualHex(String(row.key_hash), hash)) return null;

  const record = rowToRecord(row);
  const users = await db.query<{ role: string }>(
    "SELECT role FROM users WHERE id = ? AND site_id = ? LIMIT 1",
    [record.ownerUserId, record.siteId],
  );
  const role = users[0]?.role;
  if (!role) return null; // Owner account is gone — treat as no such key.

  let rejection: ApiKeyRejection | null = null;
  if (record.revokedAt) rejection = "revoked";
  else if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) rejection = "expired";

  return { record, owner: { userId: record.ownerUserId, siteId: record.siteId, role }, rejection };
}

export async function recordApiKeyUse(id: string, ip: string | null): Promise<void> {
  try {
    await (
      await getDb()
    ).run(
      "UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, request_count = request_count + 1 WHERE id = ?",
      [sqlTime(), ip ? ip.slice(0, 64) : null, id],
    );
  } catch {
    // Usage metering must never fail the request it describes.
  }
}

/** Capabilities registered by active plugins, as opposed to core ones. */
export async function pluginCapabilityIds(): Promise<Set<string>> {
  const { availableCapabilityDefinitions } = await import("./access-policy.js");
  return new Set((await availableCapabilityDefinitions()).filter((definition) => definition.pluginId).map(({ id }) => id));
}

/**
 * Whether the key itself carries `capability`, before the owner's access.
 *
 * A key holds what was ticked on it. A key with `site:admin` also holds every
 * capability a plugin registers, including plugins installed after the key
 * was made: such a key stands for a full administrator, and plugin
 * capabilities could not be ticked on it when it was created. Core
 * capabilities are never widened this way.
 */
/**
 * Keys made before the design capabilities existed (justflows-ce#314) used
 * `content:read` to read site design and `settings:manage` to change it. Such
 * a key keeps that access; the owner must still hold the design capability.
 */
const LEGACY_KEY_CAPABILITY: Readonly<Record<string, UserCapability>> = {
  "design:read": "content:read",
  "design:manage": "settings:manage",
};

export function keyHolds(key: Pick<ApiKeyRecord, "capabilities">, capability: string, pluginCapabilities: ReadonlySet<string>): boolean {
  if (key.capabilities.includes(capability as UserCapability)) return true;
  const legacy = LEGACY_KEY_CAPABILITY[capability];
  if (legacy && key.capabilities.includes(legacy)) return true;
  return key.capabilities.includes("site:admin" as UserCapability) && pluginCapabilities.has(capability);
}

/**
 * Whether a key may exercise `capability` on `resource` *right now*.
 *
 * The key's own capability set (see `keyHolds`) is intersected with the
 * owner's current effective capabilities, then both the key's scope and the
 * owner's per-capability scope must allow the resource.
 */
export async function keyCan(
  key: ApiKeyRecord,
  owner: ApiKeyOwner,
  capability: UserCapability,
  resource: AccessResource = {},
): Promise<boolean> {
  if (!keyHolds(key, capability, key.capabilities.includes(capability) ? new Set() : await pluginCapabilityIds())) return false;
  const ownerAccess = await getEffectiveAccess(owner.userId, owner.siteId, owner.role);
  if (!ownerAccess.capabilities.includes(capability)) return false;
  const target: AccessResource = { siteId: owner.siteId, ...resource };
  if (!scopeAllows(key.scope, target, owner.userId)) return false;
  if (!scopeAllows(ownerAccess.policy.scopes?.[capability], target, owner.userId)) return false;
  return true;
}
