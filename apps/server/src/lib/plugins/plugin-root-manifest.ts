// SPDX-License-Identifier: MIT

import { getControlDb } from "../database/db.js";
import { installationRootSiteId } from "../tenancy/registry.js";

type RootPlugin = { version: string; manifest: Record<string, unknown> };
type RootPlugins = { rootId: string | null; plugins: Map<string, RootPlugin> };

const ROOT_PLUGINS_TTL_MS = 5000;
let rootPluginsCache: { at: number; value: Promise<RootPlugins> } | null = null;

function parseManifest(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseManifest(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The main site's plugin rows, keyed by plugin id. Read on every request that
 * loads plugin files on another site, so cached briefly and dropped on any
 * plugin row write in this process. A failed read yields no root rows, and
 * callers then keep the site's own row.
 */
function rootPlugins(): Promise<RootPlugins> {
  const now = Date.now();
  if (rootPluginsCache && now - rootPluginsCache.at < ROOT_PLUGINS_TTL_MS) return rootPluginsCache.value;
  const value = (async (): Promise<RootPlugins> => {
    const plugins = new Map<string, RootPlugin>();
    try {
      const rootId = await installationRootSiteId();
      if (!rootId) return { rootId: null, plugins };
      const control = await getControlDb();
      const rows = await control.query<{ plugin_id: string; version: string; manifest: unknown }>(
        "SELECT plugin_id, version, manifest FROM plugins WHERE site_id = ?",
        [rootId],
      );
      for (const row of rows) {
        const manifest = parseManifest(row.manifest);
        if (manifest) plugins.set(String(row.plugin_id), { version: String(row.version), manifest });
      }
      return { rootId, plugins };
    } catch {
      return { rootId: null, plugins };
    }
  })();
  rootPluginsCache = { at: now, value };
  return value;
}

/** Drop the cached main-site rows after any plugin row is installed, updated, or removed. */
export function clearRootPluginCache(): void {
  rootPluginsCache = null;
}

/**
 * Only the main site installs plugins and decides which version runs. Another
 * site's row only records whether that site turned the plugin on; its stored
 * copy of the version and manifest can be stale, and its `installedPath` can
 * name a version folder that an update already deleted. For any site other than
 * the main site, each row's version and manifest are replaced with the main
 * site's, so the site loads the same build. Rows the main site has no row for
 * are returned unchanged.
 */
export async function withRootPluginManifests<T extends { plugin_id: string; manifest?: unknown; version?: string }>(
  siteId: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const { rootId, plugins } = await rootPlugins();
  if (!rootId || rootId === siteId) return rows;
  return rows.map((row) => {
    const root = plugins.get(String(row.plugin_id));
    if (!root) return row;
    return "version" in row
      ? { ...row, version: root.version, manifest: root.manifest }
      : { ...row, manifest: root.manifest };
  });
}
