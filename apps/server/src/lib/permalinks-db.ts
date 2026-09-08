// SPDX-License-Identifier: MIT

import { getDb } from "./db.js";
import { serializeContentRow, type ContentResponse } from "./content-api.js";
import { getSiteSetting, setSiteSetting } from "./site-settings.js";
import { getDefaultLocale, getActiveLocaleCodes } from "./i18n/languages-db.js";
import { getAdminPathConfig } from "./admin-path.js";
import { getHomeContent } from "./home-page.js";
import { localePath } from "./i18n/locales.js";
import { getJfCache } from "./jf-cache.js";
import {
  DEFAULT_PERMALINK_SETTINGS,
  PermalinkSettingsSchema,
  permalinkPath,
  RESERVED_PERMALINK_SEGMENTS,
  type PermalinkSettings,
  type PermalinkContent,
  slashPath,
} from "./permalinks.js";

export interface PermalinkState {
  settings: PermalinkSettings;
  /** Exact prior paths point at content IDs, so subsequent changes cannot create redirect chains. */
  redirects: Record<string, string>;
  archiveRedirects?: Record<string, string>;
}
export async function getPermalinkState(siteId: string): Promise<PermalinkState> {
  const raw = await getSiteSetting<PermalinkState>(siteId, "permalinks");
  const parsed = PermalinkSettingsSchema.safeParse(raw?.settings);
  return {
    settings: parsed.success ? parsed.data : DEFAULT_PERMALINK_SETTINGS,
    redirects: raw?.redirects ?? {},
    archiveRedirects: raw?.archiveRedirects ?? {},
  };
}
export async function contentPermalink(content: ContentResponse): Promise<string> {
  const [{ settings }, defaultLocale, home] = await Promise.all([
    getPermalinkState(content.siteId),
    getDefaultLocale(content.siteId),
    getHomeContent(content.siteId, content.locale, false),
  ]);
  if (home?.id === content.id)
    return slashPath(localePath(content.locale, "/", defaultLocale), settings.trailingSlash);
  const enriched = await enrichPermalinkContent([content], content.siteId);
  return permalinkPath(enriched[0]!, settings, defaultLocale);
}
export async function permalinkContent(
  siteId: string,
  publishedOnly = true,
): Promise<Array<ContentResponse & { permalinkCategory?: string }>> {
  const load = async () => {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      `SELECT id, site_id, type, title, slug, locale, translation_group_id, status, author_id, published_at, created_at, updated_at FROM content WHERE site_id = ? AND trashed_at IS NULL${publishedOnly ? " AND status = 'published'" : ""} ORDER BY id`,
      [siteId],
    );
    return enrichPermalinkContent(rows.map(serializeContentRow), siteId);
  };
  return publishedOnly ? getJfCache().remember(`content:permalink:${siteId}`, 300, load) : load();
}
export async function reservedPermalinkPath(path: string): Promise<boolean> {
  const pathname = path.split("?")[0]!;
  const locales = await getActiveLocaleCodes();
  const parts = pathname.split("/").filter(Boolean);
  if (locales.some((l) => l.toLowerCase() === parts[0]?.toLowerCase())) parts.shift();
  const first = parts[0]?.toLowerCase() ?? "";
  const admin = (await getAdminPathConfig()).path.split("/").filter(Boolean)[0]!.toLowerCase();
  return RESERVED_PERMALINK_SEGMENTS.has(first) || first === admin;
}
export class PermalinkConflictError extends Error {}
export async function savePermalinks(siteId: string, settings: PermalinkSettings): Promise<number> {
  const [state, items, defaultLocale, locales] = await Promise.all([
    getPermalinkState(siteId),
    permalinkContent(siteId, false),
    getDefaultLocale(siteId),
    getActiveLocaleCodes(),
  ]);
  const bases = [
    settings.categoryBase,
    settings.tagBase,
    ...Object.values(settings.taxonomyBases),
    ...Object.values(settings.typeBases),
  ];
  if (new Set(bases).size !== bases.length)
    throw new PermalinkConflictError("Content and taxonomy bases must be distinct.");
  for (const base of bases) {
    if (
      (await reservedPermalinkPath(`/${base}`)) ||
      locales.some((l) => l.toLowerCase() === base.split("/")[0]!.toLowerCase())
    )
      throw new PermalinkConflictError("A base conflicts with a platform route or locale prefix.");
  }
  // Validate the structure even on sites without posts.
  const sample = {
    id: "example-id",
    slug: "example",
    type: "post",
    locale: defaultLocale,
    publishedAt: null,
    createdAt: "2026-01-01",
    authorId: null,
    fields: {},
  };
  if (
    locales.some(
      (locale) => locale.toLowerCase() === settings.structure.split("/")[1]?.toLowerCase(),
    ) ||
    (await reservedPermalinkPath(permalinkPath(sample, settings, defaultLocale)))
  )
    throw new PermalinkConflictError("The structure conflicts with a platform route.");
  const paths = new Map<string, string>();
  const homes = new Set<string>();
  for (const locale of locales) {
    const home = await getHomeContent(siteId, locale, false);
    if (home) homes.add(home.id);
  }
  for (const item of items) {
    if (homes.has(item.id)) continue;
    const path = permalinkPath(item, settings, defaultLocale);
    if (await reservedPermalinkPath(path))
      throw new PermalinkConflictError(`Reserved URL for "${item.title}".`);
    const previous = paths.get(path);
    if (previous && previous !== item.id)
      throw new PermalinkConflictError(`URL collision: ${path}`);
    if (state.redirects[path] && state.redirects[path] !== item.id)
      throw new PermalinkConflictError(`URL is already a historical redirect: ${path}`);
    paths.set(path, item.id);
  }
  const terms = await listPermalinkTerms(siteId);
  const archiveRedirects = { ...state.archiveRedirects };
  for (const term of terms)
    for (const locale of locales) {
      const path = taxonomyPermalink(term, locale, settings, defaultLocale);
      if ((await reservedPermalinkPath(path)) || paths.has(path))
        throw new PermalinkConflictError(`Archive URL collision: ${path}`);
      const identity = `${locale}:${term.id}`;
      if (archiveRedirects[path] && archiveRedirects[path] !== identity)
        throw new PermalinkConflictError(`Historical archive URL collision: ${path}`);
      paths.set(path, identity);
      const before = taxonomyPermalink(term, locale, state.settings, defaultLocale);
      if (before !== path) archiveRedirects[before] = identity;
      delete archiveRedirects[path];
    }
  for (const [path, identity] of Object.entries(archiveRedirects)) {
    if (paths.has(path) && paths.get(path) !== identity)
      throw new PermalinkConflictError(`Historical archive URL collision: ${path}`);
  }
  const redirects = { ...state.redirects };
  const oldCounts = new Map<string, number>();
  for (const item of items) {
    if (item.status !== "published" || homes.has(item.id)) continue;
    const path = permalinkPath(item, state.settings, defaultLocale);
    oldCounts.set(path, (oldCounts.get(path) ?? 0) + 1);
  }
  let added = 0;
  for (const item of items) {
    if (item.status !== "published" || homes.has(item.id)) continue;
    const before = permalinkPath(item, state.settings, defaultLocale);
    const after = permalinkPath(item, settings, defaultLocale);
    if (before !== after && oldCounts.get(before) === 1) {
      if (paths.has(before) && paths.get(before) !== item.id)
        throw new PermalinkConflictError(`A previous URL would belong to another item: ${before}`);
      redirects[before] = item.id;
      added++;
    }
    delete redirects[after];
  }
  // Settings and history are one atomic upsert on every supported database.
  await setSiteSetting(siteId, "permalinks", { settings, redirects, archiveRedirects });
  await Promise.all(
    ["page:", "content:", "menus:", "site:"].map((prefix) => getJfCache().invalidate(prefix)),
  );
  return added;
}

export interface PermalinkTerm {
  id: string;
  slug: string;
  name: string;
  taxonomy: string;
  contentIds: string[];
}
export async function listPermalinkTerms(siteId: string): Promise<PermalinkTerm[]> {
  const db = await getDb();
  const rows = await db.query<{
    id: string;
    slug: string;
    name: string;
    taxonomy: string;
    content_id: string | null;
  }>(
    `SELECT t.id, t.slug, t.name, x.slug AS taxonomy, ct.content_id FROM terms t
     JOIN taxonomies x ON x.id = t.taxonomy_id AND x.site_id = t.site_id
     LEFT JOIN content_terms ct ON ct.term_id = t.id WHERE t.site_id = ? ORDER BY t.slug, t.id`,
    [siteId],
  );
  const terms = new Map<string, PermalinkTerm>();
  for (const row of rows) {
    let term = terms.get(String(row.id));
    if (!term) {
      term = {
        id: String(row.id),
        slug: String(row.slug),
        name: String(row.name),
        taxonomy: String(row.taxonomy),
        contentIds: [],
      };
      terms.set(term.id, term);
    }
    if (row.content_id) term.contentIds.push(String(row.content_id));
  }
  return [...terms.values()];
}
async function enrichPermalinkContent<T extends PermalinkContent>(
  items: T[],
  siteId: string,
): Promise<Array<T & { permalinkCategory?: string }>> {
  if (!items.length) return [];
  const terms = await listPermalinkTerms(siteId);
  return items.map((item) => ({
    ...item,
    permalinkCategory: terms.find(
      (term) => term.taxonomy === "category" && term.contentIds.includes(item.id),
    )?.slug,
  }));
}
export function taxonomyPermalink(
  term: PermalinkTerm,
  locale: string,
  settings: PermalinkSettings,
  defaultLocale: string,
): string {
  const base =
    term.taxonomy === "category"
      ? settings.categoryBase
      : term.taxonomy === "tag"
        ? settings.tagBase
        : Object.hasOwn(settings.taxonomyBases, term.taxonomy)
          ? settings.taxonomyBases[term.taxonomy]
          : term.taxonomy;
  return slashPath(
    localePath(locale, `/${base}/${encodeURIComponent(term.slug)}`, defaultLocale),
    settings.trailingSlash,
  );
}

/** Resolve public collisions across content types, not just the database's per-type slug constraint. */
export async function uniquePermalinkSlug(content: ContentResponse): Promise<string> {
  const [state, items, defaultLocale, terms, locales] = await Promise.all([
    getPermalinkState(content.siteId),
    permalinkContent(content.siteId, false),
    getDefaultLocale(content.siteId),
    listPermalinkTerms(content.siteId),
    getActiveLocaleCodes(),
  ]);
  const initial = content.slug || "untitled";
  const enriched = (await enrichPermalinkContent([content], content.siteId))[0]!;
  const occupied = new Set(
    items
      .filter((item) => item.id !== content.id)
      .map((item) => permalinkPath(item, state.settings, defaultLocale)),
  );
  for (const term of terms)
    for (const locale of locales)
      occupied.add(taxonomyPermalink(term, locale, state.settings, defaultLocale));
  for (const [path, id] of Object.entries(state.redirects))
    if (id !== content.id) occupied.add(path);
  for (const path of Object.keys(state.archiveRedirects ?? {})) occupied.add(path);
  for (let suffix = 0; suffix < 10000; suffix++) {
    const slug = suffix ? `${initial.slice(0, 190)}-${suffix + 1}` : initial;
    const candidate = { ...enriched, slug };
    const path = permalinkPath(candidate, state.settings, defaultLocale);
    if (await reservedPermalinkPath(path))
      throw new PermalinkConflictError("This slug produces a reserved platform URL.");
    if (locales.some((locale) => locale.toLowerCase() === slug.toLowerCase()))
      throw new PermalinkConflictError("This slug is an enabled locale prefix.");
    if (
      !occupied.has(path) &&
      !items.some(
        (item) =>
          item.id !== content.id &&
          item.type === content.type &&
          item.locale === content.locale &&
          item.slug === slug,
      )
    )
      return slug;
    // An ID-only structure cannot be disambiguated by changing the slug.
    if (suffix && path === permalinkPath(enriched, state.settings, defaultLocale)) break;
  }
  throw new PermalinkConflictError(
    "Cannot allocate a unique public URL. Change the permalink structure.",
  );
}

export async function rememberContentPermalink(
  before: ContentResponse,
  after: ContentResponse,
): Promise<void> {
  if (before.status !== "published") return;
  const [previous, current] = await Promise.all([
    contentPermalink(before),
    contentPermalink(after),
  ]);
  if (previous === current) return;
  const state = await getPermalinkState(before.siteId);
  state.redirects[previous] = before.id;
  delete state.redirects[current];
  await setSiteSetting(before.siteId, "permalinks", state);
  await Promise.all(["page:", "menus:", "site:"].map((prefix) => getJfCache().invalidate(prefix)));
}
