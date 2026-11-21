// SPDX-License-Identifier: MIT

import type { PluginDto } from "./plugins-db.js";
import { getPlugin, insertPlugin, listPlugins, pluginToDto, type PluginRow } from "./plugins-db.js";
import { getControlDb, getDb } from "../database/db.js";
import { installationRootSiteId } from "../tenancy/registry.js";
import {
  PLUGIN_HOST_COLLECTION,
  PLUGIN_HOST_MULTISITE_ITEM,
  setPluginHostItem,
} from "./plugin-kv.js";

/** A platform-owned plugin switch is absent/on by default and authoritative when off. */
async function pluginEnabledForSite(pluginId: string, siteId: string): Promise<boolean> {
  const featureKey = `${pluginId}.enabled`;
  const { listMeterDefinitions } = await import("../tenancy/quotas.js");
  if (!listMeterDefinitions("site").some((meter) => meter.key === featureKey && meter.unit === "flag")) {
    return true;
  }
  const { siteFeatureEnabled } = await import("../tenancy/site-features.js");
  return siteFeatureEnabled(featureKey, siteId);
}

export function manifestAllowsMultisite(manifest: Record<string, unknown> | null | undefined): boolean {
  return manifest?.allowMultisite === true;
}

/**
 * Tables are dropped only on the main site, and only when no other site still
 * has the plugin. Every other removal deletes that site's rows.
 */
export function mayDropPluginTables(input: {
  installationRoot: boolean;
  otherSitesUsePlugin: boolean;
}): boolean {
  return input.installationRoot && !input.otherSitesUsePlugin;
}

function asManifest(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asManifest(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseRow(row: PluginRow): PluginRow {
  return {
    ...row,
    manifest: asManifest(row.manifest),
    approved_permissions: Array.isArray(row.approved_permissions) ? row.approved_permissions : [],
  };
}

export async function otherSitesHavePlugin(pluginId: string, siteId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db.query<{ site_id: string }>(
      "SELECT site_id FROM plugins WHERE plugin_id = ? AND site_id <> ? LIMIT 1",
      [pluginId, siteId],
    );
    return Boolean(rows[0]);
  } catch {
    return false;
  }
}

/**
 * The plugins turned on at every active site other than `exceptSiteId`,
 * including sites that keep their own database, which a query on this
 * database cannot see. Each site is read with its own database.
 */
export async function activePluginsOnOtherSites(exceptSiteId: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const { eachActiveSite } = await import("../tenancy/connections.js");
  await eachActiveSite(async (siteId) => {
    if (siteId === exceptSiteId) return;
    const db = await getDb();
    const rows = await db
      .query<{ plugin_id: string }>("SELECT plugin_id FROM plugins WHERE site_id = ? AND status = 'active'", [siteId])
      .catch(() => []);
    if (rows.length) found.set(siteId, rows.map((row) => String(row.plugin_id)));
  });
  return found;
}

/**
 * Another site still has the plugin turned on, whether it shares this
 * database or has its own. The module is shared by the whole process, so
 * the main site must not unload it while such a site uses it.
 */
export async function otherSitesHaveActivePlugin(pluginId: string, siteId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db.query<{ site_id: string }>(
      "SELECT site_id FROM plugins WHERE plugin_id = ? AND site_id <> ? AND status = 'active' LIMIT 1",
      [pluginId, siteId],
    );
    if (rows[0]) return true;
  } catch {
    /** No plugin table here; the other sites are still checked below. */
  }
  try {
    for (const ids of (await activePluginsOnOtherSites(siteId)).values()) if (ids.includes(pluginId)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Another site keeps its own copy of the main site's plugin row. The copy is
 * stale when the version differs, and also when the main site reinstalled the
 * same version: each upload lands in a new `<version>/<digest>/` folder and the
 * old folder is deleted, so a copy with the old `installedPath` points nowhere
 * (no admin screens, assets, or templates on that site).
 */
export function subsitePluginCopyIsStale(
  local: { version: string; manifest: unknown },
  root: { version: string; manifest: unknown },
): boolean {
  if (local.version !== root.version) return true;
  return JSON.stringify(asManifest(local.manifest)) !== JSON.stringify(asManifest(root.manifest));
}

const SUBSITE_SYNC_TTL_MS = 15_000;
const subsiteSyncedAt = new Map<string, number>();

/**
 * Bring this site's copies of the main site's plugins up to date. Runs before
 * the admin menu and plugin admin screens read the local rows, so a reinstall
 * on the main site reaches other sites without anyone opening Extensions there.
 * Returns true when a row changed.
 */
export async function syncSubsitePluginCopies(siteId: string): Promise<boolean> {
  const last = subsiteSyncedAt.get(siteId);
  if (last !== undefined && Date.now() - last < SUBSITE_SYNC_TTL_MS) return false;
  subsiteSyncedAt.set(siteId, Date.now());

  const rootId = await installationRootSiteId();
  if (!rootId || rootId === siteId) return false;

  let changed = false;
  try {
    const db = await getDb();
    const localRows = await db.query<PluginRow>("SELECT * FROM plugins WHERE site_id = ?", [siteId]);
    if (localRows.length === 0) return false;
    const control = await getControlDb();
    for (const raw of localRows) {
      const local = parseRow(raw);
      const rows = await control.query<PluginRow>(
        "SELECT * FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
        [rootId, local.plugin_id],
      );
      const root = rows[0] ? parseRow(rows[0]) : null;
      if (!root || !subsitePluginCopyIsStale(local, root)) continue;
      await insertPlugin(siteId, {
        pluginId: root.plugin_id,
        version: root.version,
        manifest: root.manifest,
        copyOfInstalledRow: true,
      });
      changed = true;
    }
  } catch {
    // No tenancy or plugin tables yet.
  }
  if (changed) {
    const { clearPluginAdminAppCache } = await import("./plugin-admin-app.js");
    clearPluginAdminAppCache();
  }
  return changed;
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export async function isPluginOfferedToOtherSites(pluginId: string, rootSiteId: string): Promise<boolean> {
  try {
    const db = await getControlDb();
    const rows = await db.query<{ payload: unknown }>(
      "SELECT payload FROM plugin_data WHERE site_id = ? AND plugin_id = ? AND collection = ? AND item_id = ? LIMIT 1",
      [rootSiteId, pluginId, PLUGIN_HOST_COLLECTION, PLUGIN_HOST_MULTISITE_ITEM],
    );
    return asManifest(rows[0]?.payload).enabled === true;
  } catch {
    return false;
  }
}

export async function setPluginOfferedToOtherSites(
  pluginId: string,
  rootSiteId: string,
  enabled: boolean,
): Promise<void> {
  await setPluginHostItem(pluginId, rootSiteId, PLUGIN_HOST_MULTISITE_ITEM, { enabled });
  if (enabled) return;
  try {
    const db = await getDb();
    await db.run(
      "UPDATE plugins SET status = 'inactive', updated_at = ? WHERE plugin_id = ? AND site_id <> ? AND status = 'active'",
      [stamp(), pluginId, rootSiteId],
    );
  } catch {
    // Other sites on this database have no plugin row yet.
  }
}

/**
 * Turn off plugins on this site that the main site has not allowed. The rows
 * stay, so turning the plugin back on later does not lose this site's data.
 * The process-wide module is left loaded: the main site may still be using it.
 */
async function concealUnofferedPlugins(siteId: string, offeredIds: ReadonlySet<string>): Promise<void> {
  try {
    const db = await getDb();
    const localRows = await db.query<PluginRow>("SELECT * FROM plugins WHERE site_id = ?", [siteId]);
    for (const raw of localRows) {
      const row = parseRow(raw);
      if (offeredIds.has(row.plugin_id) || row.status !== "active") continue;
      await db.run(
        "UPDATE plugins SET status = 'inactive', updated_at = ? WHERE site_id = ? AND plugin_id = ?",
        [stamp(), siteId, row.plugin_id],
      );
    }
  } catch {
    // This site has no plugin rows yet.
  }
}

/** Plugins this site may see. The main site sees what it installed. Another site sees only plugins the main site has allowed, and each starts off. */
export async function listVisiblePlugins(siteId: string): Promise<PluginDto[]> {
  const rootId = await installationRootSiteId();
  if (!rootId || rootId === siteId) {
    const installed = await listPlugins(siteId);
    const plugins = (
      await Promise.all(installed.map(async (plugin) => ({
        plugin,
        enabled: await pluginEnabledForSite(plugin.id, siteId),
      })))
    ).filter((item) => item.enabled).map((item) => item.plugin);
    const offered = await Promise.all(
      plugins.map((plugin) => isPluginOfferedToOtherSites(plugin.id, siteId)),
    );
    return plugins.map((plugin, index) => ({ ...plugin, multisiteEnabled: offered[index] === true }));
  }

  const control = await getControlDb();
  let rootRows: PluginRow[] = [];
  try {
    rootRows = await control.query<PluginRow>(
      "SELECT * FROM plugins WHERE site_id = ? ORDER BY installed_at DESC",
      [rootId],
    );
  } catch {
    rootRows = [];
  }

  const offeredIds = new Set<string>();
  const visible: PluginDto[] = [];
  for (const raw of rootRows) {
    const row = parseRow(raw);
    if (!(await pluginEnabledForSite(row.plugin_id, siteId))) continue;
    if (!(await isPluginOfferedToOtherSites(row.plugin_id, rootId))) continue;
    offeredIds.add(row.plugin_id);
    const local = await getPlugin(siteId, row.plugin_id);
    if (local && subsitePluginCopyIsStale(local, row)) {
      await insertPlugin(siteId, {
        pluginId: row.plugin_id,
        version: row.version,
        manifest: row.manifest,
        copyOfInstalledRow: true,
      });
    }
    const dto = pluginToDto(
      local
        ? {
            ...local,
            version: row.version,
            manifest: row.manifest,
            status: local.status === "active" ? "active" : "inactive",
          }
        : {
            ...row,
            site_id: siteId,
            status: "inactive",
            activated_at: null,
          },
    );
    visible.push({ ...dto, multisiteEnabled: true });
  }

  await concealUnofferedPlugins(siteId, offeredIds);
  return visible;
}

/**
 * A site other than the main site can activate a plugin only after the main
 * site has installed it and turned on “Available on other sites”.
 */
export async function prepareSubsitedActivation(
  siteId: string,
  pluginId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await pluginEnabledForSite(pluginId, siteId))) {
    return { ok: false, error: "This plugin is turned off for this website." };
  }
  const rootId = await installationRootSiteId();
  if (!rootId || rootId === siteId) {
    return { ok: false, error: "Plugin is not installed on this site." };
  }
  const control = await getControlDb();
  const rows = await control.query<PluginRow>(
    "SELECT * FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
    [rootId, pluginId],
  );
  const rootPlugin = rows[0] ? parseRow(rows[0]) : null;
  if (!rootPlugin) {
    return { ok: false, error: "This plugin is not available on this site." };
  }
  if (!(await isPluginOfferedToOtherSites(pluginId, rootId))) {
    return { ok: false, error: "The main site has not made this plugin available to other sites." };
  }
  const local = await getPlugin(siteId, pluginId);
  if (local) {
    if (subsitePluginCopyIsStale(local, rootPlugin)) {
      await insertPlugin(siteId, {
        pluginId: rootPlugin.plugin_id,
        version: rootPlugin.version,
        manifest: rootPlugin.manifest,
        copyOfInstalledRow: true,
      });
    }
    return { ok: true };
  }
  const { QuotaRefusalError } = await import("../tenancy/quotas.js");
  try {
    await insertPlugin(siteId, {
      pluginId: rootPlugin.plugin_id,
      version: rootPlugin.version,
      manifest: rootPlugin.manifest,
      status: "inactive",
      copyOfInstalledRow: true,
    });
  } catch (err) {
    if (err instanceof QuotaRefusalError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true };
}
