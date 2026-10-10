// SPDX-License-Identifier: MIT

import { createPluginDataApi } from "./plugin-data.js";
import { deleteSiteSetting, getSiteSetting, getSiteSettings } from "../settings/site-settings.js";

/** Plugin key-value rows (`ctx.settings`, Admin → Plugins → Settings). */
export const PLUGIN_SETTINGS_COLLECTION = "settings";
/** Encrypted `ctx.secrets` payloads. */
export const PLUGIN_SECRETS_COLLECTION = "secrets";
/** Host metadata for a plugin (applied schema, not merchant settings). */
export const PLUGIN_HOST_COLLECTION = "_host";
export const PLUGIN_HOST_SCHEMA_ITEM = "schema";
export const PLUGIN_HOST_SCHEMA_PASSWORD_ITEM = "schemaPassword";
export const PLUGIN_HOST_CONTENT_TYPES_ITEM = "contentTypes";
/** Root-site choice: other sites may activate this plugin. */
export const PLUGIN_HOST_MULTISITE_ITEM = "multisite";

function legacySettingKey(pluginId: string, key: string): string {
  return `plugin.${pluginId}:${key}`;
}

function legacyHostKey(pluginId: string, itemId: string): string | null {
  if (itemId === PLUGIN_HOST_SCHEMA_ITEM) return `plugin_schema:${pluginId}`;
  if (itemId === PLUGIN_HOST_SCHEMA_PASSWORD_ITEM) return `plugin_schema:${pluginId}:password`;
  return null;
}

export async function getPluginSetting<T = unknown>(
  pluginId: string,
  siteId: string,
  key: string,
): Promise<T | undefined> {
  const row = await createPluginDataApi(pluginId, siteId).get<T>(PLUGIN_SETTINGS_COLLECTION, key);
  if (row) return row.data;
  const legacy = await getSiteSetting<T>(siteId, legacySettingKey(pluginId, key));
  return legacy === null || legacy === undefined ? undefined : legacy;
}

/** Batch a plugin's settings, retaining per-key legacy fallback (including false/zero). */
export async function getPluginSettings(
  pluginId: string, siteId: string, keys: string[],
): Promise<Record<string, unknown>> {
  if (!keys.length) return {};
  const rows = await createPluginDataApi(pluginId, siteId).list(PLUGIN_SETTINGS_COLLECTION);
  const values = new Map(rows.map((row) => [row.id, row.data]));
  const missing = keys.filter((key) => !values.has(key));
  const legacy = await getSiteSettings(siteId, missing.map((key) => legacySettingKey(pluginId, key)));
  return Object.fromEntries(keys.map((key) => [key,
    values.has(key) ? values.get(key) : (legacy[legacySettingKey(pluginId, key)] ?? undefined),
  ]));
}

export async function setPluginSetting<T = unknown>(
  pluginId: string,
  siteId: string,
  key: string,
  value: T,
): Promise<void> {
  await createPluginDataApi(pluginId, siteId).put(PLUGIN_SETTINGS_COLLECTION, key, value);
  await deleteSiteSetting(siteId, legacySettingKey(pluginId, key));
}

export async function deletePluginSetting(pluginId: string, siteId: string, key: string): Promise<void> {
  await createPluginDataApi(pluginId, siteId).delete(PLUGIN_SETTINGS_COLLECTION, key);
  await deleteSiteSetting(siteId, legacySettingKey(pluginId, key));
}

export async function getPluginSecretCipher(
  pluginId: string,
  siteId: string,
  key: string,
): Promise<string | undefined> {
  const row = await createPluginDataApi(pluginId, siteId).get<string>(PLUGIN_SECRETS_COLLECTION, key);
  if (typeof row?.data === "string" && row.data) return row.data;
  const legacy = await getSiteSetting<string>(siteId, legacySettingKey(pluginId, `secret.${key}`));
  return legacy || undefined;
}

export async function setPluginSecretCipher(
  pluginId: string,
  siteId: string,
  key: string,
  cipher: string,
): Promise<void> {
  await createPluginDataApi(pluginId, siteId).put(PLUGIN_SECRETS_COLLECTION, key, cipher);
  await deleteSiteSetting(siteId, legacySettingKey(pluginId, `secret.${key}`));
}

export async function deletePluginSecretCipher(
  pluginId: string,
  siteId: string,
  key: string,
): Promise<void> {
  await createPluginDataApi(pluginId, siteId).delete(PLUGIN_SECRETS_COLLECTION, key);
  await deleteSiteSetting(siteId, legacySettingKey(pluginId, `secret.${key}`));
}

export async function getPluginHostItem<T = unknown>(
  pluginId: string,
  siteId: string,
  itemId: string,
): Promise<T | undefined> {
  const row = await createPluginDataApi(pluginId, siteId).get<T>(PLUGIN_HOST_COLLECTION, itemId);
  if (row) return row.data;
  const legacyKey = legacyHostKey(pluginId, itemId);
  if (!legacyKey) return undefined;
  const legacy = await getSiteSetting<T>(siteId, legacyKey);
  return legacy === null || legacy === undefined ? undefined : legacy;
}

export async function setPluginHostItem<T = unknown>(
  pluginId: string,
  siteId: string,
  itemId: string,
  value: T,
): Promise<void> {
  await createPluginDataApi(pluginId, siteId).put(PLUGIN_HOST_COLLECTION, itemId, value);
  const legacyKey = legacyHostKey(pluginId, itemId);
  if (legacyKey) await deleteSiteSetting(siteId, legacyKey);
}

export async function deletePluginHostItem(pluginId: string, siteId: string, itemId: string): Promise<void> {
  await createPluginDataApi(pluginId, siteId).delete(PLUGIN_HOST_COLLECTION, itemId);
  const legacyKey = legacyHostKey(pluginId, itemId);
  if (legacyKey) await deleteSiteSetting(siteId, legacyKey);
}
