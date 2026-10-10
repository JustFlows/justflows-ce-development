// SPDX-License-Identifier: MIT
import { cacheControlPolicy, effectiveContentCacheControl } from "@justflows/content";
import { normalizeFields } from "../content/content-api.js";
import { getDb } from "../database/db.js";
import { createContentPermalinkResolver, getPermalinkState, permalinkContent } from "../navigation/permalinks-db.js";

export interface ContentCacheRule {
  id: string;
  paths: string[];
  header: string;
  shared: boolean;
  ttl: number;
}
const pathname = (url: string) => url.split("?")[0]!.replace(/\/$/, "") || "/";

/** Read policy directly so turning caching off never consults a stale policy cache.
 * Resolve URLs in one operation, with no per-page settings or category reads.
 */
export async function contentCacheRules(siteId: string): Promise<ContentCacheRule[]> {
  const db = await getDb();
  const types = await db.query<{ slug: string; cache_control: string }>(
    "SELECT slug, cache_control FROM content_types WHERE site_id = ? AND cache_control IS NOT NULL", [siteId]);
  const overridePredicate = process.env.DB_DRIVER === "postgres"
    ? "fields->>'cacheControl' IS NOT NULL"
    : "JSON_EXTRACT(fields, '$.cacheControl') IS NOT NULL AND JSON_TYPE(JSON_EXTRACT(fields, '$.cacheControl')) <> 'NULL'";
  const overrides = await db.query<{ id: string; fields: unknown }>(
    `SELECT id, fields FROM content WHERE site_id = ? AND trashed_at IS NULL AND ${overridePredicate}`, [siteId]);
  if (!types.length && !overrides.length) return [];
  const defaults = new Map(types.map(type => [type.slug, type.cache_control]));
  const fieldsById = new Map(overrides.map(row => [String(row.id), normalizeFields(Buffer.isBuffer(row.fields) ? row.fields.toString("utf8") : row.fields)]));
  const policies = new Map<string, ReturnType<typeof cacheControlPolicy>>();
  const contents = (await permalinkContent(siteId, false)).filter(content => {
    const header = effectiveContentCacheControl(content.type, fieldsById.get(content.id) ?? {}, defaults.get(content.type) ?? null);
    if (header === null) return false;
    policies.set(content.id, cacheControlPolicy(header));
    return true;
  });
  if (!contents.length) return [];
  const state = await getPermalinkState(siteId);
  const resolve = await createContentPermalinkResolver(siteId, { state });
  const aliases = new Map<string, string[]>();
  for (const [url, id] of Object.entries(state.redirects)) {
    const paths = aliases.get(id) ?? []; paths.push(pathname(url)); aliases.set(id, paths);
  }
  const rules: ContentCacheRule[] = [];
  for (const content of contents) {
    rules.push({ id: content.id, paths: [...new Set([pathname(await resolve(content)), ...aliases.get(content.id) ?? []])], ...policies.get(content.id)! });
  }
  return rules;
}

export function matchContentCacheRule(rules: readonly ContentCacheRule[], path: string, id?: string) {
  const clean = pathname(path).replace(/\/page\/[1-9][0-9]*$/, "") || "/";
  return rules.find(rule => id ? rule.id === id : rule.paths.includes(clean));
}

export function contentCacheExclusions(rules: readonly ContentCacheRule[]) {
  return rules.filter(rule => !rule.shared).flatMap(rule => rule.paths.flatMap(path => [
    { path, match: "exact" as const }, { path: `${path === "/" ? "" : path}/page`, match: "prefix" as const },
  ]));
}
