/**
 * Data-access helpers for the menus table.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { localizePublicPath, localePath } from "./i18n/locales.js";
import { getActiveLocaleCodes } from "./i18n/languages-db.js";
import { getSiteId } from "./themes-db.js";
import { sanitizeNavUrl } from "./nav-url.js";

export type MenuItemType = string;

export interface MenuItem {
  id: string;
  label: string;
  type: MenuItemType;
  url?: string;
  contentId?: string;
  target?: "_blank";
  children?: MenuItem[];
}

export interface MenuRow {
  id: string;
  site_id: string;
  slug: string;
  name: string;
  items: MenuItem[];
}

export interface ResolvedNavItem {
  id: string;
  label: string;
  url: string;
  target?: string;
  children?: ResolvedNavItem[];
}

export const PRIMARY_MENU_SLUG = "primary";

function parseItems(raw: unknown): MenuItem[] {
  if (raw == null) return [];

  let parsed: unknown = raw;
  if (Buffer.isBuffer(raw)) {
    parsed = JSON.parse(raw.toString("utf8"));
  } else if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  // Some drivers double-encode JSON columns as strings.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  return Array.isArray(parsed) ? (parsed as MenuItem[]) : [];
}

function parseMenuRow(row: Record<string, unknown>): MenuRow {
  return {
    id: String(row.id),
    site_id: String(row.site_id),
    slug: String(row.slug),
    name: String(row.name),
    items: parseItems(row.items),
  };
}

export async function ensureDefaultMenu(siteId: string): Promise<void> {
  const db = await getDb();
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM menus WHERE site_id = ? AND slug = ? LIMIT 1",
    [siteId, PRIMARY_MENU_SLUG],
  );
  if (existing[0]) return;

  await db.run(
    "INSERT INTO menus (id, site_id, slug, name, items) VALUES (?, ?, ?, ?, ?)",
    [randomUUID(), siteId, PRIMARY_MENU_SLUG, "Primary Menu", "[]"],
  );
}

export async function listMenus(siteId: string): Promise<MenuRow[]> {
  await ensureDefaultMenu(siteId);
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM menus WHERE site_id = ? ORDER BY name ASC",
    [siteId],
  );
  return rows.map(parseMenuRow);
}

export async function getMenuBySlug(siteId: string, slug: string): Promise<MenuRow | null> {
  await ensureDefaultMenu(siteId);
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM menus WHERE site_id = ? AND slug = ? LIMIT 1",
    [siteId, slug],
  );
  return rows[0] ? parseMenuRow(rows[0]) : null;
}

export async function createMenu(siteId: string, slug: string, name: string): Promise<MenuRow> {
  const db = await getDb();
  const id = randomUUID();
  await db.run(
    "INSERT INTO menus (id, site_id, slug, name, items) VALUES (?, ?, ?, ?, ?)",
    [id, siteId, slug, name, "[]"],
  );
  return { id, site_id: siteId, slug, name, items: [] };
}

export async function updateMenu(
  siteId: string,
  slug: string,
  data: { name?: string; items?: MenuItem[] },
): Promise<MenuRow | null> {
  const menu = await getMenuBySlug(siteId, slug);
  if (!menu) return null;

  const db = await getDb();
  const name = data.name ?? menu.name;
  const items = data.items ?? menu.items;

  await db.run("UPDATE menus SET name = ?, items = ? WHERE site_id = ? AND slug = ?", [
    name,
    JSON.stringify(items),
    siteId,
    slug,
  ]);

  return { ...menu, name, items };
}

export async function deleteMenu(siteId: string, slug: string): Promise<boolean> {
  if (slug === PRIMARY_MENU_SLUG) return false;
  const db = await getDb();
  await db.run("DELETE FROM menus WHERE site_id = ? AND slug = ?", [siteId, slug]);
  return true;
}

interface MenuContentRef {
  id: string;
  slug: string;
  locale: string;
  title: string;
  translationGroupId: string | null;
}

async function loadContentByIds(ids: string[], preview = false): Promise<Map<string, MenuContentRef>> {
  const map = new Map<string, MenuContentRef>();
  if (ids.length === 0) return map;

  const db = await getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const statusClause = preview ? "status IN ('published', 'draft')" : "status = 'published'";
  const rows = await db.query<{
    id: string;
    slug: string;
    locale: string;
    title: string;
    translation_group_id: string | null;
  }>(
    `SELECT id, slug, locale, title, translation_group_id FROM content WHERE id IN (${placeholders}) AND ${statusClause}`,
    ids,
  );

  for (const row of rows) {
    map.set(String(row.id), {
      id: String(row.id),
      slug: String(row.slug),
      locale: String(row.locale),
      title: String(row.title),
      translationGroupId: row.translation_group_id == null ? null : String(row.translation_group_id),
    });
  }
  return map;
}

async function loadTranslationsByGroup(
  groupIds: string[],
  locale: string,
  preview = false,
): Promise<Map<string, MenuContentRef>> {
  const map = new Map<string, MenuContentRef>();
  const ids = [...new Set(groupIds.filter(Boolean))];
  if (ids.length === 0) return map;

  const db = await getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const statusClause = preview ? "status IN ('published', 'draft')" : "status = 'published'";
  const rows = await db.query<{
    id: string;
    slug: string;
    locale: string;
    title: string;
    translation_group_id: string | null;
  }>(
    `SELECT id, slug, locale, title, translation_group_id FROM content
     WHERE translation_group_id IN (${placeholders}) AND locale = ? AND ${statusClause}`,
    [...ids, locale],
  );

  for (const row of rows) {
    const groupId = row.translation_group_id == null ? null : String(row.translation_group_id);
    if (!groupId) continue;
    map.set(groupId, {
      id: String(row.id),
      slug: String(row.slug),
      locale: String(row.locale),
      title: String(row.title),
      translationGroupId: groupId,
    });
  }
  return map;
}

function collectContentIds(items: MenuItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (isContentLinkedMenuItem(item)) {
      ids.push(item.contentId);
    }
    if (item.children?.length) {
      ids.push(...collectContentIds(item.children));
    }
  }
  return ids;
}

/** CMS-backed menu items: any content type except a custom URL. */
export function isContentLinkedMenuItem(
  item: Pick<MenuItem, "type" | "contentId">,
): item is Pick<MenuItem, "type"> & { contentId: string } {
  return Boolean(item.contentId) && item.type !== "custom";
}

export async function resolveMenuItems(
  items: MenuItem[],
  locale: string,
  defaultLocale: string,
  preview = false,
): Promise<ResolvedNavItem[]> {
  const contentIds = collectContentIds(items);
  const contentMap = await loadContentByIds(contentIds, preview);
  const translationMap = await loadTranslationsByGroup(
    [...contentMap.values()].map((item) => item.translationGroupId ?? ""),
    locale,
    preview,
  );
  const activeLocales = await getActiveLocaleCodes();

  function resolveContentUrl(content: MenuContentRef): string {
    const translated =
      content.locale === locale
        ? content
        : content.translationGroupId
          ? translationMap.get(content.translationGroupId)
          : undefined;
    const slug = translated?.slug ?? content.slug;
    return localePath(locale, `/${slug}`, defaultLocale);
  }

  function resolveList(list: MenuItem[]): ResolvedNavItem[] {
    const resolved: ResolvedNavItem[] = [];
    for (const item of list) {
      let url = item.url ?? "#";
      let label = item.label;
      const type = item.type ?? (item.contentId ? "page" : "custom");
      const linked = { type, contentId: item.contentId };

      if (isContentLinkedMenuItem(linked)) {
        const content = contentMap.get(linked.contentId);
        if (content) {
          url = resolveContentUrl(content);
          if (!label) {
            const translated = content.translationGroupId
              ? translationMap.get(content.translationGroupId)
              : undefined;
            label = translated?.title ?? content.title;
          }
        } else if (item.url) {
          url = localizePublicPath(item.url, locale, defaultLocale, activeLocales);
        } else {
          url = "#";
        }
      } else if (type === "custom") {
        url = localizePublicPath(sanitizeNavUrl(item.url), locale, defaultLocale, activeLocales);
      }

      url = sanitizeNavUrl(url);

      if (!label?.trim()) continue;

      const navItem: ResolvedNavItem = {
        id: item.id,
        label: label.trim(),
        url,
        ...(item.target === "_blank" ? { target: "_blank" } : {}),
      };

      if (item.children?.length) {
        const children = resolveList(item.children);
        if (children.length) navItem.children = children;
      }

      resolved.push(navItem);
    }
    return resolved;
  }

  return resolveList(items);
}

export async function getNavItemsForMenuSlug(
  menuSlug: string | null | undefined,
  locale: string,
  defaultLocale: string,
  preview = false,
): Promise<ResolvedNavItem[]> {
  if (!menuSlug) return [];

  const siteId = await getSiteId();
  if (!siteId) return [];

  const menu = await getMenuBySlug(siteId, menuSlug);
  if (!menu?.items.length) return [];

  return resolveMenuItems(menu.items, locale, defaultLocale, preview);
}

/** @deprecated Use theme mods navigation.headerMenu via getNavItemsForMenuSlug */
export async function getPrimaryNavItems(
  locale: string,
  defaultLocale: string,
): Promise<ResolvedNavItem[]> {
  return getNavItemsForMenuSlug(PRIMARY_MENU_SLUG, locale, defaultLocale);
}
