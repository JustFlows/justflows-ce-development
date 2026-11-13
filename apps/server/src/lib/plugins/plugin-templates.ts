// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { PLUGIN_ID_RE } from "@justflows/sdk";
import { getDb } from "../database/db.js";
import { withRootPluginManifests } from "./plugin-root-manifest.js";
import { getSiteId } from "../themes/themes-db.js";
import { resolvePathUnderBase } from "../security/safe-path.js";
import { bundledBasePathFor } from "./plugin-assets.js";
import type { BlockNode } from "../runtime/types.js";

/**
 * Page templates a plugin ships in its own package (`manifest.templates`), so
 * templates for plugin-owned content types (`single-product`, `single-cart`,
 * …) live with the plugin instead of in every theme.
 *
 * Resolution (see `resolveEffectiveTemplate`) checks them per candidate slug
 * after the site override and the active theme's own file: a theme can still
 * restyle a plugin template by shipping the same slug, but a plugin template
 * beats the coarser `single` / `singular` fallbacks.
 */

interface PluginTemplateDir {
  pluginId: string;
  /** Absolute path of the plugin's templates directory. */
  dir: string;
}

const DIR_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;
const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const TTL_MS = 15_000;

let cache: { at: number; dirs: PluginTemplateDir[] } | null = null;

function parseManifest(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function diskManifest(basePath: string): Record<string, unknown> {
  const file = resolvePathUnderBase(basePath, "justflows.json");
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The templates folder a manifest declares, or null. */
export function templatesDirName(templates: unknown): string | null {
  if (!templates || typeof templates !== "object") return null;
  const dir = (templates as { dir?: unknown }).dir;
  const name = typeof dir === "string" && dir ? dir : "templates";
  if (!DIR_RE.test(name) || name.split("/").includes("..")) return null;
  return name;
}

/** One template file from a plugin's templates directory, or null. */
export function readPluginTemplate(dir: string, slug: string): BlockNode[] | null {
  if (!TEMPLATE_SLUG_RE.test(slug)) return null;
  const file = resolvePathUnderBase(dir, `${slug}.json`);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { blocks?: unknown };
    return Array.isArray(data.blocks) && data.blocks.length ? (data.blocks as BlockNode[]) : null;
  } catch {
    return null;
  }
}

async function loadTemplateDirs(): Promise<PluginTemplateDir[]> {
  const siteId = await getSiteId();
  if (!siteId) return [];

  const db = await getDb();
  const siteRows = await db.query<{ plugin_id: string; manifest: string | Record<string, unknown> }>(
    // Ordered so two plugins shipping the same slug resolve the same way every time.
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active' ORDER BY plugin_id",
    [siteId],
  );
  const rows = await withRootPluginManifests(siteId, siteRows);

  const out: PluginTemplateDir[] = [];
  for (const row of rows) {
    const pluginId = String(row.plugin_id);
    if (!PLUGIN_ID_RE.test(pluginId)) continue;
    const manifest = parseManifest(row.manifest);
    const basePath =
      (typeof manifest.installedPath === "string" && manifest.installedPath) ||
      (typeof manifest.bundledPath === "string" && manifest.bundledPath) ||
      bundledBasePathFor(pluginId) ||
      "";
    if (!basePath) continue;

    // Prefer the stored row; fall back to the on-disk manifest, like plugin assets.
    const name = templatesDirName(manifest.templates ?? diskManifest(basePath).templates);
    if (!name) continue;
    const dir = resolvePathUnderBase(basePath, name);
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    out.push({ pluginId, dir });
  }
  return out;
}

async function templateDirs(): Promise<PluginTemplateDir[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.dirs;
  const dirs = await loadTemplateDirs().catch(() => []);
  cache = { at: now, dirs };
  return dirs;
}

/** The first active plugin's template for `slug`, or null. */
export async function loadPluginTemplate(slug: string): Promise<BlockNode[] | null> {
  if (!TEMPLATE_SLUG_RE.test(slug)) return null;
  for (const { dir } of await templateDirs()) {
    const blocks = readPluginTemplate(dir, slug);
    if (blocks) return blocks;
  }
  return null;
}

export function clearPluginTemplatesCache(): void {
  cache = null;
}
