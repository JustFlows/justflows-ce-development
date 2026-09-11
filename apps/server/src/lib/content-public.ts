import { getDb } from "./db.js";
import { serializeContentRow, type ContentResponse } from "./content-api.js";
import { overlayWorkingOnRow } from "./content-revisions.js";
import { getDefaultLocale, resolveContentLocale } from "./i18n/languages-db.js";
import { getJfCache } from "./jf-cache.js";

const CONTENT_CACHE_PREFIX = "content:";

let defaultTtlSeconds = 300;

/** Resolve TTL from config once per process (falls back to 300s pre-install). */
async function contentCacheTtl(): Promise<number> {
  if (defaultTtlSeconds !== 300) return defaultTtlSeconds;
  try {
    const { loadConfig } = await import("@justflows/core");
    defaultTtlSeconds = loadConfig().cache.ttlSeconds;
  } catch {
    // keep default
  }
  return defaultTtlSeconds;
}

import { revalidateOnUpdate } from "./cache-revalidate.js";

export async function invalidateContentCache(force = false): Promise<void> {
  if (force) {
    const { revalidateSelected } = await import("./cache-revalidate.js");
    await revalidateSelected(["content", "pages", "menus"]);
  }
  await getJfCache().invalidate("content:permalink:");
  await revalidateOnUpdate("content");
}

async function loadPublishedRow(
  siteId: string,
  slug: string,
  locale: string,
  preview: boolean,
): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const statusClause = preview
    ? "AND status IN ('published', 'draft', 'scheduled')"
    : "AND status = 'published'";
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM content WHERE site_id = ? AND slug = ? AND locale = ? ${statusClause} LIMIT 1`,
    [siteId, slug, locale],
  );
  return rows[0] ?? null;
}

async function loadPublishedTranslation(
  siteId: string,
  translationGroupId: string,
  locale: string,
  preview: boolean,
): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const statusClause = preview
    ? "AND status IN ('published', 'draft', 'scheduled')"
    : "AND status = 'published'";
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM content WHERE site_id = ? AND translation_group_id = ? AND locale = ? ${statusClause} LIMIT 1`,
    [siteId, translationGroupId, locale],
  );
  return rows[0] ?? null;
}

async function serializePublished(
  row: Record<string, unknown>,
  preview: boolean,
): Promise<ContentResponse> {
  const overlaid = preview ? await overlayWorkingOnRow(row, true) : row;
  return serializeContentRow(overlaid);
}

async function fetchPublishedContentBySlug(
  slug: string,
  requestedLocale?: string,
  preview = false,
): Promise<ContentResponse | null> {
  const db = await getDb();
  const sites = await db.query<{ id: string }>("SELECT id FROM sites LIMIT 1");
  const siteId = sites[0]?.id;
  if (!siteId) return null;

  const locale = await resolveContentLocale(requestedLocale, siteId);
  const exact = await loadPublishedRow(siteId, slug, locale, preview);
  if (exact) return serializePublished(exact, preview);

  const defaultLocale = await getDefaultLocale(siteId);
  if (defaultLocale === locale) return null;

  const fallback = await loadPublishedRow(siteId, slug, defaultLocale, preview);
  if (!fallback) return null;

  const groupId =
    fallback.translation_group_id == null ? null : String(fallback.translation_group_id);
  if (groupId) {
    const translated = await loadPublishedTranslation(siteId, groupId, locale, preview);
    if (translated) return serializePublished(translated, preview);
  }

  return serializePublished(fallback, preview);
}

export async function getPublishedContentBySlug(
  slug: string,
  requestedLocale?: string,
  preview = false,
): Promise<ContentResponse | null> {
  if (preview) {
    return fetchPublishedContentBySlug(slug, requestedLocale, true);
  }

  const cacheKey = `${CONTENT_CACHE_PREFIX}published:${slug}:${requestedLocale ?? ""}`;

  return getJfCache().remember(cacheKey, await contentCacheTtl(), () =>
    fetchPublishedContentBySlug(slug, requestedLocale, false),
  );
}

async function fetchTranslationAlternates(
  translationGroupId: string,
): Promise<Array<{ locale: string; slug: string }>> {
  const db = await getDb();
  const rows = await db.query<{ locale: string; slug: string }>(
    "SELECT locale, slug FROM content WHERE translation_group_id = ? AND status = 'published'",
    [translationGroupId],
  );
  return rows.map((r) => ({ locale: String(r.locale), slug: String(r.slug) }));
}

export async function getTranslationAlternates(
  translationGroupId: string,
): Promise<Array<{ locale: string; slug: string }>> {
  const cacheKey = `${CONTENT_CACHE_PREFIX}alternates:${translationGroupId}`;

  return getJfCache().remember(cacheKey, await contentCacheTtl(), () =>
    fetchTranslationAlternates(translationGroupId),
  );
}

export async function listPublishedContent(siteId: string): Promise<ContentResponse[]> {
  const cacheKey = `${CONTENT_CACHE_PREFIX}published-list:${siteId}`;
  return getJfCache().remember(cacheKey, await contentCacheTtl(), async () => {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE site_id = ? AND status = 'published' ORDER BY updated_at DESC",
      [siteId],
    );
    return rows.map((row) => serializeContentRow(row));
  });
}

export interface PublishedPostsPage {
  items: ContentResponse[];
  total: number;
}

/** Paginated, published `post` content for a blog listing block, newest first. */
export async function listPublishedPostsPage(
  siteId: string,
  locale: string,
  { limit, offset }: { limit: number; offset: number },
): Promise<PublishedPostsPage> {
  const cacheKey = `${CONTENT_CACHE_PREFIX}published-posts:${siteId}:${locale}:${limit}:${offset}`;

  return getJfCache().remember(cacheKey, await contentCacheTtl(), async () => {
    const db = await getDb();
    const [rows, countRows] = await Promise.all([
      db.query<Record<string, unknown>>(
        `SELECT * FROM content WHERE site_id = ? AND type = 'post' AND locale = ? AND status = 'published'
         ORDER BY published_at DESC, created_at DESC LIMIT ? OFFSET ?`,
        [siteId, locale, limit, offset],
      ),
      db.query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM content WHERE site_id = ? AND type = 'post' AND locale = ? AND status = 'published'",
        [siteId, locale],
      ),
    ]);
    return {
      items: rows.map((row) => serializeContentRow(row)),
      total: Number(countRows[0]?.total ?? 0),
    };
  });
}
