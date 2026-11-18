// SPDX-License-Identifier: MIT
import { NEVER_CACHE_CONTROL, cacheControlPolicy, contentTypePolicy, effectiveContentCacheControl, isOpenVisibilityPolicy, publicContentTypeSql } from "@justflows/content";
import { normalizeFields, serializeContentRow } from "../content/content-api.js";
import { getHomeContent } from "../content/home-page.js";
import { getActiveLocaleCodes } from "../i18n/languages-db.js";
import { getDb } from "../database/db.js";
import { createContentPermalinkResolver, getPermalinkState, permalinkContent } from "../navigation/permalinks-db.js";
import { effectiveVisibilityPolicy, loadVisibilityPolicies } from "../content/visibility-policies.js";

export interface ContentCacheRule {
  id: string;
  paths: string[];
  header: string;
  shared: boolean;
  ttl: number;
}
const pathname = (url: string) => url.split("?")[0]!.replace(/\/$/, "") || "/";
/** The path a rule is matched against: no query, trailing slash or `/page/N`. */
const matchPath = (path: string) => pathname(path).replace(/\/page\/[1-9][0-9]*$/, "") || "/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bound on the path segments one request may turn into lookup parameters. */
const MAX_SEGMENTS = 32;
const CANDIDATE_COLUMNS =
  "id, site_id, type, title, slug, locale, translation_group_id, status, author_id, published_at, created_at, updated_at";

interface CachePolicyInputs {
  defaults: Map<string, string>;
  fieldsById: Map<string, Record<string, unknown>>;
  visibility: Awaited<ReturnType<typeof loadVisibilityPolicies>>;
}

/**
 * Type defaults, per-entry overrides and visibility rules, or null when none
 * exist. Read directly so turning caching off never consults a stale policy
 * cache. The override lookup is indexed (migration 0063): it runs on every
 * public page request.
 */
async function cachePolicyInputs(siteId: string): Promise<CachePolicyInputs | null> {
  const db = await getDb();
  const types = await db.query<{ slug: string; cache_control: string }>(
    "SELECT slug, cache_control FROM content_types WHERE site_id = ? AND cache_control IS NOT NULL", [siteId]);
  const overridePredicate = process.env.DB_DRIVER === "postgres"
    ? "fields->>'cacheControl' IS NOT NULL"
    : "has_cache_control = 1";
  const overrides = await db.query<{ id: string; fields: unknown }>(
    `SELECT id, fields FROM content WHERE site_id = ? AND trashed_at IS NULL AND ${overridePredicate}`, [siteId]);
  const visibility = await loadVisibilityPolicies(siteId);
  if (!types.length && !overrides.length && !visibility.restricted) return null;
  return {
    defaults: new Map(types.map(type => [type.slug, type.cache_control])),
    fieldsById: new Map(overrides.map(row => [String(row.id), normalizeFields(Buffer.isBuffer(row.fields) ? row.fields.toString("utf8") : row.fields)])),
    visibility,
  };
}

/** Rules for `contents`, resolving their URLs with one resolver and no per-page settings reads. */
async function buildRules(
  siteId: string,
  inputs: CachePolicyInputs,
  contents: Awaited<ReturnType<typeof permalinkContent>>,
  state?: Awaited<ReturnType<typeof getPermalinkState>>,
): Promise<ContentCacheRule[]> {
  const { defaults, fieldsById, visibility } = inputs;
  const policies = new Map<string, ReturnType<typeof cacheControlPolicy>>();
  const ruled = contents.filter(content => {
    /** A page with visibility rules answers per visitor: no shared cache and no exported file may hold it. */
    const gated = visibility.restricted && !isOpenVisibilityPolicy(effectiveVisibilityPolicy(visibility, content).policy);
    const header = gated ? NEVER_CACHE_CONTROL : effectiveContentCacheControl(content.type, fieldsById.get(content.id) ?? {}, defaults.get(content.type) ?? null);
    if (header === null) return false;
    policies.set(content.id, cacheControlPolicy(header));
    return true;
  });
  if (!ruled.length) return [];
  const permalinks = state ?? await getPermalinkState(siteId);
  const resolve = await createContentPermalinkResolver(siteId, { state: permalinks, preloadIds: ruled.map(content => content.id) });
  const aliases = new Map<string, string[]>();
  for (const [url, id] of Object.entries(permalinks.redirects)) {
    const paths = aliases.get(id) ?? []; paths.push(pathname(url)); aliases.set(id, paths);
  }
  const rules: ContentCacheRule[] = [];
  for (const content of ruled) {
    rules.push({ id: content.id, paths: [...new Set([pathname(await resolve(content)), ...aliases.get(content.id) ?? []])], ...policies.get(content.id)! });
  }
  return rules;
}

/**
 * Every entry's rule, for static export and the service worker, which need
 * the whole site. A page request uses `contentCacheRuleForRequest` instead.
 */
export async function contentCacheRules(siteId: string): Promise<ContentCacheRule[]> {
  const inputs = await cachePolicyInputs(siteId);
  if (!inputs) return [];
  return buildRules(siteId, inputs, await permalinkContent(siteId, false));
}

/**
 * The rule for one page request, without loading the whole site. Every post
 * structure contains `%postname%` or `%id%`, so the entry a path belongs to is
 * among those whose slug or id is one of its segments, a home page (root and
 * locale roots), an old URL kept as a redirect, a layout index, or `?p=`. Only
 * those candidates get a rule, through the same resolver as the site-wide
 * list, and the path still has to match exactly.
 */
export async function contentCacheRuleForRequest(siteId: string, path: string, id?: string): Promise<ContentCacheRule | undefined> {
  const inputs = await cachePolicyInputs(siteId);
  if (!inputs) return undefined;
  const state = await getPermalinkState(siteId);
  const clean = matchPath(path);
  const segments = [...new Set(clean.split("/").filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }))].slice(0, MAX_SEGMENTS);

  const slugs = new Set(segments);
  const ids = new Set(segments.filter(segment => UUID.test(segment)));
  if (id && UUID.test(id)) ids.add(id);
  for (const [url, target] of Object.entries(state.redirects)) if (pathname(url) === clean && UUID.test(target)) ids.add(target);
  for (const scope of state.layoutScopes) if (scope.index && clean === `/${scope.base}`) slugs.add(scope.index.slug);
  if (segments.length <= 1) {
    const locales = await getActiveLocaleCodes();
    const homes = await Promise.all(locales.map(locale => getHomeContent(siteId, locale, false)));
    for (const home of homes) if (home) ids.add(home.id);
  }
  if (!slugs.size && !ids.size) return undefined;

  const db = await getDb();
  const where = [
    ...(slugs.size ? [`slug IN (${[...slugs].map(() => "?").join(", ")})`] : []),
    ...(ids.size ? [`id IN (${[...ids].map(() => "?").join(", ")})`] : []),
  ].join(" OR ");
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${CANDIDATE_COLUMNS} FROM content WHERE site_id = ? AND trashed_at IS NULL AND ${publicContentTypeSql()} AND (${where})`,
    [siteId, ...slugs, ...ids],
  );
  const candidates = rows.map(serializeContentRow).filter(content => contentTypePolicy(content.type).publiclyDiscoverable);
  return matchContentCacheRule(await buildRules(siteId, inputs, candidates, state), path, id);
}

export function matchContentCacheRule(rules: readonly ContentCacheRule[], path: string, id?: string) {
  const clean = matchPath(path);
  return rules.find(rule => id ? rule.id === id : rule.paths.includes(clean));
}

export function contentCacheExclusions(rules: readonly ContentCacheRule[]) {
  return rules.filter(rule => !rule.shared).flatMap(rule => rule.paths.flatMap(path => [
    { path, match: "exact" as const }, { path: `${path === "/" ? "" : path}/page`, match: "prefix" as const },
  ]));
}
