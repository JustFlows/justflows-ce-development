// SPDX-License-Identifier: MIT

import fs from "node:fs";
import {
  PLUGIN_DELETE_CONTENT_SETTING,
  PLUGIN_DELETE_DATA_SETTING,
  type PluginDatabaseDriver,
  type PluginDatabaseTarget,
} from "@justflows/sdk";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import { sanitizeProbeError } from "./db-probe.js";
import {
  dropPluginOwnedTables,
  openTargetDatabase,
} from "./plugin-schema.js";
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
} from "./site-settings.js";
import { getDb } from "./db.js";
import { contentTypeSlugsFromManifest, deletePluginOwnedContentType } from "./plugin-content.js";
import { resolvePathUnderBase } from "./safe-path.js";

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
): Promise<{ ok: boolean; tables: string[]; error?: string }> {
  const driver = (process.env.DB_DRIVER as PluginDatabaseDriver | undefined) || "mysql";
  const dropped: string[] = [];
  let remoteError: string | undefined;

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
      dropped.push(...(await dropOnSeparateTarget(pluginId, meta, password)));
    } catch (err) {
      remoteError = sanitizeProbeError(err);
    }
  }

  try {
    const db = await getDb();
    dropped.push(...(await dropPluginOwnedTables(db, pluginId, driver, meta?.tables ?? [])));
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
