// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import {
  PLUGIN_DELETE_CONTENT_SETTING,
  PLUGIN_DELETE_DATA_SETTING,
  type PluginDatabaseDriver,
  type PluginDatabaseTarget,
} from "@justflows/sdk";
import { packagesInstalledDir } from "../extensions/packages-dir.js";
import { decryptSecret, encryptSecret } from "../security/secret-box.js";
import { sanitizeProbeError } from "../database/db-probe.js";
import {
  deletePluginSiteRows,
  dropPluginOwnedTables,
  openTargetDatabase,
} from "./plugin-schema.js";
import { mayDropPluginTables, otherSitesHavePlugin } from "./plugin-multisite.js";
import { isInstallationRootSite } from "../tenancy/registry.js";
import { deleteAllPluginData } from "./plugin-data.js";
import {
  deletePluginHostItem,
  deletePluginSetting,
  getPluginHostItem,
  getPluginSetting,
  PLUGIN_HOST_CONTENT_TYPES_ITEM,
  PLUGIN_HOST_SCHEMA_ITEM,
  PLUGIN_HOST_SCHEMA_PASSWORD_ITEM,
  setPluginHostItem,
} from "./plugin-kv.js";
import {
  deleteSiteSetting,
  getSiteId,
  settingsKeyColumn,
} from "../settings/site-settings.js";
import { getDb } from "../database/db.js";
import { contentTypeSlugsFromManifest, deletePluginOwnedContentType } from "./plugin-content.js";
import { resolvePathUnderBase } from "../security/safe-path.js";

export type AppliedPluginSchemaMeta = {
  tables: string[];
  target?: {
    driver: PluginDatabaseDriver;
    host: string;
    port: number;
    database: string;
    username: string;
    ssl: boolean;
    rejectUnauthorized?: boolean;
  };
};

export function appliedSchemaSettingKey(pluginId: string): string {
  return `plugin_schema:${pluginId}`;
}

export function appliedSchemaPasswordKey(pluginId: string): string {
  return `plugin_schema:${pluginId}:password`;
}

/** LIKE pattern for every site_settings row owned by this plugin (`plugin.{id}:…`). */
export function pluginSettingsLikePattern(pluginId: string): string {
  return `plugin.${pluginId.replace(/!/g, "!!")}:%`;
}

export async function shouldPurgePluginData(siteId: string, pluginId: string): Promise<boolean> {
  const stored = await getPluginSetting(pluginId, siteId, PLUGIN_DELETE_DATA_SETTING);
  if (stored === undefined || stored === null) return true;
  if (stored === false || stored === "false" || stored === 0 || stored === "0") return false;
  return true;
}

export async function shouldPurgePluginContent(siteId: string, pluginId: string): Promise<boolean> {
  const stored = await getPluginSetting(pluginId, siteId, PLUGIN_DELETE_CONTENT_SETTING);
  if (stored === undefined || stored === null) return true;
  if (stored === false || stored === "false" || stored === 0 || stored === "0") return false;
  return true;
}

function contentTypesFromDisk(manifest: Record<string, unknown>): string[] {
  const base =
    (typeof manifest.installedPath === "string" && manifest.installedPath) ||
    (typeof manifest.bundledPath === "string" && manifest.bundledPath) ||
    "";
  if (!base) return [];
  const file = resolvePathUnderBase(base, "justflows.json");
  if (!file || !fs.existsSync(file)) return [];
  try {
    return contentTypeSlugsFromManifest(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

export async function collectPluginContentTypeSlugs(
  pluginId: string,
  siteId: string,
  manifest?: Record<string, unknown>,
): Promise<string[]> {
  const slugs: string[] = [];
  const add = (items: string[]) => {
    for (const slug of items) {
      if (!slugs.includes(slug)) slugs.push(slug);
    }
  };
  if (manifest) {
    add(contentTypeSlugsFromManifest(manifest));
    add(contentTypesFromDisk(manifest));
  }
  const recorded = await getPluginHostItem<unknown>(pluginId, siteId, PLUGIN_HOST_CONTENT_TYPES_ITEM);
  if (Array.isArray(recorded)) {
    add(recorded.filter((item): item is string => typeof item === "string"));
  }
  return slugs;
}

export async function purgePluginContent(
  siteId: string,
  pluginId: string,
  manifest?: Record<string, unknown>,
): Promise<{ ok: boolean; types: string[]; pages: number; error?: string }> {
  const slugs = await collectPluginContentTypeSlugs(pluginId, siteId, manifest);
  let pages = 0;
  const types: string[] = [];
  try {
    for (const slug of slugs) {
      const result = await deletePluginOwnedContentType(siteId, slug);
      pages += result.pages;
      if (result.typeDeleted || result.pages > 0) types.push(slug);
    }
    await deletePluginHostItem(pluginId, siteId, PLUGIN_HOST_CONTENT_TYPES_ITEM);
    return { ok: true, types, pages };
  } catch (err) {
    return { ok: false, types, pages, error: sanitizeProbeError(err) };
  }
}

export async function recordAppliedPluginSchema(
  pluginId: string,
  tables: string[],
  target?: PluginDatabaseTarget,
): Promise<void> {
  const siteId = await getSiteId();
  if (!siteId) return;
  const meta: AppliedPluginSchemaMeta = { tables };
  if (target) {
    meta.target = {
      driver: target.driver,
      host: target.host,
      port: target.port,
      database: target.database,
      username: target.username,
      ssl: target.ssl,
      ...(target.rejectUnauthorized === undefined
        ? {}
        : { rejectUnauthorized: target.rejectUnauthorized }),
    };
  }
  await setPluginHostItem(pluginId, siteId, PLUGIN_HOST_SCHEMA_ITEM, meta);
  if (target?.password) {
    await setPluginHostItem(
      pluginId,
      siteId,
      PLUGIN_HOST_SCHEMA_PASSWORD_ITEM,
      encryptSecret(target.password),
    );
  }
}

async function dropOnSeparateTarget(
  pluginId: string,
  meta: AppliedPluginSchemaMeta,
  password: string,
): Promise<string[]> {
  const target = meta.target;
  if (!target) return [];
  const db = await openTargetDatabase({
    ...target,
    password,
    ssl: target.ssl,
  });
  try {
    return await dropPluginOwnedTables(db, pluginId, target.driver, meta.tables);
  } finally {
    await db.close();
  }
}

async function deletePluginSiteSettings(siteId: string, pluginId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    `DELETE FROM site_settings WHERE site_id = ? AND ${settingsKeyColumn()} LIKE ? ESCAPE '!'`,
    [siteId, pluginSettingsLikePattern(pluginId)],
  );
  await deleteSiteSetting(siteId, appliedSchemaSettingKey(pluginId));
  await deleteSiteSetting(siteId, appliedSchemaPasswordKey(pluginId));
  await deletePluginHostItem(pluginId, siteId, PLUGIN_HOST_SCHEMA_ITEM);
  await deletePluginHostItem(pluginId, siteId, PLUGIN_HOST_SCHEMA_PASSWORD_ITEM);
  await deletePluginHostItem(pluginId, siteId, PLUGIN_HOST_CONTENT_TYPES_ITEM);
  await deletePluginSetting(pluginId, siteId, PLUGIN_DELETE_DATA_SETTING);
  await deletePluginSetting(pluginId, siteId, PLUGIN_DELETE_CONTENT_SETTING);
}

/**
 * Drop plugin-prefixed tables (shared Justflows DB, and a recorded separate
 * database when present), then delete plugin_data and plugin settings/secrets.
 */
export async function purgePluginStorage(
  siteId: string,
  pluginId: string,
  options: { rowsOnly?: boolean; strictRemote?: boolean; driver?: PluginDatabaseDriver } = {},
): Promise<{ ok: boolean; tables: string[]; error?: string }> {
  const driver = options.driver ?? (process.env.DB_DRIVER as PluginDatabaseDriver | undefined) ?? "mysql";
  const dropped: string[] = [];
  let remoteError: string | undefined;
  const dropTables = !options.rowsOnly && mayDropPluginTables({
    installationRoot: await isInstallationRootSite(siteId),
    otherSitesUsePlugin: await otherSitesHavePlugin(pluginId, siteId),
  });

  const meta = await getPluginHostItem<AppliedPluginSchemaMeta>(
    pluginId,
    siteId,
    PLUGIN_HOST_SCHEMA_ITEM,
  );
  const storedPassword = await getPluginHostItem<string>(
    pluginId,
    siteId,
    PLUGIN_HOST_SCHEMA_PASSWORD_ITEM,
  );
  if (meta?.target) {
    try {
      const password = decryptSecret(storedPassword ?? "");
      if (dropTables) {
        dropped.push(...(await dropOnSeparateTarget(pluginId, meta, password)));
      } else {
        const remote = await openTargetDatabase({ ...meta.target, password, ssl: meta.target.ssl });
        try {
          dropped.push(...(await deletePluginSiteRows(remote, pluginId, siteId, meta.target.driver, meta.tables, options.strictRemote)));
        } finally {
          await remote.close();
        }
      }
    } catch (err) {
      remoteError = sanitizeProbeError(err);
    }
  }

  if (remoteError && options.strictRemote) return { ok: false, tables: dropped, error: remoteError };

  try {
    const db = await getDb();
    dropped.push(
      ...(dropTables
        ? await dropPluginOwnedTables(db, pluginId, driver, meta?.tables ?? [])
        : await deletePluginSiteRows(db, pluginId, siteId, driver, meta?.tables ?? [], options.strictRemote)),
    );
    await deleteAllPluginData(pluginId, siteId);
    await deletePluginSiteSettings(siteId, pluginId);
  } catch (err) {
    return { ok: false, tables: dropped, error: sanitizeProbeError(err) };
  }

  if (remoteError) {
    return {
      ok: true,
      tables: [...new Set(dropped)],
      error: `Plugin data on this site was removed. Tables on the separate database could not be dropped: ${remoteError}`,
    };
  }
  return { ok: true, tables: [...new Set(dropped)] };
}

/**
 * Delete a plugin's extracted files from `packages-installed/`.
 *
 * Uninstall used to drop only the database row, so every file the package
 * extracted stayed on disk and a later reinstall layered a new build over the
 * old one. Only paths inside `packages-installed/` are touched: a bundled
 * plugin (served from the source checkout via `bundledPath`) or anything that
 * resolves outside that root is left untouched. Now-empty `<id>/` and
 * `<id>/<version>/` parents are pruned on the way out.
 */
export function purgePluginFiles(manifest: Record<string, unknown> | undefined): {
  ok: boolean;
  error?: string;
} {
  const installedPath =
    manifest && typeof manifest.installedPath === "string" ? manifest.installedPath : "";
  if (!installedPath) return { ok: true };

  const root = path.resolve(packagesInstalledDir());
  const resolved = path.resolve(installedPath);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    // Not under our managed root — a bundled checkout or a stray path. Leave it.
    return { ok: true };
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    // Prune empty `<id>/<version>` and `<id>` parents, but keep the `plugins/`
    // (or `themes/`) collection directory itself.
    let parent = path.dirname(resolved);
    while (path.dirname(parent) !== root && parent.startsWith(root + path.sep)) {
      try {
        if (fs.readdirSync(parent).length > 0) break;
        fs.rmdirSync(parent);
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sanitizeProbeError(err) };
  }
}

/**
 * Delete every other version of a plugin once an update has succeeded.
 *
 * `installedPath` is the build that is live now:
 * `packages-installed/plugins/<id>/<version>/<revision>`. The installer already
 * drops other revisions inside `<version>/`, but older `<version>/` folders were
 * never removed, so they piled up on disk and stayed on the integrity page.
 * Only siblings under that plugin's own `<id>/` are touched; any other layout
 * is left alone. Copies of the row on other sites re-sync to the new path.
 */
export function purgeOtherPluginVersions(installedPath: string): {
  ok: boolean;
  removed: string[];
  error?: string;
} {
  const root = path.resolve(packagesInstalledDir());
  const resolved = path.resolve(installedPath);
  if (!resolved.startsWith(root + path.sep)) return { ok: true, removed: [] };
  const parts = path.relative(root, resolved).split(path.sep);
  if (parts.length !== 4 || parts[0] !== "plugins") return { ok: true, removed: [] };
  const [, pluginId, version] = parts;
  if (!pluginId || !version) return { ok: true, removed: [] };
  const pluginDir = resolvePathUnderBase(root, "plugins", pluginId);
  if (!pluginDir) return { ok: true, removed: [] };

  const removed: string[] = [];
  try {
    for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
      if (entry.name === version) continue;
      const target = resolvePathUnderBase(pluginDir, entry.name);
      if (!target) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(entry.name);
    }
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, removed, error: sanitizeProbeError(err) };
  }
}
