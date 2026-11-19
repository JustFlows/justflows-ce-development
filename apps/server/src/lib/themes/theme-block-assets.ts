// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import fs from "node:fs";
import { isMarkableBlockType, markBlockTypes } from "@justflows/blocks";
import { safeAssetRel } from "../plugins/plugin-assets.js";
import { pageAssetTags, readMarkupAssets, readPerPageStyles } from "../rendering/block-assets.js";
import { resolvePathUnderBase } from "../security/safe-path.js";
import { openNoFollowSync } from "../security/open-no-follow.js";
import { readThemeBlockAssetsSpec, resolveThemeDir } from "./theme-files.js";
import { getActiveTheme, getSiteId, themeInstalledPath } from "./themes-db.js";

/**
 * Per-page assets of the active theme: `assets.blocks` in
 * `justflows-theme.json` maps any block type, core or plugin, and
 * `assets.markup` lists selectors, to scripts and stylesheets (relative to the
 * theme folder) that only pages rendering that block or containing that
 * markup load, from `/theme-assets/<path>?v=<content hash>`. Only declared
 * files are served there; everything else in the theme folder stays private.
 */

const MAX_TYPES = 50;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 512 * 1024;
const TTL_MS = 15_000;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface ThemeBlockAssets {
  dir: string;
  blocks: Array<{ type: string; scripts: string[]; styles: string[] }>;
  markup: Array<{ match: string[]; scripts: string[]; styles: string[] }>;
  /** Content version of each declared file, by path relative to `dir`. */
  versions: Map<string, string>;
}

/** Hash of a regular, not-too-large file under `dir`, read without following a symlink; null otherwise. */
function fileVersion(dir: string, rel: string): string | null {
  const file = resolvePathUnderBase(dir, rel);
  if (!file) return null;
  try {
    const fd = openNoFollowSync(file, fs.constants.O_RDONLY);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      return createHash("sha256").update(fs.readFileSync(fd)).digest("hex").slice(0, 12);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Validate a theme's `assets.blocks` and `assets.markup`: safe block ids and selectors, existing safe files only. */
export function readThemeBlockAssets(dir: string, spec: unknown, markupSpec?: unknown): ThemeBlockAssets {
  const result: ThemeBlockAssets = { dir, blocks: [], markup: [], versions: new Map() };
  const pick = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const value of list.slice(0, MAX_FILES)) {
      const rel = safeAssetRel(value);
      if (!rel || out.includes(rel)) continue;
      const version = result.versions.get(rel) ?? fileVersion(dir, rel);
      if (!version) continue;
      result.versions.set(rel, version);
      out.push(rel);
    }
    return out;
  };
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    for (const [type, raw] of Object.entries(spec as Record<string, unknown>).slice(0, MAX_TYPES)) {
      if (!isMarkableBlockType(type) || !raw || typeof raw !== "object") continue;
      const entry = raw as { scripts?: unknown; styles?: unknown };
      const block = { type, scripts: pick(entry.scripts), styles: pick(entry.styles) };
      if (block.scripts.length || block.styles.length) result.blocks.push(block);
    }
  }
  result.markup = readMarkupAssets(markupSpec, pick);
  return result;
}

const memo = new Map<string, { at: number; value: ThemeBlockAssets | null }>();

/**
 * The active theme's per-block assets, or null when it declares none. Loading
 * them also asks the block renderer to mark those block types, so call this
 * before a page renders its blocks. Kept per site for a few seconds, like
 * plugin assets, and dropped when a theme is activated here.
 */
export async function activeThemeBlockAssets(): Promise<ThemeBlockAssets | null> {
  const siteId = await getSiteId();
  if (!siteId) return null;
  const cached = memo.get(siteId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const theme = await getActiveTheme(siteId);
  const dir = theme ? resolveThemeDir(theme.theme_id, themeInstalledPath(theme)) : null;
  const spec = dir ? readThemeBlockAssetsSpec(dir) : null;
  const assets = dir && spec ? readThemeBlockAssets(dir, spec.blocks, spec.markup) : null;
  const value = assets && (assets.blocks.length || assets.markup.length) ? assets : null;
  if (value) markBlockTypes(value.blocks.map((block) => block.type));
  memo.set(siteId, { at: Date.now(), value });
  return value;
}

/** Drop the memo — call after a theme is activated, updated, or edited. */
export function clearThemeBlockAssetsCache(): void {
  memo.clear();
}

/** URL of one declared theme file. */
export function themeAssetHref(assets: Pick<ThemeBlockAssets, "versions">, rel: string): string {
  const version = assets.versions.get(rel);
  return `/theme-assets/${rel.split("/").map(encodeURIComponent).join("/")}${version ? `?v=${version}` : ""}`;
}

/** Tags for the active theme's assets the finished page `html` needs. */
export async function themeBlockAssetTags(html: string): Promise<{ styles: string[]; body: string[] }> {
  const assets = await activeThemeBlockAssets();
  if (!assets) return { styles: [], body: [] };
  const href = (rel: string) => themeAssetHref(assets, rel);
  return pageAssetTags([...assets.blocks.map((block) => ({ ...block, href })), ...assets.markup.map((rule) => ({ ...rule, href }))], html);
}

/** Resolve `/theme-assets/<rel>` to a file the active theme declared, or null. */
export async function resolveThemeAssetFile(
  rel: string,
): Promise<{ absPath: string; contentType: string; version: string } | null> {
  const safe = safeAssetRel(rel);
  if (!safe) return null;
  const assets = await activeThemeBlockAssets();
  const version = assets?.versions.get(safe);
  if (!assets || !version) return null;
  const absPath = resolvePathUnderBase(assets.dir, safe);
  if (!absPath) return null;
  try {
    if (fs.lstatSync(absPath).isSymbolicLink() || !fs.statSync(absPath).isFile()) return null;
  } catch {
    return null;
  }
  const contentType = CONTENT_TYPES[safe.slice(safe.lastIndexOf(".")).toLowerCase()];
  return contentType ? { absPath, contentType, version } : null;
}

/** The active theme's per-page stylesheets as text, for the page builder canvas. */
export async function themePerPageStylesText(): Promise<string> {
  const assets = await activeThemeBlockAssets();
  if (!assets) return "";
  return readPerPageStyles(
    [...assets.blocks, ...assets.markup],
    (rel) => {
      const file = fileVersion(assets.dir, rel) ? resolvePathUnderBase(assets.dir, rel) : null;
      try {
        return file ? fs.readFileSync(file, "utf8") : null;
      } catch {
        return null;
      }
    },
    (rel) => `/theme-assets/${rel.includes("/") ? `${rel.slice(0, rel.lastIndexOf("/"))}/` : ""}`,
  ).join("\n");
}
