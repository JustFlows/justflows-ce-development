// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { QuotaDecision, QuotaMeterRegistration, QuotaMeterView, QuotaScope, QuotaUnit, Unsubscribe } from "@justflows/sdk";
import { getControlDb, getDb, runWithDatabase, type DbClient } from "../database/db.js";
import { effectiveDatabaseMode } from "./choice.js";
import { borrowSeparateDatabase, separateDatabaseForSite } from "./connections.js";
import { getTenantContext, type DatabaseChoice, type DatabaseMode } from "./context.js";

const METER_KEY = /^[a-z][a-zA-Z0-9.-]{0,118}$/;
const SCOPE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QuotaMeterDefinition {
  key: string;
  scope: QuotaScope;
  label: string;
  unit: QuotaUnit;
  owner: string;
  count?: (scopeId: string) => Promise<number>;
}

export interface QuotaBlock {
  status: 403 | 409 | 503;
  error: string;
  code: "quota_exceeded" | "quota_unavailable" | "feature_disabled";
  meter: string;
}

const meters = new Map<string, QuotaMeterDefinition>();

function defineCore(key: string, scope: QuotaScope, label: string, unit: QuotaUnit): void {
  meters.set(key, { key, scope, label, unit, owner: "core" });
}

defineCore("sites", "workspace", "Sites", "count");
defineCore("users", "site", "Users", "count");
defineCore("content", "site", "Content entries", "count");
defineCore("content.types", "site", "Custom content types", "count");
defineCore("content.post", "site", "Posts", "count");
defineCore("content.page", "site", "Pages", "count");
defineCore("media.files", "site", "Media files", "count");
defineCore("storage.bytes", "site", "Total storage", "bytes");
defineCore("media.bytes", "site", "Media library", "bytes");
defineCore("files.count", "site", "Private files", "count");
defineCore("files.bytes", "site", "Private file storage", "bytes");
defineCore("plugins", "site", "Installed plugins", "count");
defineCore("roles", "site", "Custom user roles", "count");
defineCore("feature.comments", "site", "Comments", "flag");
defineCore("feature.themeUpload", "site", "Theme upload", "flag");
defineCore("feature.design", "site", "Design", "flag");
defineCore("feature.roles", "site", "Create user roles", "flag");
defineCore("feature.responsiveImages", "site", "Responsive images", "flag");
defineCore("feature.securityAdvanced", "site", "Advanced security", "flag");
defineCore("feature.securityHeaders", "site", "Security headers", "flag");
defineCore("feature.securityAdminPath", "site", "Admin address", "flag");
defineCore("feature.securityAudit", "site", "Audit log", "flag");
defineCore("feature.pwa", "site", "PWA", "flag");
defineCore("feature.redirects", "site", "Redirects", "flag");
defineCore("feature.permalinks", "site", "Permalinks", "flag");
defineCore("feature.placeholders", "site", "Placeholders", "flag");
defineCore("feature.emails", "site", "Emails", "flag");
defineCore("feature.languages", "site", "Languages", "flag");
defineCore("feature.webhooks", "site", "Webhooks", "flag");
defineCore("feature.api", "site", "API keys", "flag");
defineCore("feature.ai", "site", "AI", "flag");
defineCore("feature.cdn", "site", "CDN", "flag");
defineCore("feature.trash", "site", "Trash", "flag");
defineCore("feature.tools", "site", "Tools", "flag");
defineCore("feature.plugins", "site", "Plugins", "flag");
defineCore("feature.customDomains", "site", "Custom domains", "flag");
defineCore("feature.managedDns", "site", "DNS hosting", "flag");
defineCore("domains.custom", "site", "Connected domains", "count");
defineCore("feature.ownStorage", "site", "Own file storage", "flag");

export function listMeterDefinitions(scope?: QuotaScope): QuotaMeterDefinition[] {
  return [...meters.values()].filter((meter) => scope === undefined || meter.scope === scope);
}

export function registerPluginMeter(pluginId: string, registration: QuotaMeterRegistration): Unsubscribe {
  const key = registration.key.trim();
  if (!key.startsWith(`${pluginId}.`)) {
    throw new Error(`Plugin "${pluginId}" can only register quota meters under "${pluginId}."`);
  }
  if (!METER_KEY.test(key)) throw new Error(`Quota meter "${key}" is not a valid key.`);
  if (registration.scope !== "workspace" && registration.scope !== "site") {
    throw new Error(`Quota meter "${key}" needs a workspace or site scope.`);
  }
  if (registration.unit !== "count" && registration.unit !== "bytes" && registration.unit !== "flag") {
    throw new Error(`Quota meter "${key}" needs a count, bytes, or flag unit.`);
  }
  const label = registration.label.trim();
  if (!label || label.length > 80) throw new Error(`Quota meter "${key}" needs a short label.`);
  const existing = meters.get(key);
  if (existing && existing.owner !== pluginId) {
    throw new Error(`Quota meter "${key}" is already registered.`);
  }
  meters.set(key, {
    key,
    scope: registration.scope,
    label,
    unit: registration.unit,
    owner: pluginId,
    count: registration.count,
  });
  return () => {
    const current = meters.get(key);
    if (current?.owner === pluginId) meters.delete(key);
  };
}

export function unregisterPluginMeters(pluginId: string): void {
  for (const [key, meter] of meters) {
    if (meter.owner === pluginId) meters.delete(key);
  }
}

/** Keep a filter from raising the stored ceiling. A non-number leaves the stored value. */
export function clampQuotaLimit(stored: number | null, proposed: unknown): number | null {
  if (typeof proposed !== "number" || !Number.isSafeInteger(proposed) || proposed < 0) return stored;
  if (stored === null) return proposed;
  return Math.min(stored, proposed);
}

export function quotaDecision(used: number, delta: number, limit: number | null): QuotaDecision {
  if (limit === null) return { ok: true, limit: null, used, remaining: null };
  const remaining = Math.max(0, limit - used);
  return { ok: used + delta <= limit, limit, used, remaining };
}

function assertDelta(delta: number): number {
  if (!Number.isSafeInteger(delta) || delta < 0) throw new Error("Quota delta must be a whole number.");
  return delta;
}

function assertLimit(limit: number | null): number | null {
  if (limit === null) return null;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("A quota limit must be a whole number, or empty for no limit.");
  return limit;
}

function isMissingRelation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /quota_limits/i.test(message) && /does not exist|doesn't exist|no such table|ER_NO_SUCH_TABLE/i.test(message);
}

async function storedLimits(scope: QuotaScope, scopeId: string): Promise<Map<string, number>> {
  const db = await getControlDb();
  try {
    const rows = await db.query<{ meter_key: string; limit_value: string | number }>(
      "SELECT meter_key, limit_value FROM quota_limits WHERE scope = ? AND scope_id = ?",
      [scope, scopeId],
    );
    const limits = new Map<string, number>();
    for (const row of rows) {
      const value = Number(row.limit_value);
      if (Number.isSafeInteger(value) && value >= 0) limits.set(String(row.meter_key), value);
    }
    return limits;
  } catch (err) {
    if (isMissingRelation(err)) return new Map();
    throw err;
  }
}

async function effectiveLimit(meter: QuotaMeterDefinition, scopeId: string, stored: number | null): Promise<number | null> {
  try {
    const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
    const proposed = await getRuntimeHooks().applyFilter(
      "quota.effectiveLimit",
      stored,
      { key: meter.key, scope: meter.scope, scopeId, storedLimit: stored },
      { siteId: meter.scope === "site" ? scopeId : undefined, source: "system" },
    );
    return clampQuotaLimit(stored, proposed);
  } catch {
    return stored;
  }
}

async function emitUpdated(scope: QuotaScope, scopeId: string, limits: Record<string, number | null>): Promise<void> {
  try {
    const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
    await getRuntimeHooks().dispatchAction(
      "quota.updated",
      { scope, scopeId, limits },
      { siteId: scope === "site" ? scopeId : undefined, source: "system" },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    console.error("[justflows] quota.updated failed:", JSON.stringify(message.replace(/[\r\n]/g, " ")));
  }
}

function asChoice(value: string): DatabaseChoice {
  return value === "current" || value === "separate" ? value : "inherit";
}

function asMode(value: string): DatabaseMode {
  return value === "separate" ? "separate" : "current";
}

async function querySite<T>(siteId: string, sql: string, params: Array<string | number | boolean | null>): Promise<T[] | null> {
  const control = await getControlDb();
  const rows = await control.query<{ tenant_id: string; database_choice: string; database_mode: string }>(
    `SELECT s.tenant_id, s.database_choice, t.database_mode
     FROM sites s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.id = ? LIMIT 1`,
    [siteId],
  );
  const row = rows[0];
  if (!row) return null;
  const choice = asChoice(String(row.database_choice));
  const mode = asMode(String(row.database_mode));
  if (effectiveDatabaseMode(mode, choice) === "separate") {
    const separate = await separateDatabaseForSite(String(row.tenant_id), siteId, choice, mode);
    if (!separate) return null;
    let client: DbClient | null = null;
    try {
      client = await borrowSeparateDatabase(separate);
    } catch {
      client = null;
    }
    if (!client) return null;
    return runWithDatabase(client, async () => (await getDb()).query<T>(sql, params));
  }
  return control.query<T>(sql, params);
}

async function querySiteNumber(siteId: string, sql: string, params: Array<string | number | boolean | null>): Promise<number | null> {
  try {
    const rows = await querySite<{ total: string | number | null }>(siteId, sql, params);
    if (!rows) return null;
    const value = Number(rows[0]?.total ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return null;
  }
}

async function countSites(tenantId: string): Promise<number | null> {
  try {
    const db = await getControlDb();
    const rows = await db.query<{ total: string | number | null }>(
      "SELECT COUNT(*) AS total FROM sites WHERE tenant_id = ? AND status <> 'deleted'",
      [tenantId],
    );
    const value = Number(rows[0]?.total ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return null;
  }
}

async function countUsers(siteId: string): Promise<number | null> {
  try {
    const control = await getControlDb();
    const modes = await control.query<{ user_mode: string }>(
      `SELECT t.user_mode FROM sites s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ? LIMIT 1`,
      [siteId],
    );
    if (modes[0]?.user_mode === "shared") {
      return querySiteNumber(
        siteId,
        `SELECT COUNT(*) AS total FROM (
           SELECT u.id AS id FROM users u WHERE u.site_id = ?
           UNION
           SELECT m.user_id AS id FROM site_memberships m WHERE m.site_id = ?
         ) AS accounts`,
        [siteId, siteId],
      );
    }
  } catch {
    return null;
  }
  return querySiteNumber(siteId, "SELECT COUNT(*) AS total FROM users WHERE site_id = ?", [siteId]);
}

async function usageFor(meter: QuotaMeterDefinition, scopeId: string): Promise<number | null> {
  if (meter.count) {
    try {
      const value = await meter.count(scopeId);
      if (!Number.isFinite(value) || value < 0) return null;
      return Math.floor(value);
    } catch {
      return null;
    }
  }
  if (meter.key === "sites") return countSites(scopeId);
  if (meter.key === "users") return countUsers(scopeId);
  if (meter.key === "content") {
    return querySiteNumber(scopeId, "SELECT COUNT(*) AS total FROM content WHERE site_id = ?", [scopeId]);
  }
  if (meter.key === "content.types") return countCustomContentTypes(scopeId);
  if (meter.key.startsWith("content.")) {
    const slug = meter.key.slice("content.".length);
    return querySiteNumber(scopeId, "SELECT COUNT(*) AS total FROM content WHERE site_id = ? AND type = ?", [scopeId, slug]);
  }
  if (meter.key === "media.files") {
    return querySiteNumber(scopeId, "SELECT COUNT(*) AS total FROM media WHERE site_id = ?", [scopeId]);
  }
  if (meter.key === "storage.bytes") {
    try { return (await (await import("../storage/storage-usage.js")).getSiteStorageUsage(scopeId)).totalBytes; }
    catch { return null; }
  }
  if (meter.key === "media.bytes") {
    return querySiteNumber(scopeId, "SELECT COALESCE(SUM(size_bytes + derivative_bytes), 0) AS total FROM media WHERE site_id = ?", [scopeId]);
  }
  if (meter.key === "files.count") {
    return querySiteNumber(scopeId, "SELECT COUNT(*) AS total FROM private_files WHERE site_id = ?", [scopeId]);
  }
  if (meter.key === "files.bytes") {
    return querySiteNumber(scopeId, "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM private_files WHERE site_id = ?", [scopeId]);
  }
  if (meter.key === "plugins") {
    return querySiteNumber(scopeId, "SELECT COUNT(*) AS total FROM plugins WHERE site_id = ?", [scopeId]);
  }
  if (meter.key === "roles") {
    return querySiteNumber(scopeId, "SELECT COUNT(*) AS total FROM access_roles WHERE site_id = ?", [scopeId]);
  }
  if (meter.key === "domains.custom") return countCustomDomains(scopeId);
  return null;
}

/** Domains live on the platform database. A `www.` row added with its parent does not count. */
async function countCustomDomains(siteId: string): Promise<number | null> {
  try {
    const db = await getControlDb();
    const rows = await db.query<{ total: string | number | null }>(
      "SELECT COUNT(*) AS total FROM site_domains WHERE site_id = ? AND kind = 'custom' AND parent_id IS NULL",
      [siteId],
    );
    const value = Number(rows[0]?.total ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return null;
  }
}

async function countCustomContentTypes(siteId: string): Promise<number | null> {
  try {
    const rows = await querySite<{ is_builtin: boolean | number | string }>(
      siteId,
      "SELECT is_builtin FROM content_types WHERE site_id = ?",
      [siteId],
    );
    if (!rows) return null;
    return rows.filter((row) => !isBuiltinFlag(row.is_builtin)).length;
  } catch {
    return null;
  }
}

function isBuiltinFlag(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

const CONTENT_TYPE_METER = /^content\.[a-z][a-z0-9-]{0,59}$/;

function meterByKey(key: string): QuotaMeterDefinition | undefined {
  const existing = meters.get(key);
  if (existing) return existing;
  if (!CONTENT_TYPE_METER.test(key) || key === "content.types") return undefined;
  return { key, scope: "site", label: key.slice("content.".length), unit: "count", owner: "core" };
}

export async function scopeIdForMeter(meter: QuotaMeterDefinition, fallbackSiteId: string): Promise<string> {
  const current = getTenantContext();
  if (meter.scope === "site") {
    const siteId = current?.siteId || fallbackSiteId;
    if (!siteId) throw new Error("Quota check has no site.");
    return siteId;
  }
  if (current?.tenantId) return current.tenantId;
  const siteId = current?.siteId || fallbackSiteId;
  if (!siteId) throw new Error("Quota check has no workspace.");
  const db = await getControlDb();
  const rows = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM sites WHERE id = ? LIMIT 1", [siteId]);
  if (!rows[0]) throw new Error("Quota check has no workspace.");
  return String(rows[0].tenant_id);
}

async function resolveLimit(meter: QuotaMeterDefinition, scopeId: string): Promise<number | null> {
  const stored = (await storedLimits(meter.scope, scopeId)).get(meter.key) ?? null;
  return effectiveLimit(meter, scopeId, stored);
}

export class QuotaRefusalError extends Error {
  readonly status: number;
  readonly code: QuotaBlock["code"];
  readonly meter: string;

  constructor(block: QuotaBlock) {
    super(block.error);
    this.name = "QuotaRefusalError";
    this.status = block.status;
    this.code = block.code;
    this.meter = block.meter;
  }
}

export class QuotaUsageError extends Error {
  readonly code = "quota_unavailable" as const;
  readonly meter: string;

  constructor(meter: string) {
    super("Usage for this limit could not be read.");
    this.name = "QuotaUsageError";
    this.meter = meter;
  }
}

export async function checkQuota(
  key: string,
  scopeId: string,
  input: { delta?: number; used?: number } = {},
): Promise<QuotaDecision> {
  const meter = meterByKey(key);
  if (!meter) throw new Error(`Unknown quota meter "${key}".`);
  const delta = assertDelta(input.delta ?? 1);
  const limit = await resolveLimit(meter, scopeId);
  if (key === "storage.bytes" && limit === null) return { ok: true, limit: null, used: 0, remaining: null };
  if (meter.unit === "flag") {
    const off = limit === 0;
    return { ok: !off, limit, used: 0, remaining: off ? 0 : null };
  }
  let used: number | null;
  if (meter.owner === "core" || (input.used === undefined && meter.count)) {
    const counted = await usageFor(meter, scopeId);
    used = limit === null ? (counted ?? 0) : counted;
  } else if (input.used === undefined) {
    throw new Error(`Quota check for "${key}" needs the current usage.`);
  } else if (!Number.isSafeInteger(input.used) || input.used < 0) {
    throw new Error(`Quota check for "${key}" needs a whole-number usage.`);
  } else {
    used = input.used;
  }
  if (used === null) throw new QuotaUsageError(key);
  return quotaDecision(used, delta, limit);
}

function refusal(meter: QuotaMeterDefinition, limit: number): QuotaBlock {
  if (meter.unit === "flag") {
    return {
      status: 403,
      error: `${meter.label} is turned off for this website.`,
      code: "feature_disabled",
      meter: meter.key,
    };
  }
  const media = meter.unit === "bytes" ? `${Math.round(limit / (1024 * 1024))} MB` : String(limit);
  const error =
    meter.key === "sites"
      ? `This workspace has reached its site limit (${limit}).`
      : meter.key === "users"
        ? `This site has reached its user limit (${limit}).`
        : meter.key === "content"
          ? `This site has reached its content limit (${limit}).`
          : meter.key === "media.bytes"
            ? `This site has reached its media limit (${media}).`
            : meter.key === "files.bytes"
              ? `This site has reached its private file storage limit (${media}).`
            : `The limit for ${meter.label} has been reached (${media}).`;
  return { status: 409, error, code: "quota_exceeded", meter: meter.key };
}

/** Refuse a create when the next units would pass a configured limit. Unlimited stays allowed. */
export async function enforceQuota(key: string, scopeId: string, delta = 1): Promise<QuotaBlock | null> {
  try {
    const decision = await checkQuota(key, scopeId, { delta });
    if (decision.ok || decision.limit === null) return null;
    const meter = meterByKey(key);
    if (!meter) return null;
    return refusal(meter, decision.limit);
  } catch (err) {
    if (err instanceof QuotaUsageError) {
      return { status: 503, error: err.message, code: err.code, meter: err.meter };
    }
    throw err;
  }
}

export async function listQuotaMeters(scope: QuotaScope, scopeId: string): Promise<QuotaMeterView[]> {
  const stored = await storedLimits(scope, scopeId);
  const views: QuotaMeterView[] = [];
  for (const meter of listMeterDefinitions(scope)) {
    const used = meter.key === "storage.bytes" ? (await import("../storage/storage-snapshots.js")).storageSnapshot(scopeId).report?.totalBytes ?? null : meter.unit === "flag" ? null : meter.owner === "core" || meter.count ? await usageFor(meter, scopeId) : null;
    views.push(meterView(meter, stored.get(meter.key) ?? null, used));
  }
  if (scope === "site") {
    const extra = await siteContentTypeMeters(scopeId, new Set(views.map((view) => view.key)));
    for (const meter of extra) {
      const used = await usageFor(meter, scopeId);
      views.push(meterView(meter, stored.get(meter.key) ?? null, used));
    }
  }
  return views;
}

function meterView(meter: QuotaMeterDefinition, limit: number | null, used: number | null): QuotaMeterView {
  return { key: meter.key, scope: meter.scope, label: meter.label, unit: meter.unit, limit, used };
}

async function siteContentTypeMeters(siteId: string, seen: Set<string>): Promise<QuotaMeterDefinition[]> {
  const rows = await querySite<{ slug: string; label: string }>(
    siteId,
    "SELECT slug, label FROM content_types WHERE site_id = ? ORDER BY slug ASC",
    [siteId],
  );
  const metersForSite: QuotaMeterDefinition[] = [];
  for (const row of rows ?? []) {
    const slug = String(row.slug ?? "");
    const key = `content.${slug}`;
    if (!CONTENT_TYPE_METER.test(key) || seen.has(key)) continue;
    metersForSite.push({
      key,
      scope: "site",
      label: String(row.label || slug),
      unit: "count",
      owner: "core",
    });
  }
  return metersForSite;
}

export async function quotaLimitMap(scope: QuotaScope, scopeId: string): Promise<Map<string, number>> {
  return storedLimits(scope, scopeId);
}

async function scopeExists(scope: QuotaScope, scopeId: string): Promise<boolean> {
  if (!SCOPE_ID.test(scopeId)) return false;
  const db = await getControlDb();
  const rows =
    scope === "workspace"
      ? await db.query<{ id: string }>("SELECT id FROM tenants WHERE id = ? AND status <> 'deleted' LIMIT 1", [scopeId])
      : await db.query<{ id: string }>("SELECT id FROM sites WHERE id = ? AND status <> 'deleted' LIMIT 1", [scopeId]);
  return Boolean(rows[0]);
}

function validateAssignment(
  scope: QuotaScope,
  limits: Record<string, number | null>,
): { ok: true; limits: Record<string, number | null> } | { ok: false; status: number; error: string } {
  const keys = Object.keys(limits);
  if (keys.length > 50) return { ok: false, status: 400, error: "Too many limits." };
  const normalized: Array<[string, number | null]> = [];
  for (const key of keys) {
    const meter = meterByKey(key);
    if (!meter || meter.scope !== scope) {
      return { ok: false, status: 400, error: `Unknown quota meter "${key}".` };
    }
    try {
      normalized.push([key, assertLimit(limits[key] ?? null)]);
    } catch (err) {
      return { ok: false, status: 400, error: err instanceof Error ? err.message : "Invalid limit." };
    }
  }
  return { ok: true, limits: Object.fromEntries(normalized) };
}

async function writeLimits(
  scope: QuotaScope,
  scopeId: string,
  limits: Record<string, number | null>,
  mode: "replace" | "merge",
): Promise<void> {
  const db = await getControlDb();
  const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  await db.transaction(async (tx) => {
    if (mode === "replace") {
      await tx.run("DELETE FROM quota_limits WHERE scope = ? AND scope_id = ?", [scope, scopeId]);
    }
    for (const [key, limit] of Object.entries(limits)) {
      if (limit === null) {
        await tx.run("DELETE FROM quota_limits WHERE scope = ? AND scope_id = ? AND meter_key = ?", [scope, scopeId, key]);
        continue;
      }
      if (mode === "merge") {
        await tx.run("DELETE FROM quota_limits WHERE scope = ? AND scope_id = ? AND meter_key = ?", [scope, scopeId, key]);
      }
      await tx.run(
        "INSERT INTO quota_limits (scope, scope_id, meter_key, limit_value, updated_at) VALUES (?, ?, ?, ?, ?)",
        [scope, scopeId, key, limit, stamp],
      );
    }
  });
}

async function audit(actorId: string | null, scopeId: string, detail: string): Promise<void> {
  const uuid = actorId && SCOPE_ID.test(actorId) ? actorId : null;
  try {
    const db = await getControlDb();
    await db.run(
      "INSERT INTO platform_audit (id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [randomUUID(), uuid, "quota.limits.saved", scopeId, detail.slice(0, 500), new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "")],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    console.error("[justflows] quota audit failed:", JSON.stringify(message.replace(/[\r\n]/g, " ")));
  }
}

export async function replaceQuotaLimits(
  scope: QuotaScope,
  scopeId: string,
  limits: Record<string, number | null>,
  actorId: string | null,
): Promise<{ ok: true; meters: QuotaMeterView[] } | { ok: false; status: number; error: string }> {
  const checked = validateAssignment(scope, limits);
  if (!checked.ok) return checked;
  if (!(await scopeExists(scope, scopeId))) {
    return { ok: false, status: 404, error: scope === "workspace" ? "That workspace was not found." : "That website was not found." };
  }
  if (scope === "site") await (await import("../storage/storage-quota.js")).withSiteStorageLock(scopeId, () => writeLimits(scope, scopeId, checked.limits, "replace"));
  else await writeLimits(scope, scopeId, checked.limits, "replace");
  await audit(actorId, scopeId, JSON.stringify(checked.limits));
  await emitUpdated(scope, scopeId, await publishedLimits(scope, scopeId));
  return { ok: true, meters: await listQuotaMeters(scope, scopeId) };
}

async function publishedLimits(scope: QuotaScope, scopeId: string): Promise<Record<string, number | null>> {
  const stored = await storedLimits(scope, scopeId);
  const limits: Record<string, number | null> = {};
  for (const meter of listMeterDefinitions(scope)) limits[meter.key] = stored.get(meter.key) ?? null;
  return limits;
}

export async function setQuotaLimit(
  scope: QuotaScope,
  scopeId: string,
  key: string,
  limit: number | null,
  actorId: string | null,
): Promise<void> {
  const checked = validateAssignment(scope, { [key]: limit });
  if (!checked.ok) throw new Error(checked.error);
  if (!(await scopeExists(scope, scopeId))) throw new Error(scope === "workspace" ? "That workspace was not found." : "That website was not found.");
  if (scope === "site") await (await import("../storage/storage-quota.js")).withSiteStorageLock(scopeId, () => writeLimits(scope, scopeId, checked.limits, "merge"));
  else await writeLimits(scope, scopeId, checked.limits, "merge");
  await audit(actorId, scopeId, JSON.stringify(checked.limits));
  await emitUpdated(scope, scopeId, await publishedLimits(scope, scopeId));
}

const DEFAULTS_KEY = "quota_defaults";

interface QuotaDefaultStore {
  workspace: Record<string, number>;
  site: Record<string, number>;
}

function emptyDefaults(): QuotaDefaultStore {
  return { workspace: {}, site: {} };
}

function finiteLimit(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseDefaultStore(value: unknown): QuotaDefaultStore {
  let raw = value;
  for (let depth = 0; depth < 2 && typeof raw === "string"; depth += 1) {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return emptyDefaults();
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyDefaults();
  const record = raw as { workspace?: unknown; site?: unknown };
  return {
    workspace: finiteMap(record.workspace),
    site: finiteMap(record.site),
  };
}

function finiteMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const limits: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const limit = finiteLimit(raw);
    if (limit !== null && METER_KEY.test(key)) limits[key] = limit;
  }
  return limits;
}

async function readDefaultStore(): Promise<QuotaDefaultStore> {
  try {
    const db = await getControlDb();
    const rows = await db.query<{ value: unknown }>(
      "SELECT value FROM platform_settings WHERE setting_key = ? LIMIT 1",
      [DEFAULTS_KEY],
    );
    return parseDefaultStore(rows[0]?.value);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    console.error("[justflows] quota defaults could not be read:", JSON.stringify(message.replace(/[\r\n]/g, " ")));
    return emptyDefaults();
  }
}

async function writeDefaultStore(store: QuotaDefaultStore): Promise<void> {
  const db = await getControlDb();
  const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  if (process.env.DB_DRIVER === "postgres") {
    await db.run(
      `INSERT INTO platform_settings (setting_key, value, updated_at) VALUES (?, ?::jsonb, ?)
       ON CONFLICT (setting_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [DEFAULTS_KEY, store as unknown as string, stamp],
    );
    return;
  }
  await db.run(
    `INSERT INTO platform_settings (setting_key, value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [DEFAULTS_KEY, JSON.stringify(store), stamp],
  );
}

/** Content types that already exist on any website, so Defaults can cap them before the next site is created. */
async function installContentTypeMeters(seen: Set<string>, saved: Record<string, number>): Promise<QuotaMeterDefinition[]> {
  const found = new Map<string, QuotaMeterDefinition>();
  const skip = new Set(seen);
  try {
    const db = await getControlDb();
    const sites = await db.query<{ id: string }>("SELECT id FROM sites WHERE status <> 'deleted' ORDER BY id ASC");
    for (const site of sites) {
      try {
        for (const meter of await siteContentTypeMeters(String(site.id), skip)) {
          found.set(meter.key, meter);
          skip.add(meter.key);
        }
      } catch {
        // One unreachable site database does not hide types from the others.
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    console.error("[justflows] quota default content types could not be listed:", JSON.stringify(message.replace(/[\r\n]/g, " ")));
  }
  for (const key of Object.keys(saved)) {
    if (skip.has(key) || !CONTENT_TYPE_METER.test(key) || key === "content.types") continue;
    const meter = meterByKey(key);
    if (meter) found.set(key, meter);
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Meters with the installation default. `used` stays empty: nothing has been counted yet. */
export async function listQuotaDefaultMeters(scope: QuotaScope): Promise<QuotaMeterView[]> {
  const saved = (await readDefaultStore())[scope];
  const views = listMeterDefinitions(scope).map((meter) => meterView(meter, saved[meter.key] ?? null, null));
  if (scope === "site") {
    for (const meter of await installContentTypeMeters(new Set(views.map((view) => view.key)), saved)) {
      views.push(meterView(meter, saved[meter.key] ?? null, null));
    }
  }
  return views;
}

/** Replace the defaults for one scope. Null clears that meter back to unlimited. */
export async function replaceQuotaDefaults(
  scope: QuotaScope,
  limits: Record<string, number | null>,
  actorId: string | null,
): Promise<{ ok: true; meters: QuotaMeterView[] } | { ok: false; status: number; error: string }> {
  const checked = validateAssignment(scope, limits);
  if (!checked.ok) return checked;
  const store = await readDefaultStore();
  // No computed writes here: meter keys and `scope` come from the request, and
  // `obj[requestValue] =` is a property-injection sink even after validation.
  const next: Record<string, number> = Object.fromEntries(
    Object.entries(checked.limits).filter((entry): entry is [string, number] => entry[1] !== null),
  );
  await writeDefaultStore(scope === "workspace" ? { ...store, workspace: next } : { ...store, site: next });
  await audit(actorId, scope, JSON.stringify(next));
  return { ok: true, meters: await listQuotaDefaultMeters(scope) };
}

/** Copy finite defaults onto a workspace or website that was just created. */
export async function applyQuotaDefaults(scope: QuotaScope, scopeId: string): Promise<void> {
  const saved = (await readDefaultStore())[scope];
  const limits: Record<string, number | null> = {};
  for (const [key, limit] of Object.entries(saved)) {
    if (typeof limit !== "number") continue;
    const meter = meterByKey(key);
    if (!meter || meter.scope !== scope) continue;
    limits[key] = limit;
  }
  if (Object.keys(limits).length === 0) return;
  await writeLimits(scope, scopeId, limits, "merge");
  await emitUpdated(scope, scopeId, await publishedLimits(scope, scopeId));
}
