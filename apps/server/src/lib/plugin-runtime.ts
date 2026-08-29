import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { App, loadConfig } from "@justflows/core";
import { PluginLoader } from "@justflows/plugin-api";
import type { PluginModule } from "@justflows/sdk";
import { getDb } from "./db.js";
import { getHooks } from "./hooks.js";
import {
  mergeLoadedPluginManifest,
  pluginsDir,
  setLivePluginSettingsSchemaLookup,
} from "./plugins-db.js";
import { getSiteId } from "./themes-db.js";
import { isSafePluginEntry, resolvePathUnderBase } from "./safe-path.js";
import { pluginBlockAdapter } from "./runtime-blocks.js";
import { createPluginDataApi } from "./plugin-data.js";
import { createPluginJobsApi, getPluginJobScheduler } from "./plugin-jobs.js";
import { createPluginSecretsApi } from "./plugin-secrets.js";
import { createPluginDatabasesApi } from "./plugin-databases.js";
import { createPluginContentApi } from "./plugin-content.js";

let app: App | null = null;
let loader: PluginLoader | null = null;
let initPromise: Promise<void> | null = null;

async function resolvePluginModule(manifest: Record<string, unknown>): Promise<PluginModule | null> {
  const bundledPath = typeof manifest.bundledPath === "string" ? manifest.bundledPath : null;
  const installedPath = typeof manifest.installedPath === "string" ? manifest.installedPath : null;
  const basePath = installedPath ?? bundledPath;
  if (!basePath) return null;

  const serverEntry =
    typeof manifest.entrypoints === "object" &&
    manifest.entrypoints &&
    typeof (manifest.entrypoints as Record<string, unknown>).server === "string"
      ? (manifest.entrypoints as Record<string, unknown>).server as string
      : null;

  const relativeCandidates = [
    serverEntry,
    "dist/index.js",
    "index.js",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const relative of relativeCandidates) {
    const entry = resolvePathUnderBase(basePath, relative);
    if (!entry || !fs.existsSync(entry) || !isSafePluginEntry(entry)) continue;

    try {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }

    try {
      const mod = await import(pathToFileURL(entry).href);
      return (mod.default ?? mod) as PluginModule;
    } catch (err) {
      console.error(`[plugins] failed to import ${entry}:`, err);
      continue;
    }
  }

  return null;
}

async function registerKnownPlugins(): Promise<void> {
  if (!loader) return;

  const siteId = await getSiteId();
  if (!siteId) return;

  const db = await getDb();
  // Only active plugins. Importing a module runs its top-level code, so loading
  // every installed row meant "installed but not activated" already executed the
  // package — leaving no safe state in which to inspect one before enabling it.
  const rows = await db.query<{ plugin_id: string; manifest: string | Record<string, unknown> }>(
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active'",
    [siteId],
  );

  for (const row of rows) {
    if (loader.getPlugin(row.plugin_id)) continue;

    const manifest =
      typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest ?? {};
    const pluginModule = await resolvePluginModule(manifest);
    if (!pluginModule) continue;

    try {
      loader.register(pluginModule);
    } catch {
      // already registered or invalid manifest
    }
  }

  // Also scan bundled plugins directory for unregistered modules.
  const dir = pluginsDir();
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const pluginPath = path.join(dir, entry.name);
    const pluginModule = await resolvePluginModule({ bundledPath: pluginPath });
    if (!pluginModule) continue;
    try {
      loader.register(pluginModule);
    } catch {
      // already registered
    }
  }
}

async function activateActivePlugins(): Promise<void> {
  if (!loader) return;

  const siteId = await getSiteId();
  if (!siteId) return;

  const db = await getDb();
  const rows = await db.query<{ plugin_id: string }>(
    "SELECT plugin_id FROM plugins WHERE site_id = ? AND status = 'active'",
    [siteId],
  );

  for (const row of rows) {
    // SEO output is host-rendered from plugin settings + content fields.
    // Skip runtime activate so the installed 1.2.0 module cannot duplicate head tags.
    if (row.plugin_id === "justflows.seo") continue;
    // Analytics is host-recorded into plugin_data. Skip the 0.9.0 module so page
    // views are not counted twice and /justflows-analytics is not a public page.
    if (row.plugin_id === "justflows.analytics") continue;
    if (row.plugin_id === "justflows.forms") continue;
    if (row.plugin_id === "justflows.gallery") continue;
    try {
      await loader.activate(row.plugin_id, siteId);
    } catch (err) {
      console.error(`[plugins] activation failed for ${row.plugin_id}:`, err);
    }
  }
}

/** Bootstrap App + PluginLoader and activate plugins that are marked active in the DB. */
export async function ensurePluginRuntime(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (loader) return;

    try {
      app = new App(loadConfig());
      await app.start();
      const { getJfCache } = await import("./jf-cache.js");
      const { createPluginCacheApi } = await import("./plugin-cache.js");
      loader = new PluginLoader(app, {
        cacheFactory: (pluginId) => createPluginCacheApi(pluginId, getJfCache()),
        dataFactory: (pluginId, siteId) => createPluginDataApi(pluginId, siteId),
        jobsFactory: (pluginId) => createPluginJobsApi(pluginId),
        jobsCleanup: (pluginId) => getPluginJobScheduler().unregisterPrefix(pluginId),
        secretsFactory: (pluginId, siteId) => createPluginSecretsApi(pluginId, siteId),
        databasesFactory: (pluginId, siteId, permissions) =>
          createPluginDatabasesApi(pluginId, siteId, permissions),
        contentFactory: (pluginId, siteId) => createPluginContentApi(pluginId, siteId),
        blockRegistry: pluginBlockAdapter(),
        settingsAdapter: {
          get: async <T = unknown>(siteId: string, pluginId: string, key: string): Promise<T | undefined> => {
            const { getPluginSetting } = await import("./plugin-kv.js");
            return getPluginSetting<T>(pluginId, siteId, key);
          },
          set: async (siteId: string, pluginId: string, key: string, value: unknown) => {
            const { setPluginSetting } = await import("./plugin-kv.js");
            await setPluginSetting(pluginId, siteId, key, value);
          },
          delete: async (siteId: string, pluginId: string, key: string) => {
            const { deletePluginSetting } = await import("./plugin-kv.js");
            await deletePluginSetting(pluginId, siteId, key);
          },
        },
      });
      setLivePluginSettingsSchemaLookup((pluginId) => {
        const schema = loader?.getPlugin(pluginId)?.manifest.settingsSchema;
        if (!schema || Object.keys(schema).length === 0) return undefined;
        return schema;
      });
    } catch (err) {
      // Installed sites without full env can still serve pages; hooks use the fallback registry.
      console.error("[plugins] runtime failed to start:", err);
      initPromise = null;
      return;
    }

    await registerKnownPlugins();
    await activateActivePlugins();
  })();

  return initPromise;
}

async function ensureRegistered(siteId: string, pluginId: string): Promise<void> {
  await ensurePluginRuntime();
  if (!loader) throw new Error("Plugin runtime is unavailable");
  if (loader.getPlugin(pluginId)) return;

  const db = await getDb();
  const rows = await db.query<{ manifest: string | Record<string, unknown> }>(
    "SELECT manifest FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
    [siteId, pluginId],
  );
  const manifest =
    rows[0]?.manifest && typeof rows[0].manifest === "string"
      ? JSON.parse(rows[0].manifest)
      : rows[0]?.manifest ?? {};
  const pluginModule = await resolvePluginModule(manifest);
  if (!pluginModule) throw new Error(`Plugin module for "${pluginId}" could not be loaded`);
  loader.register(pluginModule);
}

export async function runtimeActivatePlugin(siteId: string, pluginId: string): Promise<void> {
  if (pluginId === "justflows.seo") return;
  if (pluginId === "justflows.analytics") return;
  if (pluginId === "justflows.forms") return;
  if (pluginId === "justflows.gallery") return;
  await ensureRegistered(siteId, pluginId);
  if (!loader) throw new Error("Plugin runtime is unavailable");
  await loader.activate(pluginId, siteId);
  const loaded = loader.getPlugin(pluginId);
  if (loaded) {
    await mergeLoadedPluginManifest(
      siteId,
      pluginId,
      JSON.parse(JSON.stringify(loaded.manifest)) as Record<string, unknown>,
    );
  }
}

export async function runtimeDeactivatePlugin(siteId: string, pluginId: string): Promise<void> {
  await ensurePluginRuntime();
  if (!loader) return;
  await loader.deactivate(pluginId, siteId);
}

/** Load the plugin if needed and run its `deleteData` hook. */
export async function runtimeDeletePluginData(siteId: string, pluginId: string): Promise<void> {
  await ensurePluginRuntime();
  if (!loader) return;
  if (!loader.getPlugin(pluginId)) {
    try {
      await ensureRegistered(siteId, pluginId);
    } catch {
      return;
    }
  }
  await loader.deleteData(pluginId, siteId);
}

/** Hooks registry used by HTTP handlers. Returns App hooks when the runtime is booted. */
export function getRuntimeHooks() {
  return app?.hooks ?? getHooks();
}

export function getPluginLoader(): PluginLoader | null {
  return loader;
}
