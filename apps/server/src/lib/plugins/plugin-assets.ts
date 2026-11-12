// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnvBool } from "@justflows/core";
import { PLUGIN_ID_RE } from "@justflows/sdk";
import { blockAssetMarker } from "@justflows/blocks";
import { getDb } from "../database/db.js";
import { withRootPluginManifests } from "./plugin-root-manifest.js";
import { pageAssetTags, readMarkupAssets, readPerPageStyles } from "../rendering/block-assets.js";
import { getSiteId } from "../themes/themes-db.js";
import { pluginsDir } from "./plugins-db.js";
import { resolvePathUnderBase } from "../security/safe-path.js";

/**
 * Client-side assets a plugin ships in its own package (`manifest.assets`). The
 * host serves `<dir>/**` at `/ext/<pluginId>/**` for direct access, and — by
 * default — **concatenates every active plugin's declared `scripts` / `styles`
 * into one content-hashed bundle** (`/jf-plugins.<hash>.js` / `.css`) so a page
 * loads at most one plugin script and one plugin stylesheet, whatever the
 * plugin count. The static exporter downloads the bundle like any other asset.
 * Set `PLUGIN_ASSETS_BUNDLE=0` to emit a `<script>` per plugin file instead.
 *
 * `manifest.assets.blocks` and `assets.markup` assets are never bundled or
 * enqueued everywhere: they are linked one file at a time, with a
 * `?v=<content hash>` the `/ext` route caches as immutable, only on pages that
 * render that block or contain that markup.
 */

interface AssetBundle {
  hash: string;
  code: string;
  contentType: string;
}

interface PluginAssetSet {
  pluginId: string;
  /** Absolute path of the plugin's asset directory. */
  baseDir: string;
  /** Declared script paths, relative to `baseDir`, that exist on disk. */
  scripts: string[];
  /** Declared stylesheet paths, relative to `baseDir`, that exist on disk. */
  styles: string[];
  /** Per-block assets of the plugin's own block types, in manifest order. */
  blocks: Array<{ type: string; scripts: string[]; styles: string[] }>;
  /** Assets for pages containing given markup (`assets.markup`). */
  markup: Array<{ match: string[]; scripts: string[]; styles: string[] }>;
  /** Content version of each per-block or markup asset file, by relative path. */
  versions: Map<string, string>;
}

const DIR_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;
const REL_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(js|mjs|css)$/;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Images a plugin may serve from its asset dir at `/ext/<id>/**` (placeholders,
 * icons). Only scripts and stylesheets are enqueued and bundled.
 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
};
const REL_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(svg|png|jpe?g|webp|avif|gif)$/i;

let cache: {
  at: number;
  sets: PluginAssetSet[];
  js: AssetBundle | null;
  css: AssetBundle | null;
} | null = null;
const TTL_MS = 15_000;

function bundlingEnabled(): boolean {
  return parseEnvBool(process.env.PLUGIN_ASSETS_BUNDLE, true);
}

/** Dev fallback: a bundled plugin under `plugins/` whose manifest id matches. */
export function bundledBasePathFor(pluginId: string): string | null {
  const dir = pluginsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const base = path.join(dir, name);
    for (const file of ["justflows.json", "justflows-plugin.json", "package.json"]) {
      const manifestFile = path.join(base, file);
      try {
        const raw = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
          id?: unknown;
          name?: unknown;
        };
        const id =
          typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : "";
        if (id === pluginId) return base;
      } catch {
        // not this one
      }
    }
  }
  return null;
}

/** A safe relative asset path: `.js`/`.mjs`/`.css`, no `..`, not absolute. */
export function safeAssetRel(value: unknown): string | null {
  if (typeof value !== "string" || value.startsWith("/") || !REL_FILE_RE.test(value)) return null;
  if (value.split("/").includes("..")) return null;
  return value;
}

/** A path `/ext/<id>/**` may serve: a script, stylesheet, or image. */
export function servableAssetRel(value: unknown): string | null {
  const asset = safeAssetRel(value);
  if (asset) return asset;
  if (typeof value !== "string" || value.startsWith("/") || !REL_IMAGE_RE.test(value)) return null;
  return value.split("/").includes("..") ? null : value;
}

/** `<link>` / `<script>` tags for one plugin's asset lists (pure, no I/O). */
export function assetTags(
  pluginId: string,
  lists: { scripts?: readonly string[]; styles?: readonly string[] },
): string {
  if (!PLUGIN_ID_RE.test(pluginId)) return "";
  const tags: string[] = [];
  for (const href of lists.styles ?? []) {
    if (safeAssetRel(href)) {
      tags.push(`<link rel="stylesheet" href="/ext/${esc(pluginId)}/${esc(href)}">`);
    }
  }
  for (const src of lists.scripts ?? []) {
    if (safeAssetRel(src)) {
      tags.push(`<script src="/ext/${esc(pluginId)}/${esc(src)}" defer></script>`);
    }
  }
  return tags.join("\n");
}

/** The declared files under `baseDir` that are safe and exist, de-duplicated. */
function pickAssetFiles(baseDir: string, list: unknown, max = 20): string[] {
  if (!Array.isArray(list)) return [];
  const seen: string[] = [];
  for (const raw of list.slice(0, max)) {
    const rel = safeAssetRel(raw);
    if (!rel) continue;
    const abs = resolvePathUnderBase(baseDir, rel);
    if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile() && !seen.includes(rel)) {
      seen.push(rel);
    }
  }
  return seen;
}

/**
 * `manifest.assets.blocks` and `assets.markup`: the files each of the plugin's
 * own block types needs (the namespace `ctx.blocks.register` enforces; other
 * types are ignored), the markup rules, and a content version per file for
 * its immutable URL.
 */
export function readBlockAssets(
  pluginId: string,
  baseDir: string,
  spec: unknown,
  markupSpec?: unknown,
): Pick<PluginAssetSet, "blocks" | "markup" | "versions"> {
  const blocks: PluginAssetSet["blocks"] = [];
  const versions = new Map<string, string>();
  const pick = (list: unknown) => pickAssetFiles(baseDir, list, 10);
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    for (const [type, raw] of Object.entries(spec as Record<string, unknown>).slice(0, 50)) {
      if (!blockAssetMarker(type) || (type !== pluginId && !type.startsWith(`${pluginId}.`))) continue;
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { scripts?: unknown; styles?: unknown };
      const block = { type, scripts: pick(entry.scripts), styles: pick(entry.styles) };
      if (block.scripts.length || block.styles.length) blocks.push(block);
    }
  }
  const markup = readMarkupAssets(markupSpec, pick);
  for (const entry of [...blocks, ...markup]) {
    for (const rel of [...entry.scripts, ...entry.styles]) {
      if (versions.has(rel)) continue;
      const abs = resolvePathUnderBase(baseDir, rel);
      try {
        if (abs) versions.set(rel, createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 12));
      } catch {
        /** Unreadable now: linked without a version, so never cached for good. */
      }
    }
  }
  return { blocks, markup, versions };
}

async function loadPluginAssetSets(): Promise<PluginAssetSet[]> {
  const siteId = await getSiteId();
  if (!siteId) return [];

  const db = await getDb();
  const siteRows = await db.query<{ plugin_id: string; manifest: string | Record<string, unknown> }>(
    // Ordered so the concatenated bundle (and its content hash / URL) is stable
    // across restarts and replicas rather than following the driver's row order.
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active' ORDER BY plugin_id",
    [siteId],
  );
  const rows = await withRootPluginManifests(siteId, siteRows);

  const out: PluginAssetSet[] = [];
  for (const row of rows) {
    const pluginId = String(row.plugin_id);
    if (!PLUGIN_ID_RE.test(pluginId)) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest =
        typeof row.manifest === "string"
          ? (JSON.parse(row.manifest) as Record<string, unknown>)
          : ((row.manifest ?? {}) as Record<string, unknown>);
    } catch {
      continue;
    }

    const basePath =
      (typeof manifest.installedPath === "string" && manifest.installedPath) ||
      (typeof manifest.bundledPath === "string" && manifest.bundledPath) ||
      bundledBasePathFor(pluginId) ||
      "";
    if (!basePath) continue;

    // Prefer the stored row; fall back to the on-disk manifest (matches how the
    // host refreshes `settingsSchema` / `setupPath` for plugins packaged before
    // a pipeline that strips unknown keys).
    let assets = manifest.assets;
    if (!assets || typeof assets !== "object") {
      const diskManifest = resolvePathUnderBase(basePath, "justflows.json");
      if (diskManifest && fs.existsSync(diskManifest)) {
        try {
          assets = (JSON.parse(fs.readFileSync(diskManifest, "utf8")) as Record<string, unknown>)
            .assets;
        } catch {
          assets = undefined;
        }
      }
    }
    if (!assets || typeof assets !== "object") continue;
    const spec = assets as { dir?: unknown; scripts?: unknown; styles?: unknown; blocks?: unknown; markup?: unknown };

    const dirName = typeof spec.dir === "string" && spec.dir ? spec.dir : "public";
    if (!DIR_RE.test(dirName) || dirName.split("/").includes("..")) continue;

    const baseDir = resolvePathUnderBase(basePath, dirName);
    if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) continue;

    // `baseDir` is a valid directory here — serve its files at /ext/<id>/**
    // even if nothing is auto-enqueued.
    out.push({
      pluginId,
      baseDir,
      scripts: pickAssetFiles(baseDir, spec.scripts),
      styles: pickAssetFiles(baseDir, spec.styles),
      ...readBlockAssets(pluginId, baseDir, spec.blocks, spec.markup),
    });
  }
  return out;
}

/** Concatenate `kind` files across every set into one hashed bundle, or null. */
export function buildBundle(
  sets: Array<{ pluginId: string; baseDir: string; scripts: string[]; styles: string[] }>,
  kind: "js" | "css",
): AssetBundle | null {
  const parts: string[] = [];
  for (const set of sets) {
    const rels = kind === "js" ? set.scripts : set.styles;
    for (const rel of rels) {
      const abs = resolvePathUnderBase(set.baseDir, rel);
      if (!abs) continue;
      let src: string;
      try {
        src = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const banner = `/* ${set.pluginId}/${rel} */\n`;
      // Wrap each script so a stray top-level `var` / missing `;` in one plugin
      // cannot break the next. Stylesheets just concatenate.
      parts.push(kind === "js" ? `${banner};(function(){\n${src}\n})();\n` : `${banner}${src}\n`);
    }
  }
  if (parts.length === 0) return null;
  const code = parts.join("\n");
  return {
    hash: createHash("sha256").update(code).digest("hex").slice(0, 16),
    code,
    contentType: kind === "js" ? CONTENT_TYPES[".js"]! : CONTENT_TYPES[".css"]!,
  };
}

async function getState(): Promise<{
  sets: PluginAssetSet[];
  js: AssetBundle | null;
  css: AssetBundle | null;
}> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache;
  const sets = await loadPluginAssetSets().catch(() => [] as PluginAssetSet[]);
  cache = {
    at: now,
    sets,
    js: buildBundle(sets, "js"),
    css: buildBundle(sets, "css"),
  };
  return cache;
}

async function getPluginAssetSets(): Promise<PluginAssetSet[]> {
  return (await getState()).sets;
}

/** Drop the memo — call after a plugin activates / deactivates. */
export function clearPluginAssetsCache(): void {
  cache = null;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The `<link>` / `<script>` for every active plugin's declared assets — one
 * bundled `/jf-plugins.<hash>.{css,js}` pair by default, or a tag per file when
 * `PLUGIN_ASSETS_BUNDLE=0`.
 */
export async function renderPluginAssetHeadHtml(): Promise<string> {
  const state = await getState();
  if (!bundlingEnabled()) {
    return state.sets
      .map((set) => assetTags(set.pluginId, set))
      .filter(Boolean)
      .join("\n");
  }
  const tags: string[] = [];
  if (state.css) tags.push(`<link rel="stylesheet" href="/jf-plugins.${state.css.hash}.css">`);
  if (state.js) tags.push(`<script src="/jf-plugins.${state.js.hash}.js" defer></script>`);
  return tags.join("\n");
}

/**
 * Tags for the per-block and markup assets (`manifest.assets.blocks` /
 * `assets.markup`) the finished page `html` needs: stylesheets to link before
 * the theme stylesheet, deferred scripts for the end of the body.
 */
export async function pluginBlockAssetTags(html: string): Promise<{ styles: string[]; body: string[] }> {
  return blockAssetTagsFor((await getState()).sets, html);
}

/** {@link pluginBlockAssetTags} for given asset sets (pure, no I/O). */
export function blockAssetTagsFor(
  sets: ReadonlyArray<Pick<PluginAssetSet, "pluginId" | "blocks" | "versions"> & { markup?: PluginAssetSet["markup"] }>,
  html: string,
): { styles: string[]; body: string[] } {
  return pageAssetTags(
    sets.flatMap((set) => {
      const href = (rel: string) => {
        const version = set.versions.get(rel);
        return `/ext/${esc(set.pluginId)}/${esc(rel)}${version ? `?v=${version}` : ""}`;
      };
      return [...set.blocks.map((block) => ({ ...block, href })), ...(set.markup ?? []).map((rule) => ({ ...rule, href }))];
    }),
    html,
  );
}

/** Read a declared asset file under `baseDir` (no symlinks, at most 512 KiB), or null. */
function readAssetText(baseDir: string, rel: string): string | null {
  const abs = resolvePathUnderBase(baseDir, rel);
  if (!abs) return null;
  try {
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      return stat.isFile() && stat.size <= 512 * 1024 ? fs.readFileSync(fd, "utf8") : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Every active plugin's per-block and markup stylesheets as text, for the page
 * builder canvas: it previews any block, so it needs them all, scoped into the
 * canvas with the theme stylesheet.
 */
export async function pluginPerPageStylesText(): Promise<string> {
  return (await getState()).sets
    .flatMap((set) =>
      readPerPageStyles(
        [...set.blocks, ...set.markup],
        (rel) => readAssetText(set.baseDir, rel),
        (rel) => `/ext/${set.pluginId}/${rel.includes("/") ? `${rel.slice(0, rel.lastIndexOf("/"))}/` : ""}`,
      ).map((css) => `/* ${set.pluginId} */\n${css}`),
    )
    .join("\n");
}

/**
 * Serve `/jf-plugins.<hash>.<ext>`. Returns the current bundle even if `hash` is
 * stale (a page cached before a plugin change), flagging `immutable` only on an
 * exact match so a stale URL is revalidated.
 */
export async function getPluginBundle(
  ext: "js" | "css",
  hash: string,
): Promise<{ code: string; contentType: string; immutable: boolean } | null> {
  const bundle = (await getState())[ext];
  if (!bundle) return null;
  return {
    code: bundle.code,
    contentType: bundle.contentType,
    immutable: bundle.hash === hash,
  };
}

/**
 * Asset directory of a multisite or `platform:network` plugin that is active
 * on the main site. Another site can load `/ext/<id>/…` even when it has not
 * activated the plugin itself: the admin frames of a multisite plugin, and the
 * files a network hook's markup points at.
 */
async function rootMultisiteAssetDir(pluginId: string): Promise<string | null> {
  const { getTenantContext } = await import("../tenancy/context.js");
  const tenant = getTenantContext();
  if (!tenant || tenant.rootSite) return null;
  const { installationRootSiteId } = await import("../tenancy/registry.js");
  const rootId = await installationRootSiteId().catch(() => null);
  if (!rootId || rootId === tenant.siteId) return null;

  const { getControlDb } = await import("../database/db.js");
  let manifest: Record<string, unknown> | null = null;
  for (const load of [getDb, getControlDb]) {
    try {
      const db = await load();
      const rows = await db.query<{ manifest: string | Record<string, unknown>; status: string }>(
        "SELECT manifest, status FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
        [rootId, pluginId],
      );
      const row = rows[0];
      if (!row || row.status !== "active") continue;
      const parsed =
        typeof row.manifest === "string"
          ? (JSON.parse(row.manifest) as Record<string, unknown>)
          : row.manifest;
      if (parsed && typeof parsed === "object") {
        manifest = parsed;
        break;
      }
    } catch {
      continue;
    }
  }
  const network = Array.isArray(manifest?.permissions) && manifest.permissions.includes("platform:network");
  if (!manifest || (manifest.allowMultisite !== true && !network)) return null;

  const basePath =
    (typeof manifest.installedPath === "string" && manifest.installedPath) ||
    (typeof manifest.bundledPath === "string" && manifest.bundledPath) ||
    bundledBasePathFor(pluginId) ||
    "";
  if (!basePath) return null;

  let assets = manifest.assets;
  if (!assets || typeof assets !== "object") {
    const diskManifest = resolvePathUnderBase(basePath, "justflows.json");
    if (diskManifest && fs.existsSync(diskManifest)) {
      try {
        assets = (JSON.parse(fs.readFileSync(diskManifest, "utf8")) as Record<string, unknown>).assets;
      } catch {
        assets = undefined;
      }
    }
  }
  if (!assets || typeof assets !== "object") return null;
  const dirName = typeof (assets as { dir?: unknown }).dir === "string" && (assets as { dir: string }).dir
    ? (assets as { dir: string }).dir
    : "public";
  if (!DIR_RE.test(dirName) || dirName.split("/").includes("..")) return null;
  const baseDir = resolvePathUnderBase(basePath, dirName);
  if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) return null;
  return baseDir;
}

/** Resolve a request for `/ext/<pluginId>/<relPath>` to a file to serve, or null. */
export async function resolvePluginAssetFile(
  pluginId: string,
  relPath: string,
): Promise<{ absPath: string; contentType: string; version?: string } | null> {
  if (!PLUGIN_ID_RE.test(pluginId)) return null;
  const rel = servableAssetRel(relPath);
  if (!rel) return null;

  const sets = await getPluginAssetSets();
  const set = sets.find((s) => s.pluginId === pluginId);
  const baseDir = set?.baseDir ?? (await rootMultisiteAssetDir(pluginId));
  if (!baseDir) return null;

  const abs = resolvePathUnderBase(baseDir, rel);
  if (!abs) return null;
  try {
    if (fs.lstatSync(abs).isSymbolicLink() || !fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? IMAGE_CONTENT_TYPES[ext];
  if (!contentType) return null;
  const version = set?.versions.get(rel);
  return { absPath: abs, contentType, ...(version ? { version } : {}) };
}
