// SPDX-License-Identifier: MIT

import { getDb } from "./db.js";
import { serializeContentRow, type ContentResponse } from "./content-api.js";
import { overlayWorkingOnRow } from "./content-revisions.js";
import { deleteSiteSetting, getSiteSetting, setSiteSetting } from "./site-settings.js";
import { revalidateOnUpdate } from "./cache-revalidate.js";

export const HOME_PAGE_SETTING_KEY = "home_page_id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseHomePageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

export async function getHomePageId(siteId: string): Promise<string | null> {
  const stored = await getSiteSetting<unknown>(siteId, HOME_PAGE_SETTING_KEY);
  return parseHomePageId(stored);
}

export async function setHomePageId(siteId: string, contentId: string | null): Promise<string | null> {
  if (!contentId) {
    await deleteSiteSetting(siteId, HOME_PAGE_SETTING_KEY);
    await revalidateOnUpdate("settings");
    return null;
  }

  const parsed = parseHomePageId(contentId);
  if (!parsed) throw new Error("Invalid home page id");

  const db = await getDb();
  const rows = await db.query<{ id: string; type: string }>(
    "SELECT id, type FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [parsed, siteId],
  );
  const row = rows[0];
  if (!row) throw new Error("Page not found");
  if (row.type !== "page") throw new Error("Home must be a page");

  await setSiteSetting(siteId, HOME_PAGE_SETTING_KEY, parsed);
  await revalidateOnUpdate("settings");
  return parsed;
}

export async function clearHomePageIfMatches(siteId: string, contentId: string): Promise<void> {
  const current = await getHomePageId(siteId);
  if (current === contentId) {
    await deleteSiteSetting(siteId, HOME_PAGE_SETTING_KEY);
    await revalidateOnUpdate("settings");
  }
}

async function loadContentRow(
  siteId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, siteId],
  );
  return rows[0] ?? null;
}

function isUsable(row: Record<string, unknown>, preview: boolean): boolean {
  const status = String(row.status ?? "");
  if (preview) return status === "published" || status === "draft" || status === "scheduled";
  return status === "published";
}

/**
 * Resolve the page that should render at `/` for this locale.
 * Prefers a translation of the selected home page when one exists.
 */
export async function getHomeContent(
  siteId: string,
  locale: string,
  preview = false,
): Promise<ContentResponse | null> {
  const homeId = await getHomePageId(siteId);
  if (!homeId) return null;

  const row = await loadContentRow(siteId, homeId);
  if (!row) return null;

  const groupId = row.translation_group_id == null ? null : String(row.translation_group_id);
  const db = await getDb();

  if (groupId) {
    const statusClause = preview ? "status IN ('published', 'draft', 'scheduled')" : "status = 'published'";
    const localized = await db.query<Record<string, unknown>>(
      `SELECT * FROM content WHERE site_id = ? AND translation_group_id = ? AND locale = ? AND ${statusClause} LIMIT 1`,
      [siteId, groupId, locale],
    );
    if (localized[0]) {
      const overlaid = preview ? await overlayWorkingOnRow(localized[0], true) : localized[0];
      return serializeContentRow(overlaid);
    }
  }

  if (String(row.locale ?? "") === locale && isUsable(row, preview)) {
    const overlaid = preview ? await overlayWorkingOnRow(row, true) : row;
    return serializeContentRow(overlaid);
  }

  if (isUsable(row, preview)) {
    const overlaid = preview ? await overlayWorkingOnRow(row, true) : row;
    return serializeContentRow(overlaid);
  }
  return null;
}

export function isHomeContentSlug(
  content: { id: string; slug: string; translationGroupId?: string | null } | null,
  home: ContentResponse | null,
): boolean {
  if (!content || !home) return false;
  if (content.id === home.id) return true;
  return Boolean(
    content.translationGroupId &&
      home.translationGroupId &&
      content.translationGroupId === home.translationGroupId,
  );
}
