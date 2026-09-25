// SPDX-License-Identifier: MIT

import fs from "node:fs";
import {
  PLUGIN_ID_RE,
  pluginAdminBasePath,
  RELATIVE_ADMIN_PATH_RE,
  resolvePluginAdminPath,
} from "@justflows/sdk";
import { getDb } from "../database/db.js";
import { getSiteId } from "../themes/themes-db.js";
import { bundledBasePathFor } from "./plugin-assets.js";
import { resolvePathUnderBase } from "../security/safe-path.js";

/**
 * A self-contained admin app a plugin ships in its own package
 * (`manifest.adminApp`). The host serves `<dir>/**` at `/ext/<pluginId>/admin/**`
 * and, for each declared route, mounts the `entry` HTML in a same-origin
 * `<iframe>` inside the admin shell (see the admin-ui `PluginHostPage`). The
 * plugin owns the whole screen and its design, talks only to its own
 * `ctx.http` routes, and reaches the host through `@justflows/admin-bridge`
 * (`postMessage`) — never a shared React runtime, no core route, no core page.
 *
 * `admin/` is a reserved sub-namespace under `/ext/<pluginId>/`: a plugin that
 * also ships `assets` cannot serve a literal `assets/admin/...` path.
 */

const DIR_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;
const REL_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,240}\.[a-zA-Z0-9]{1,8}$/;
const ENTRY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,158}\.html?$/;

/**
 * Resolve an `adminApp` route path (relative `""` / `"submissions"`, or an
 * already-absolute `/admin/plugins/<id>/…`) to the absolute URL, or null when
 * it escapes the plugin's `/admin/plugins/<id>` namespace or contains `..`.
 */
function resolveRoutePath(raw: string, pluginId: string): string | null {
  const base = pluginAdminBasePath(pluginId);
  const value = raw.trim();
  if (value.includes("..")) return null;
  if (value === "") return base;
  if (value.startsWith("/")) {
    if (value !== base && !value.startsWith(`${base}/`)) return null;
    const rest = value.slice(base.length).replace(/^\//, "");
    return RELATIVE_ADMIN_PATH_RE.test(rest) ? value : null;
  }
  return RELATIVE_ADMIN_PATH_RE.test(value) ? resolvePluginAdminPath(pluginId, value) : null;
}

/** Extensions an admin build may serve, and their content types. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

export interface PluginAdminRouteInfo {
  pluginId: string;
  /** Canonical `/admin/...` path this screen mounts at. */
  path: string;
  /** URL the admin frame loads (`/ext/<pluginId>/admin/<entry>`). */
  entryUrl: string;
  title?: string;
  /** Locale code → `/ext/<pluginId>/admin/<file>` for `adminApp.locales`. */
  catalogs?: Record<string, string>;
}

interface PluginAdminSet {
  pluginId: string;
  /** Absolute path of the plugin's admin build directory. */
  baseDir: string;
  routes: PluginAdminRouteInfo[];
}

let cache: { at: number; sets: PluginAdminSet[] } | null = null;
const TTL_MS = 15_000;

/** Drop the memo — call after a plugin activates / deactivates / is removed. */
export function clearPluginAdminAppCache(): void {
  cache = null;
}

function extname(rel: string): string {
  const dot = rel.lastIndexOf(".");
  return dot >= 0 ? rel.slice(dot).toLowerCase() : "";
}

/** A safe relative path inside an admin build: known extension, no traversal. */
export function safeAdminRel(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.startsWith("/")) return null;
  if (!REL_FILE_RE.test(value) || value.split("/").includes("..")) return null;
  if (!(extname(value) in CONTENT_TYPES)) return null;
  return value;
}

/**
 * Re-validate a stored `adminApp` manifest object (may predate or lie about the
 * schema): a relative `dir` and 1–20 `{ path, entry, title? }` routes, each with
 * a `/admin/...` path and a relative `.html` entry, no traversal, deduped.
 */
const LOCALE_RE = /^[a-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

export function parseAdminAppSpec(
  raw: unknown,
  pluginId: string,
): { dir: string; routes: Array<{ path: string; entry: string; title?: string }>; locales?: Record<string, string> } | null {
  if (!raw || typeof raw !== "object") return null;
  const spec = raw as { dir?: unknown; routes?: unknown; locales?: unknown };
  const dir = typeof spec.dir === "string" && spec.dir ? spec.dir : "admin";
  if (!DIR_RE.test(dir) || dir.split("/").includes("..")) return null;
  if (!Array.isArray(spec.routes) || spec.routes.length === 0) return null;

  const routes: Array<{ path: string; entry: string; title?: string }> = [];
  const seen = new Set<string>();
  for (const rawRoute of spec.routes.slice(0, 20)) {
    if (!rawRoute || typeof rawRoute !== "object") continue;
    const r = rawRoute as { path?: unknown; entry?: unknown; title?: unknown };
    const path = resolveRoutePath(typeof r.path === "string" ? r.path : "", pluginId);
    const entry = typeof r.entry === "string" ? r.entry : "";
    if (!path || seen.has(path)) continue;
    if (!ENTRY_RE.test(entry) || entry.split("/").includes("..")) continue;
    if (!safeAdminRel(entry)) continue;
    seen.add(path);
    routes.push({
      path,
      entry,
      title:
        typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 100) : undefined,
    });
  }
  const locales: Record<string, string> = {};
  if (spec.locales && typeof spec.locales === "object" && !Array.isArray(spec.locales)) {
    for (const [code, file] of Object.entries(spec.locales).slice(0, 20)) {
      if (!LOCALE_RE.test(code)) continue;
      const rel = safeAdminRel(file);
      if (!rel || !rel.endsWith(".json")) continue;
      locales[code] = rel;
    }
  }
  return routes.length ? { dir, routes, ...(Object.keys(locales).length ? { locales } : {}) } : null;
}

async function loadPluginAdminSets(): Promise<PluginAdminSet[]> {
  const siteId = await getSiteId();
  if (!siteId) return [];

  const db = await getDb();
  const rows = await db.query<{ plugin_id: string; manifest: string | Record<string, unknown> }>(
    // Ordered so `buildBundle`'s concatenation — and therefore the bundle hash —
    // does not depend on the row order the driver happens to return.
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active' ORDER BY plugin_id",
    [siteId],
  );

  const out: PluginAdminSet[] = [];
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

    // Serving an admin app requires `admin:extend` — the same gate the installer
    // enforces (package-manifest.ts). Re-checked here so a manifest that was
    // normalized, hand-edited, or dropped in out-of-band cannot slip a
    // privileged admin screen past install-time validation via the disk fallback.
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    if (!permissions.includes("admin:extend")) continue;

    const basePath =
      (typeof manifest.installedPath === "string" && manifest.installedPath) ||
      (typeof manifest.bundledPath === "string" && manifest.bundledPath) ||
      bundledBasePathFor(pluginId) ||
      "";
    if (!basePath) continue;

    // A developer checkout (`bundledPath`, no uploaded package) is refreshed
    // from justflows.json so a new admin route shows up without a reinstall.
    // An installed package keeps the stored manifest and only falls back to
    // disk when that row has no adminApp.
    const installed = typeof manifest.installedPath === "string" && manifest.installedPath.length > 0;
    let adminApp = manifest.adminApp;
    if (!installed || !adminApp || typeof adminApp !== "object") {
      const diskManifest = resolvePathUnderBase(basePath, "justflows.json");
      if (diskManifest && fs.existsSync(diskManifest)) {
        try {
          const diskApp = (JSON.parse(fs.readFileSync(diskManifest, "utf8")) as Record<string, unknown>)
            .adminApp;
          if (diskApp && typeof diskApp === "object") adminApp = diskApp;
        } catch {
          if (!adminApp || typeof adminApp !== "object") adminApp = undefined;
        }
      }
    }

    const spec = parseAdminAppSpec(adminApp, pluginId);
    if (!spec) continue;

    const baseDir = resolvePathUnderBase(basePath, spec.dir);
    if (!baseDir || !fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) continue;

    const catalogs: Record<string, string> = {};
    for (const [code, file] of Object.entries(spec.locales ?? {})) {
      const abs = resolvePathUnderBase(baseDir, file);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      catalogs[code] = `/ext/${pluginId}/admin/${file}`;
    }
    const routes: PluginAdminRouteInfo[] = [];
    for (const route of spec.routes) {
      const abs = resolvePathUnderBase(baseDir, route.entry);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      routes.push({
        pluginId,
        path: route.path,
        entryUrl: `/ext/${pluginId}/admin/${route.entry}`,
        title: route.title,
        ...(Object.keys(catalogs).length ? { catalogs } : {}),
      });
    }
    if (routes.length) out.push({ pluginId, baseDir, routes });
  }
  return out;
}

async function getAdminSets(): Promise<PluginAdminSet[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.sets;
  const sets = await loadPluginAdminSets().catch(() => [] as PluginAdminSet[]);
  cache = { at: now, sets };
  return sets;
}

/** Every admin screen contributed by an active plugin, for the sidebar / frame host. */
export async function getPluginAdminRoutes(): Promise<PluginAdminRouteInfo[]> {
  const sets = await getAdminSets();
  return sets.flatMap((set) => set.routes);
}

/** Resolve `/ext/<pluginId>/admin/<relPath>` to a file to serve, or null. */
export async function resolvePluginAdminFile(
  pluginId: string,
  relPath: string,
): Promise<{ absPath: string; contentType: string; isHtml: boolean } | null> {
  if (!PLUGIN_ID_RE.test(pluginId)) return null;
  const rel = safeAdminRel(relPath);
  if (!rel) return null;

  const sets = await getAdminSets();
  const set = sets.find((s) => s.pluginId === pluginId);
  if (!set) return null;

  const abs = resolvePathUnderBase(set.baseDir, rel);
  if (!abs) return null;
  try {
    if (fs.lstatSync(abs).isSymbolicLink() || !fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  const ext = extname(rel);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return null;
  return { absPath: abs, contentType, isHtml: ext === ".html" || ext === ".htm" };
}
