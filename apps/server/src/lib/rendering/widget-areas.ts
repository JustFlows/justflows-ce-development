// SPDX-License-Identifier: MIT

import { esc, sanitizeBlockDocument } from "@justflows/blocks";
import type { WidgetAreaDefinition, WidgetAreaPosition } from "@justflows/sdk";
import { ensurePluginRuntime, getRuntimeHooks } from "../plugins/plugin-runtime.js";
import { getActiveTheme, themeInstalledPath } from "../themes/themes-db.js";
import { loadThemeWidgetAreas, loadThemeWidgetDefault } from "../themes/theme-files.js";
import {
  clearTemplatePartDraftDoc,
  getTemplatePartDocs,
  publishTemplatePartDoc,
  saveTemplatePartDraft,
  saveTemplatePartPublished,
} from "./template-parts-db.js";
import type { BlockNode } from "../runtime/types.js";

/**
 * Widget areas: named slots of blocks (a sidebar, a shop filter column) that
 * the site owner fills once and the site shows next to the page content.
 *
 * - Which areas exist is site-global: the core `sidebar`, the areas the active
 *   theme declares (`justflows-theme.json` → `widgetAreas`), and the areas
 *   active plugins add through the `widgets.areas` filter.
 * - An area's blocks live in `template_parts` as `widgets:<key>`, with the
 *   same published/draft pair as the footer. The document holds base blocks
 *   plus sparse per-locale overrides; a locale without one shows the base.
 * - Which area a content type shows, and on which side, is the site's widget
 *   layout (`template_parts` row `widget-layout`). A type with no saved rule
 *   falls back to an area's `defaultLayout`.
 */

export const WIDGET_AREA_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const WIDGET_AREA_POSITIONS: readonly WidgetAreaPosition[] = ["left", "right", "top"];
export const WIDGET_AREA_BLOCK_TYPE = "core.widget-area";

const PART_PREFIX = "widgets:";
const LAYOUT_PART = "widget-layout";
const CONTENT_TYPE_RE = /^[a-z][a-z0-9_-]{0,59}$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const MAX_LOCALES = 64;

export type WidgetAreaSource = "core" | "theme" | "plugin";

export interface WidgetArea {
  key: string;
  label: string;
  description?: string;
  source: WidgetAreaSource;
  defaultBlocks: BlockNode[];
  defaultLayout?: { contentTypes: string[]; position: WidgetAreaPosition };
}

/** Stored shape of one area: base blocks plus sparse per-locale overrides. */
export interface WidgetAreaDoc {
  version: 1;
  blocks: BlockNode[];
  locales: Record<string, BlockNode[]>;
}

/** One content type's widget layout. `area: null` means "no widget area". */
export interface WidgetLayoutRule {
  area: string | null;
  position: WidgetAreaPosition;
}

const CORE_SIDEBAR: WidgetAreaDefinition = {
  key: "sidebar",
  label: "Sidebar",
  description: "The main sidebar. Assign it to content types under Layout.",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanBlocks(raw: unknown): BlockNode[] {
  if (!Array.isArray(raw)) return [];
  return sanitizeBlockDocument({ version: 1, blocks: raw }).blocks as BlockNode[];
}

function isPosition(value: unknown): value is WidgetAreaPosition {
  return WIDGET_AREA_POSITIONS.includes(value as WidgetAreaPosition);
}

function cleanArea(raw: unknown, source: WidgetAreaSource): WidgetArea | null {
  const row = record(raw);
  if (!row) return null;
  const key = typeof row.key === "string" ? row.key : "";
  const label = typeof row.label === "string" ? row.label.trim().slice(0, 80) : "";
  if (!WIDGET_AREA_KEY_RE.test(key) || !label) return null;
  const description = typeof row.description === "string" ? row.description.trim().slice(0, 300) : "";
  const area: WidgetArea = { key, label, source, defaultBlocks: cleanBlocks(row.defaultBlocks) };
  if (description) area.description = description;
  const layout = record(row.defaultLayout);
  if (layout && isPosition(layout.position) && Array.isArray(layout.contentTypes)) {
    const contentTypes = layout.contentTypes.filter(
      (type): type is string => typeof type === "string" && CONTENT_TYPE_RE.test(type),
    );
    if (contentTypes.length) area.defaultLayout = { contentTypes, position: layout.position };
  }
  return area;
}

/**
 * Every widget area this site offers, in order: core, theme, then plugins. A
 * theme may relabel the core `sidebar` by declaring the same key.
 */
export async function listWidgetAreas(siteId: string): Promise<WidgetArea[]> {
  const theme = await getActiveTheme(siteId);
  const themeId = theme?.theme_id ?? "justflows.default";
  const installedPath = theme ? themeInstalledPath(theme) : null;

  const seed: WidgetAreaDefinition[] = [{ ...CORE_SIDEBAR }];
  for (const area of loadThemeWidgetAreas(themeId, installedPath)) {
    const existing = seed.find((row) => row.key === area.key);
    if (existing) Object.assign(existing, area);
    else seed.push({ ...area });
  }
  for (const area of seed) {
    const defaults = loadThemeWidgetDefault(themeId, area.key, installedPath);
    if (defaults) area.defaultBlocks = defaults;
  }
  const seeded = new Set(seed.map((row) => row.key));

  await ensurePluginRuntime();
  const raw = await getRuntimeHooks().applyFilter(
    "widgets.areas",
    seed,
    { siteId },
    { siteId, source: "http" },
  );
  const list = Array.isArray(raw) ? raw : seed;

  const seen = new Set<string>();
  const areas: WidgetArea[] = [];
  for (const item of list) {
    const key = record(item)?.key;
    const source: WidgetAreaSource =
      typeof key === "string" && seeded.has(key) ? (key === CORE_SIDEBAR.key ? "core" : "theme") : "plugin";
    const area = cleanArea(item, source);
    if (!area || seen.has(area.key)) continue;
    seen.add(area.key);
    areas.push(area);
  }
  return areas;
}

/* ------------------------------ area content ----------------------------- */

function partKey(key: string): string {
  if (!WIDGET_AREA_KEY_RE.test(key)) throw new Error("Invalid widget area key");
  return `${PART_PREFIX}${key}`;
}

/** Normalise a stored or submitted area document. Unknown locales and bad blocks are dropped. */
export function normalizeWidgetAreaDoc(raw: unknown): WidgetAreaDoc {
  const row = record(raw) ?? {};
  const locales: Record<string, BlockNode[]> = {};
  const rawLocales = record(row.locales);
  if (rawLocales) {
    for (const [code, blocks] of Object.entries(rawLocales).slice(0, MAX_LOCALES)) {
      if (!LOCALE_RE.test(code) || !Array.isArray(blocks)) continue;
      locales[code] = cleanBlocks(blocks);
    }
  }
  return { version: 1, blocks: cleanBlocks(row.blocks), locales };
}

/** The published and draft documents of one area; `null` when never saved. */
export async function getWidgetAreaDocs(
  siteId: string,
  key: string,
): Promise<{ doc: WidgetAreaDoc | null; draft: WidgetAreaDoc | null }> {
  const { doc, draft } = await getTemplatePartDocs<unknown>(siteId, partKey(key));
  // An upsert that only wrote a draft leaves `doc` as `{}`: not saved yet.
  const saved = record(doc) && Array.isArray(record(doc)?.blocks) ? normalizeWidgetAreaDoc(doc) : null;
  return { doc: saved, draft: draft ? normalizeWidgetAreaDoc(draft) : null };
}

export async function saveWidgetAreaDoc(
  siteId: string,
  key: string,
  raw: unknown,
  mode: "draft" | "publish",
): Promise<WidgetAreaDoc> {
  const doc = normalizeWidgetAreaDoc(raw);
  if (mode === "draft") await saveTemplatePartDraft(siteId, partKey(key), doc);
  else await publishTemplatePartDoc(siteId, partKey(key), doc);
  return doc;
}

/** Seed a published area without touching a draft (used by first-run defaults). */
export async function seedWidgetAreaDoc(siteId: string, key: string, raw: unknown): Promise<void> {
  await saveTemplatePartPublished(siteId, partKey(key), normalizeWidgetAreaDoc(raw));
}

export async function clearWidgetAreaDraft(siteId: string, key: string): Promise<void> {
  await clearTemplatePartDraftDoc(siteId, partKey(key));
}

/** Blocks for one locale: the locale override, else the base blocks. */
export function widgetAreaBlocksForLocale(doc: WidgetAreaDoc, locale: string): BlockNode[] {
  return doc.locales[locale] ?? doc.blocks;
}

/**
 * The blocks an area renders for this request. Preview prefers the draft. An
 * area the owner never saved shows its theme or plugin default.
 */
export async function resolveWidgetAreaBlocks(
  siteId: string,
  area: WidgetArea,
  locale: string,
  preview = false,
): Promise<BlockNode[]> {
  const { doc, draft } = await getWidgetAreaDocs(siteId, area.key);
  const chosen = (preview ? draft : null) ?? doc;
  return chosen ? widgetAreaBlocksForLocale(chosen, locale) : area.defaultBlocks;
}

/* --------------------------------- layout -------------------------------- */

export function normalizeWidgetLayout(raw: unknown): Record<string, WidgetLayoutRule> {
  const types = record(record(raw)?.types) ?? {};
  const out: Record<string, WidgetLayoutRule> = {};
  for (const [type, value] of Object.entries(types)) {
    const row = record(value);
    if (!CONTENT_TYPE_RE.test(type) || !row) continue;
    const area = typeof row.area === "string" && WIDGET_AREA_KEY_RE.test(row.area) ? row.area : null;
    out[type] = { area, position: isPosition(row.position) ? row.position : "right" };
  }
  return out;
}

/** Saved per-content-type rules. Types without a rule use area defaults. */
export async function getWidgetLayout(siteId: string): Promise<Record<string, WidgetLayoutRule>> {
  const { doc } = await getTemplatePartDocs<unknown>(siteId, LAYOUT_PART);
  return normalizeWidgetLayout(doc);
}

export async function saveWidgetLayout(
  siteId: string,
  raw: unknown,
): Promise<Record<string, WidgetLayoutRule>> {
  const types = normalizeWidgetLayout({ types: raw });
  await saveTemplatePartPublished(siteId, LAYOUT_PART, { version: 1, types });
  return types;
}

/**
 * The area a content type shows: its saved rule, else the first area whose
 * `defaultLayout` lists the type. A rule naming an area that no longer exists
 * (its plugin was deactivated) shows nothing.
 */
export function layoutForContentType(
  type: string,
  areas: WidgetArea[],
  rules: Record<string, WidgetLayoutRule>,
): { area: WidgetArea; position: WidgetAreaPosition } | null {
  const rule = rules[type];
  if (rule) {
    const area = rule.area ? areas.find((row) => row.key === rule.area) : undefined;
    return area ? { area, position: rule.position } : null;
  }
  for (const area of areas) {
    if (area.defaultLayout?.contentTypes.includes(type)) {
      return { area, position: area.defaultLayout.position };
    }
  }
  return null;
}

/* -------------------------------- markup --------------------------------- */

/** One rendered area. Empty when the area has nothing to show. */
export function widgetAreaHtml(area: Pick<WidgetArea, "key" | "label">, innerHtml: string): string {
  if (!innerHtml.trim()) return "";
  return (
    `<aside class="jf-widget-area jf-widget-area--${esc(area.key)}" ` +
    `data-jf-widget-area="${esc(area.key)}" aria-label="${esc(area.label)}">${innerHtml}</aside>`
  );
}

/**
 * Page content with an area beside (or above) it. The content comes first in
 * the source so readers and keyboards reach it before the widgets; CSS places
 * the area. Without area markup the content is returned unchanged.
 */
export function withWidgetLayout(
  bodyHtml: string,
  position: WidgetAreaPosition,
  areaHtml: string,
): string {
  if (!areaHtml) return bodyHtml;
  return (
    `<div class="jf-widget-layout jf-widget-layout--${position}" data-jf-widget-position="${position}">` +
    `<div class="jf-widget-layout__main">${bodyHtml}</div>${areaHtml}</div>`
  );
}

/** True when a block tree already places a widget area itself. */
export function blocksPlaceWidgetArea(blocks: BlockNode[]): boolean {
  for (const block of blocks) {
    if (block.type === WIDGET_AREA_BLOCK_TYPE) return true;
    if (block.children?.length && blocksPlaceWidgetArea(block.children)) return true;
  }
  return false;
}

/* ------------------------------ admin views ------------------------------ */

export interface WidgetAreaSummary {
  key: string;
  label: string;
  description?: string;
  source: WidgetAreaSource;
  defaultLayout?: { contentTypes: string[]; position: WidgetAreaPosition };
  /** False while the area still shows its theme or plugin default. */
  saved: boolean;
  hasDraft: boolean;
}

/** Areas with their save state. One read per area; areas are a short list. */
export async function summarizeWidgetAreas(siteId: string): Promise<WidgetAreaSummary[]> {
  const areas = await listWidgetAreas(siteId);
  const docs = await Promise.all(areas.map((area) => getWidgetAreaDocs(siteId, area.key)));
  return areas.map((area, index) => ({
    key: area.key,
    label: area.label,
    ...(area.description ? { description: area.description } : {}),
    source: area.source,
    ...(area.defaultLayout ? { defaultLayout: area.defaultLayout } : {}),
    saved: docs[index]!.doc !== null,
    hasDraft: docs[index]!.draft !== null,
  }));
}

/**
 * One area for the editor: the published document (or the default the site
 * shows while it was never saved), and the draft when one exists. `null` when
 * the site offers no area with that key.
 */
export async function readWidgetAreaForEditor(
  siteId: string,
  key: string,
): Promise<{ area: WidgetAreaSummary; doc: WidgetAreaDoc; draft: WidgetAreaDoc | null; fromDefault: boolean } | null> {
  if (!WIDGET_AREA_KEY_RE.test(key)) return null;
  const area = (await listWidgetAreas(siteId)).find((row) => row.key === key);
  if (!area) return null;
  const { doc, draft } = await getWidgetAreaDocs(siteId, key);
  return {
    area: {
      key: area.key,
      label: area.label,
      ...(area.description ? { description: area.description } : {}),
      source: area.source,
      ...(area.defaultLayout ? { defaultLayout: area.defaultLayout } : {}),
      saved: doc !== null,
      hasDraft: draft !== null,
    },
    doc: doc ?? { version: 1, blocks: area.defaultBlocks, locales: {} },
    draft,
    fromDefault: doc === null,
  };
}

/** True when the site currently offers an area with this key. */
export async function widgetAreaExists(siteId: string, key: string): Promise<boolean> {
  if (!WIDGET_AREA_KEY_RE.test(key)) return false;
  return (await listWidgetAreas(siteId)).some((row) => row.key === key);
}

