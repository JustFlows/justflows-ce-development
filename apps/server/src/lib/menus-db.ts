import { contentPermalink } from "./permalinks-db.js";
import { serializeContentRow, type ContentResponse } from "./content-api.js";
/**
 * Data-access helpers for the menus table.
 */

import { randomUUID } from "node:crypto";
import { sanitizeBlockDocument } from "@justflows/blocks";
import {
  MENU_LAYOUTS,
  MENU_ACTIVATIONS,
  MENU_MOBILE_PATTERNS,
  MENU_MOBILE_MOTIONS,
  MENU_ALIGNMENTS,
  MEGA_MENU_SAFE_BLOCK_KINDS,
  type MenuLayout,
  type MenuActivation,
  type MenuMobilePattern,
  type MenuMobileMotion,
  type MenuAlignment,
  type MenuDesignSeed,
} from "@justflows/sdk";
import { getDb } from "./db.js";
import { localizePublicPath } from "./i18n/locales.js";
import { getActiveLocaleCodes } from "./i18n/languages-db.js";
import { getSiteId } from "./themes-db.js";
import { sanitizeNavUrl } from "./nav-url.js";
import type { UserRole } from "./rbac.js";
import type { BlockNode } from "./types.js";

export type MenuItemType = string;

// ---------------------------------------------------------------------------
// Menu design (layout/presentation contract)
// ---------------------------------------------------------------------------

// The menu design enums and the mega-menu safe-kind allowlist are the public
// plugin/theme contract — sourced from `@justflows/sdk` and re-exported here so
// this module stays the one import site for menu internals, and neither the
// designer's own validation nor the host sanitizer can drift from what the SDK
// documents to extension authors. The design-value semantics are:
//
//  mobilePattern (how the menu presents below `breakpoint`):
//   - `dropdown`     — full-width panel dropped under the header bar
//   - `accordion`    — the list expands inline in normal flow, no overlay
//   - `drawer-right` — off-canvas sheet sliding in from the right, with a backdrop
//   - `drawer-left`  — off-canvas sheet sliding in from the left, with a backdrop
//   - `fullscreen`   — panel covers the whole viewport over the page
//   The legacy value `"drawer"` is migrated to `"drawer-right"` on read.
//
//  mobileMotion (enter/exit motion for the open mobile menu; `prefers-reduced-motion`
//  forces `none` at render time regardless):
//   - `slide` — the panel slides in from its edge (drawers) or down (dropdown/fullscreen)
//   - `fade`  — cross-fades in place, no movement
//   - `none`  — appears instantly
export {
  MENU_LAYOUTS,
  MENU_ACTIVATIONS,
  MENU_MOBILE_PATTERNS,
  MENU_MOBILE_MOTIONS,
  MENU_ALIGNMENTS,
  MEGA_MENU_SAFE_BLOCK_KINDS,
};
export type {
  MenuLayout,
  MenuActivation,
  MenuMobilePattern,
  MenuMobileMotion,
  MenuAlignment,
};

/** Tolerant read of a stored/legacy mobile-pattern value. */
export function asMenuMobilePattern(value: unknown): MenuMobilePattern {
  if (value === "drawer") return "drawer-right";
  return (MENU_MOBILE_PATTERNS as readonly string[]).includes(value as string)
    ? (value as MenuMobilePattern)
    : DEFAULT_MENU_DESIGN.mobilePattern;
}

export const MENU_MOTION_MIN_MS = 120;
export const MENU_MOTION_MAX_MS = 800;

export function asMenuMobileMotion(value: unknown): MenuMobileMotion {
  return (MENU_MOBILE_MOTIONS as readonly string[]).includes(value as string)
    ? (value as MenuMobileMotion)
    : DEFAULT_MENU_DESIGN.mobileMotion;
}

export function asMenuMotionMs(value: unknown): number {
  return Number.isFinite(value)
    ? Math.min(MENU_MOTION_MAX_MS, Math.max(MENU_MOTION_MIN_MS, Math.round(Number(value))))
    : DEFAULT_MENU_DESIGN.mobileMotionMs;
}

/**
 * The stored menu design. Extends the SDK's `MenuDesignSeed` (the exact shape a
 * plugin/theme preset supplies) with `presetId`, which the host assigns — so a
 * hand-edited design and a preset-seeded one are the same type, and the SDK
 * contract can never document a field the host does not honour.
 */
export interface MenuDesign extends Required<MenuDesignSeed> {
  /** Built-in preset id this design was seeded from, "" once hand-edited. */
  presetId: string;
}

/** Hard ceiling regardless of what a design config requests — defends resolution/rendering cost. */
export const MENU_HARD_MAX_DEPTH = 4;
export const MENU_HARD_MAX_ITEMS_PER_LEVEL = 40;

export const DEFAULT_MENU_DESIGN: MenuDesign = {
  layout: "horizontal",
  activation: "hover",
  breakpoint: 768,
  mobilePattern: "drawer-right",
  mobileMotion: "slide",
  mobileMotionMs: 240,
  alignment: "start",
  maxDepth: 3,
  maxItemsPerLevel: 20,
  presetId: "",
};

function isMenuLayout(value: unknown): value is MenuLayout {
  return typeof value === "string" && (MENU_LAYOUTS as readonly string[]).includes(value);
}

function isMenuActivation(value: unknown): value is MenuActivation {
  return typeof value === "string" && (MENU_ACTIVATIONS as readonly string[]).includes(value);
}

/** Tolerant JSON→`MenuDesign`: an empty/malformed value yields sane defaults, same posture as `parseItems`. */
export function parseMenuDesign(raw: unknown): MenuDesign {
  let parsed: unknown = raw;
  if (Buffer.isBuffer(raw)) {
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      parsed = null;
    }
  } else if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_MENU_DESIGN };
  const src = parsed as Record<string, unknown>;

  const maxDepth = Math.min(
    MENU_HARD_MAX_DEPTH,
    Math.max(1, Number.isFinite(src.maxDepth) ? Number(src.maxDepth) : DEFAULT_MENU_DESIGN.maxDepth),
  );
  const maxItemsPerLevel = Math.min(
    MENU_HARD_MAX_ITEMS_PER_LEVEL,
    Math.max(
      1,
      Number.isFinite(src.maxItemsPerLevel)
        ? Number(src.maxItemsPerLevel)
        : DEFAULT_MENU_DESIGN.maxItemsPerLevel,
    ),
  );
  const breakpoint = Number.isFinite(src.breakpoint)
    ? Math.min(1400, Math.max(320, Number(src.breakpoint)))
    : DEFAULT_MENU_DESIGN.breakpoint;

  return {
    layout: isMenuLayout(src.layout) ? src.layout : DEFAULT_MENU_DESIGN.layout,
    activation: isMenuActivation(src.activation) ? src.activation : DEFAULT_MENU_DESIGN.activation,
    breakpoint,
    mobilePattern: asMenuMobilePattern(src.mobilePattern),
    mobileMotion: asMenuMobileMotion(src.mobileMotion),
    mobileMotionMs: asMenuMotionMs(src.mobileMotionMs),
    alignment: (MENU_ALIGNMENTS as readonly string[]).includes(src.alignment as string)
      ? (src.alignment as MenuAlignment)
      : DEFAULT_MENU_DESIGN.alignment,
    maxDepth,
    maxItemsPerLevel,
    presetId: typeof src.presetId === "string" ? src.presetId.slice(0, 80) : "",
  };
}

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

export interface MenuItemVisibility {
  /** "any" (default, no gate) | require a signed-out or signed-in visitor. */
  auth?: "any" | "guest" | "authenticated";
  /** Any of these roles may see the item; empty/absent = no role gate. */
  roles?: UserRole[];
  /** Any of these locale codes; empty/absent = every locale. */
  locales?: string[];
  /** Presentation-only hint (not server-enforced, see resolveMenuItems). */
  devices?: Array<"desktop" | "tablet" | "mobile">;
  /** A plugin-provided condition, evaluated via the `menu.visibility.evaluate` filter. */
  condition?: { id: string; params?: Record<string, unknown> };
}

export interface MenuItemDropdown {
  trigger?: MenuActivation;
  align?: "start" | "center" | "end";
  width?: "auto" | "menu" | "viewport" | number;
  maxWidth?: number;
  columns?: number;
  /** px nudge of the open panel from its anchored position; positive = right / down, negative = left / up. */
  offsetX?: number;
  offsetY?: number;
  /** The parent link is a disclosure trigger only; it does not navigate. */
  disableParentLink?: boolean;
}

export interface MegaMenuRegion {
  id: string;
  heading?: string;
  /** Column span within the mega panel's CSS grid. */
  span?: number;
  blocks: BlockNode[];
}

export interface MenuItemBadge {
  text: string;
  tone?: "info" | "success" | "warning" | "danger";
}

/**
 * Per-item styling for a `button*` style preset — emitted as `--jf-navbtn-*`
 * custom properties + size/full classes on the link, so the theme's preset
 * rules pick them up. Colours are validated as safe CSS colour values on write.
 */
export interface MenuButtonStyle {
  bg?: string;
  fg?: string;
  border?: string;
  /** Border thickness in px (0-8). A colour with no width defaults to 1.5px. */
  borderWidth?: number;
  radius?: number;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
}

export interface MenuItem {
  id: string;
  label: string;
  type: MenuItemType;
  url?: string;
  contentId?: string;
  target?: "_blank";
  /** Extra `rel` tokens the author asked for (sponsored/nofollow/ugc/external); safety tokens are always added on top. */
  rel?: string;
  titleAttr?: string;
  /** CSS-safe style preset name (a class-name-shaped token, not raw CSS). */
  stylePreset?: string;
  /** Fine styling for a `button*` preset (colours/radius/size/full-width). */
  buttonStyle?: MenuButtonStyle;
  icon?: string;
  image?: string;
  badge?: MenuItemBadge;
  description?: string;
  visibility?: MenuItemVisibility;
  dropdown?: MenuItemDropdown;
  megaMenu?: { regions: MegaMenuRegion[] };
  children?: MenuItem[];
}

export interface MenuRow {
  id: string;
  site_id: string;
  slug: string;
  name: string;
  items: MenuItem[];
  design: MenuDesign;
  schemaVersion: number;
  draftItems: MenuItem[] | null;
  draftDesign: MenuDesign | null;
}

export interface ResolvedNavItem {
  id: string;
  label: string;
  url: string;
  target?: string;
  rel?: string;
  titleAttr?: string;
  stylePreset?: string;
  buttonStyle?: MenuButtonStyle;
  icon?: string;
  image?: string;
  badge?: MenuItemBadge;
  description?: string;
  disableLink?: boolean;
  /** Present only when the author restricted the item to a proper subset of device buckets (CSS hides it elsewhere). */
  devices?: Array<"desktop" | "tablet" | "mobile">;
  dropdown?: MenuItemDropdown;
  /** Sanitized block JSON for the mega-menu panel; rendered to HTML by the caller (see `renderMegaMenuRegions`). */
  megaMenu?: { regions: MegaMenuRegion[] };
  children?: ResolvedNavItem[];
}

/** Who is asking, for the server-enforced (security-sensitive) visibility checks. */
export interface MenuVisibilityContext {
  authState: "guest" | "authenticated";
  role?: string;
}

export const PRIMARY_MENU_SLUG = "primary";

// `MEGA_MENU_SAFE_BLOCK_KINDS` (imported from `@justflows/sdk`, re-exported at
// the top of this module) is the fixed subset of `@justflows/blocks` core kinds
// a mega-menu region may contain. It deliberately excludes
// `core.html`/`core.code`/`core.embed` even though the sanitizer would clean
// them — menu content must never carry arbitrary scripts or raw HTML, not
// merely sanitized versions of them.
const MEGA_MENU_SAFE_BLOCK_KIND_SET = new Set<string>(MEGA_MENU_SAFE_BLOCK_KINDS);
const MAX_MEGA_REGIONS = 6;
const MAX_MEGA_BLOCKS_PER_REGION = 30;
const REL_TOKEN_ALLOWLIST = new Set(["nofollow", "sponsored", "ugc", "external"]);

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

function parseNullableItems(raw: unknown): MenuItem[] | null {
  if (raw == null) return null;
  const items = parseItems(raw);
  return items.length || (typeof raw === "string" && raw !== "" && raw !== "null") ? items : null;
}

function parseNullableDesign(raw: unknown): MenuDesign | null {
  if (raw == null) return null;
  if (typeof raw === "string" && (raw === "" || raw === "null")) return null;
  return parseMenuDesign(raw);
}

function parseMenuRow(row: Record<string, unknown>): MenuRow {
  return {
    id: String(row.id),
    site_id: String(row.site_id),
    slug: String(row.slug),
    name: String(row.name),
    items: parseItems(row.items),
    design: parseMenuDesign(row.design),
    schemaVersion: Number(row.schema_version ?? 1) || 1,
    draftItems: parseNullableItems(row.draft_items),
    draftDesign: parseNullableDesign(row.draft_design),
  };
}

/** `preview` prefers the working draft when one exists; publishing clears it (see `updateMenu`). */
export function getEffectiveMenuItems(menu: MenuRow, preview: boolean): MenuItem[] {
  return preview && menu.draftItems ? menu.draftItems : menu.items;
}

export function getEffectiveMenuDesign(menu: MenuRow, preview: boolean): MenuDesign {
  return preview && menu.draftDesign ? menu.draftDesign : menu.design;
}

export async function ensureDefaultMenu(siteId: string): Promise<void> {
  const db = await getDb();
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM menus WHERE site_id = ? AND slug = ? LIMIT 1",
    [siteId, PRIMARY_MENU_SLUG],
  );
  if (existing[0]) return;

  await db.run("INSERT INTO menus (id, site_id, slug, name, items) VALUES (?, ?, ?, ?, ?)", [
    randomUUID(),
    siteId,
    PRIMARY_MENU_SLUG,
    "Primary Menu",
    "[]",
  ]);
}

export async function listMenus(siteId: string): Promise<MenuRow[]> {
  await ensureDefaultMenu(siteId);
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM menus WHERE site_id = ? AND trashed_at IS NULL ORDER BY name ASC",
    [siteId],
  );
  return rows.map(parseMenuRow);
}

export async function getMenuBySlug(siteId: string, slug: string): Promise<MenuRow | null> {
  await ensureDefaultMenu(siteId);
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM menus WHERE site_id = ? AND slug = ? AND trashed_at IS NULL LIMIT 1",
    [siteId, slug],
  );
  return rows[0] ? parseMenuRow(rows[0]) : null;
}

export async function createMenu(siteId: string, slug: string, name: string): Promise<MenuRow> {
  const db = await getDb();
  const id = randomUUID();
  await db.run("INSERT INTO menus (id, site_id, slug, name, items) VALUES (?, ?, ?, ?, ?)", [
    id,
    siteId,
    slug,
    name,
    "[]",
  ]);
  return {
    id,
    site_id: siteId,
    slug,
    name,
    items: [],
    design: { ...DEFAULT_MENU_DESIGN },
    schemaVersion: 1,
    draftItems: null,
    draftDesign: null,
  };
}

export interface UpdateMenuInput {
  name?: string;
  items?: MenuItem[];
  design?: MenuDesign;
  /** true = write the working draft only (admin preview); false/absent = publish. */
  draft?: boolean;
}

export async function updateMenu(
  siteId: string,
  slug: string,
  data: UpdateMenuInput,
): Promise<MenuRow | null> {
  const menu = await getMenuBySlug(siteId, slug);
  if (!menu) return null;

  const db = await getDb();
  const name = data.name ?? menu.name;

  if (data.draft) {
    const draftItems = data.items ?? menu.draftItems ?? menu.items;
    const draftDesign = data.design ?? menu.draftDesign ?? menu.design;
    await db.run(
      "UPDATE menus SET name = ?, draft_items = ?, draft_design = ? WHERE site_id = ? AND slug = ?",
      [name, JSON.stringify(draftItems), JSON.stringify(draftDesign), siteId, slug],
    );
    return { ...menu, name, draftItems, draftDesign };
  }

  const items = data.items ?? getEffectiveMenuItems(menu, true);
  const design = data.design ?? getEffectiveMenuDesign(menu, true);
  await db.run(
    "UPDATE menus SET name = ?, items = ?, design = ?, draft_items = NULL, draft_design = NULL WHERE site_id = ? AND slug = ?",
    [name, JSON.stringify(items), JSON.stringify(design), siteId, slug],
  );
  return { ...menu, name, items, design, draftItems: null, draftDesign: null };
}

export async function deleteMenu(siteId: string, slug: string, userId?: string): Promise<boolean> {
  if (slug === PRIMARY_MENU_SLUG) return false;
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    "SELECT id FROM menus WHERE site_id = ? AND slug = ? AND trashed_at IS NULL LIMIT 1",
    [siteId, slug],
  );
  if (!rows[0]) return false;
  const trashedSlug = `menu-trash-${rows[0].id}`;
  await db.run(
    "UPDATE menus SET original_slug = slug, slug = ?, trashed_at = CURRENT_TIMESTAMP, trashed_by = ? WHERE site_id = ? AND slug = ?",
    [trashedSlug, userId ?? null, siteId, slug],
  );
  return true;
}

// ---------------------------------------------------------------------------
// Tree-shape validation (write path only — resolution below must never throw)
// ---------------------------------------------------------------------------

export class MenuTreeShapeError extends Error {}

export function validateMenuTreeShape(items: MenuItem[], design: MenuDesign): void {
  const maxDepth = Math.min(design.maxDepth, MENU_HARD_MAX_DEPTH);
  const maxItemsPerLevel = Math.min(design.maxItemsPerLevel, MENU_HARD_MAX_ITEMS_PER_LEVEL);

  function walk(level: MenuItem[], depth: number): void {
    if (level.length > maxItemsPerLevel) {
      throw new MenuTreeShapeError(`Too many items at depth ${depth} (max ${maxItemsPerLevel})`);
    }
    if (depth > maxDepth) {
      throw new MenuTreeShapeError(`Menu nesting exceeds the configured depth limit (max ${maxDepth})`);
    }
    for (const item of level) {
      if (item.children?.length) walk(item.children, depth + 1);
    }
  }

  walk(items, 1);
}

// ---------------------------------------------------------------------------
// Mega-menu region sanitization
// ---------------------------------------------------------------------------

/** Nesting cap for a mega-menu region's block tree — matches `validateMenuTreeShape`'s
 * posture of an explicit bound rather than trusting an upstream pass to stay bounded. */
const MEGA_MENU_MAX_BLOCK_DEPTH = 8;

function filterAllowedBlocks(nodes: unknown[], depth = 0): BlockNode[] {
  if (depth >= MEGA_MENU_MAX_BLOCK_DEPTH) return [];
  const out: BlockNode[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as BlockNode;
    if (typeof node.type !== "string" || !MEGA_MENU_SAFE_BLOCK_KIND_SET.has(node.type)) continue;
    const children = Array.isArray(node.children)
      ? filterAllowedBlocks(node.children, depth + 1)
      : undefined;
    out.push(children?.length ? { ...node, children } : { ...node, children: undefined });
  }
  return out;
}

/** Sanitize + type-allowlist a mega-menu region's block content before it is persisted. */
export function sanitizeMegaMenuRegions(raw: unknown): MegaMenuRegion[] {
  if (!Array.isArray(raw)) return [];
  const regions: MegaMenuRegion[] = [];
  for (const entry of raw.slice(0, MAX_MEGA_REGIONS)) {
    if (!entry || typeof entry !== "object") continue;
    const region = entry as Record<string, unknown>;
    const id = typeof region.id === "string" && region.id ? region.id : randomUUID();
    const heading = typeof region.heading === "string" ? region.heading.slice(0, 200) : undefined;
    const span = Number.isFinite(region.span)
      ? Math.min(12, Math.max(1, Math.trunc(Number(region.span))))
      : undefined;
    const sanitizedDoc = sanitizeBlockDocument({
      version: 1,
      blocks: Array.isArray(region.blocks) ? region.blocks.slice(0, MAX_MEGA_BLOCKS_PER_REGION) : [],
    });
    const blocks = filterAllowedBlocks(sanitizedDoc.blocks);
    regions.push({ id, ...(heading ? { heading } : {}), ...(span ? { span } : {}), blocks });
  }
  return regions;
}

function sanitizeRelTokens(rel: unknown): string | undefined {
  if (typeof rel !== "string") return undefined;
  const tokens = rel
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => REL_TOKEN_ALLOWLIST.has(t));
  return tokens.length ? [...new Set(tokens)].join(" ") : undefined;
}

/** `target="_blank"` always gets `noopener noreferrer`; author-chosen `rel` tokens ride along, never replace it. */
function composeRel(item: Pick<MenuItem, "target" | "rel">): string | undefined {
  const extra = sanitizeRelTokens(item.rel);
  if (item.target === "_blank") {
    return extra ? `noopener noreferrer ${extra}` : "noopener noreferrer";
  }
  return extra;
}

type MenuContentRef = ContentResponse;

async function loadContentByIds(
  ids: string[],
  preview = false,
): Promise<Map<string, MenuContentRef>> {
  const map = new Map<string, MenuContentRef>();
  if (ids.length === 0) return map;

  const db = await getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const statusClause = preview ? "status IN ('published', 'draft')" : "status = 'published'";
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM content WHERE id IN (${placeholders}) AND ${statusClause}`,
    ids,
  );

  for (const row of rows) {
    map.set(String(row.id), serializeContentRow(row));
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
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM content
     WHERE translation_group_id IN (${placeholders}) AND locale = ? AND ${statusClause}`,
    [...ids, locale],
  );

  for (const row of rows) {
    const groupId = row.translation_group_id == null ? null : String(row.translation_group_id);
    if (!groupId) continue;
    map.set(groupId, serializeContentRow(row));
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

/** CMS-backed menu items: any type except a custom URL, when a content id is actually set. */
export function isContentLinkedMenuItem(
  item: Pick<MenuItem, "type" | "contentId">,
): item is Pick<MenuItem, "type"> & { contentId: string } {
  return Boolean(item.contentId) && item.type !== "custom";
}

/** Server-enforced (security-sensitive) visibility checks: auth state, role, locale, and a plugin condition.
 * Device targeting is presentation-only (no reliable server-side device signal) and is left to the caller/CSS. */
async function isItemVisible(
  item: MenuItem,
  locale: string,
  context: MenuVisibilityContext,
  siteId: string | undefined,
): Promise<boolean> {
  const visibility = item.visibility;
  if (!visibility) return true;

  if (visibility.auth === "guest" && context.authState !== "guest") return false;
  if (visibility.auth === "authenticated" && context.authState !== "authenticated") return false;

  if (visibility.roles?.length) {
    if (context.authState !== "authenticated" || !context.role) return false;
    if (!visibility.roles.includes(context.role as UserRole)) return false;
  }

  if (visibility.locales?.length && !visibility.locales.includes(locale)) return false;

  if (visibility.condition?.id) {
    try {
      const { ensurePluginRuntime, getRuntimeHooks } = await import("./plugin-runtime.js");
      await ensurePluginRuntime();
      const hooks = getRuntimeHooks();
      if (!hooks.has("menu.visibility.evaluate")) return false; // deny-by-default: unrecognized condition
      const allowed = await hooks.applyFilter(
        "menu.visibility.evaluate",
        false,
        { item, condition: visibility.condition, context: { ...context, locale } },
        { siteId: siteId ?? "", source: "http" },
      );
      if (!allowed) return false;
    } catch {
      return false; // fail closed
    }
  }

  return true;
}

export interface ResolveMenuItemsOptions {
  siteId?: string;
  visibility?: MenuVisibilityContext;
}

export async function resolveMenuItems(
  items: MenuItem[],
  locale: string,
  defaultLocale: string,
  preview = false,
  options: ResolveMenuItemsOptions = {},
): Promise<ResolvedNavItem[]> {
  const visibilityContext: MenuVisibilityContext = options.visibility ?? { authState: "guest" };
  const contentIds = collectContentIds(items);
  const contentMap = await loadContentByIds(contentIds, preview);
  const translationMap = await loadTranslationsByGroup(
    [...contentMap.values()].map((item) => item.translationGroupId ?? ""),
    locale,
    preview,
  );
  const activeLocales = await getActiveLocaleCodes();

  async function resolveContentUrl(content: MenuContentRef): Promise<string> {
    const translated =
      content.locale === locale
        ? content
        : content.translationGroupId
          ? translationMap.get(content.translationGroupId)
          : undefined;
    return contentPermalink(translated ?? content);
  }

  async function resolveList(list: MenuItem[]): Promise<ResolvedNavItem[]> {
    const resolved: ResolvedNavItem[] = [];
    for (const item of list) {
      if (!(await isItemVisible(item, locale, visibilityContext, options.siteId))) continue;

      let url = item.url ?? "#";
      let label = item.label;
      const type = item.type ?? (item.contentId ? "page" : "custom");
      const linked = { type, contentId: item.contentId };

      if (isContentLinkedMenuItem(linked)) {
        const content = contentMap.get(linked.contentId);
        if (content) {
          url = await resolveContentUrl(content);
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
      } else if (item.url) {
        // Custom links and other author-provided-URL types (search, account, ...) resolve the same way.
        url = localizePublicPath(sanitizeNavUrl(item.url), locale, defaultLocale, activeLocales);
      }

      url = sanitizeNavUrl(url);

      if (!label?.trim()) continue;

      const rel = composeRel(item);
      const navItem: ResolvedNavItem = {
        id: item.id,
        label: label.trim(),
        url,
        ...(item.target === "_blank" ? { target: "_blank" } : {}),
        ...(rel ? { rel } : {}),
        ...(item.titleAttr ? { titleAttr: item.titleAttr } : {}),
        ...(item.stylePreset ? { stylePreset: item.stylePreset } : {}),
        ...(item.buttonStyle && Object.keys(item.buttonStyle).length ? { buttonStyle: item.buttonStyle } : {}),
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.image ? { image: item.image } : {}),
        ...(item.badge ? { badge: item.badge } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.dropdown ? { dropdown: item.dropdown } : {}),
        ...(item.dropdown?.disableParentLink ? { disableLink: true } : {}),
        ...(() => {
          const d = item.visibility?.devices?.filter((x) => x === "desktop" || x === "tablet" || x === "mobile");
          return d && d.length > 0 && d.length < 3 ? { devices: d } : {};
        })(),
        ...(item.megaMenu?.regions?.length ? { megaMenu: { regions: item.megaMenu.regions } } : {}),
      };

      if (item.children?.length) {
        const children = await resolveList(item.children);
        if (children.length) navItem.children = children;
      }

      resolved.push(navItem);
    }
    return resolved;
  }

  return resolveList(items);
}

/** True when any item in the tree carries a role/auth visibility gate — such a menu is not safe to cache
 * behind a single (locale-only) public cache key, so callers should bypass the cache for it entirely. */
export function menuHasVisibilityRules(items: MenuItem[]): boolean {
  return items.some((item) => {
    const v = item.visibility;
    if (v && (v.auth === "guest" || v.auth === "authenticated" || v.roles?.length || v.condition?.id)) {
      return true;
    }
    return item.children?.length ? menuHasVisibilityRules(item.children) : false;
  });
}

export async function getNavItemsForMenuSlug(
  menuSlug: string | null | undefined,
  locale: string,
  defaultLocale: string,
  preview = false,
  visibility?: MenuVisibilityContext,
): Promise<ResolvedNavItem[]> {
  if (!menuSlug) return [];

  const siteId = await getSiteId();
  if (!siteId) return [];

  const menu = await getMenuBySlug(siteId, menuSlug);
  const items = menu ? getEffectiveMenuItems(menu, preview) : [];
  if (!items.length) return [];

  let resolved = await resolveMenuItems(items, locale, defaultLocale, preview, { siteId, visibility });

  try {
    const { ensurePluginRuntime, getRuntimeHooks } = await import("./plugin-runtime.js");
    await ensurePluginRuntime();
    const hooks = getRuntimeHooks();
    if (hooks.has("navigation.items")) {
      resolved = (await hooks.applyFilter(
        "navigation.items",
        resolved,
        { siteId, location: menuSlug },
        { siteId, source: "http" },
      )) as ResolvedNavItem[];
    }
  } catch {
    // A plugin filter failing must never take the site's navigation down.
  }

  return resolved;
}

/** @deprecated Use theme mods navigation.headerMenu via getNavItemsForMenuSlug */
export async function getPrimaryNavItems(
  locale: string,
  defaultLocale: string,
): Promise<ResolvedNavItem[]> {
  return getNavItemsForMenuSlug(PRIMARY_MENU_SLUG, locale, defaultLocale);
}
