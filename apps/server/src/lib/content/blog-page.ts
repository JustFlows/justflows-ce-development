// SPDX-License-Identifier: MIT

import { getDb } from "../database/db.js";
import { deleteSiteSetting, getSiteSetting, setSiteSetting } from "../settings/site-settings.js";
import { revalidateOnUpdate } from "../cache/cache-revalidate.js";

export const BLOG_PAGE_SETTING_KEY = "blog_page_id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseBlogPageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

export async function getBlogPageId(siteId: string): Promise<string | null> {
  const stored = await getSiteSetting<unknown>(siteId, BLOG_PAGE_SETTING_KEY);
  return parseBlogPageId(stored);
}

/**
 * Point the site's blog index at a content item. Unlike the home page, this
 * is not a routing target — the page still renders at its own slug via the
 * ordinary single-page route. The setting only marks which page is "the"
 * blog page for the admin UI (badges, the theme customizer) and for anything
 * that wants a canonical "view the blog" link.
 */
export async function setBlogPageId(siteId: string, contentId: string | null): Promise<string | null> {
  if (!contentId) {
    await deleteSiteSetting(siteId, BLOG_PAGE_SETTING_KEY);
    await revalidateOnUpdate("settings");
    return null;
  }

  const parsed = parseBlogPageId(contentId);
  if (!parsed) throw new Error("Invalid blog page id");

  const db = await getDb();
  const rows = await db.query<{ id: string; type: string }>(
    "SELECT id, type FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [parsed, siteId],
  );
  const row = rows[0];
  if (!row) throw new Error("Page not found");
  if (row.type !== "page") throw new Error("Blog page must be a page");

  await setSiteSetting(siteId, BLOG_PAGE_SETTING_KEY, parsed);
  await revalidateOnUpdate("settings");
  return parsed;
}

export async function clearBlogPageIfMatches(siteId: string, contentId: string): Promise<void> {
  await clearBlogPagesIfMatch(siteId, new Set([contentId]));
}

export async function clearBlogPagesIfMatch(siteId: string, contentIds: ReadonlySet<string>): Promise<void> {
  if (!contentIds.size) return;
  const current = await getBlogPageId(siteId);
  if (current && contentIds.has(current)) {
    await deleteSiteSetting(siteId, BLOG_PAGE_SETTING_KEY);
    await revalidateOnUpdate("settings");
  }
}
