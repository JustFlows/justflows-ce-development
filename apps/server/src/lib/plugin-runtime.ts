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
import { isInstalled } from "../middleware/install-guard.js";
import { getJustflowsVersion } from "./version.js";
import { registerMailTransport, unregisterMailTransports } from "./mail-transports.js";
import { registerEmailTemplate } from "./email-templates.js";

let app: App | null = null;
let loader: PluginLoader | null = null;
let initPromise: Promise<void> | null = null;
const pluginEmailTemplateCleanup = new Map<string, Array<() => void>>();

function unregisterPluginMail(pluginId: string): void {
  unregisterMailTransports(pluginId);
  for (const dispose of pluginEmailTemplateCleanup.get(pluginId) ?? []) dispose();
  pluginEmailTemplateCleanup.delete(pluginId);
}

async function resolvePluginModule(
  manifest: Record<string, unknown>,
): Promise<PluginModule | null> {
  const bundledPath = typeof manifest.bundledPath === "string" ? manifest.bundledPath : null;
  const installedPath = typeof manifest.installedPath === "string" ? manifest.installedPath : null;
  const basePath = installedPath ?? bundledPath;
  if (!basePath) return null;

  const serverEntry =
    typeof manifest.entrypoints === "object" &&
    manifest.entrypoints &&
    typeof (manifest.entrypoints as Record<string, unknown>).server === "string"
      ? ((manifest.entrypoints as Record<string, unknown>).server as string)
      : null;

  const relativeCandidates = [serverEntry, "dist/index.js", "index.js"].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const relative of relativeCandidates) {
    const entry = resolvePathUnderBase(basePath, relative);
    if (!entry || !fs.existsSync(entry) || !isSafePluginEntry(entry)) continue;

    let mtimeMs = 0;
    try {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }

    try {
      // A reinstall to a revisioned directory already yields a fresh URL; the
      // mtime query is the belt-and-braces path for the case where the same
      // directory is re-extracted in place, so Node's ESM cache does not keep
      // serving the previous build.
      const url = `${pathToFileURL(entry).href}?v=${Math.round(mtimeMs)}`;
      const mod = await import(url);
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
      typeof row.manifest === "string" ? JSON.parse(row.manifest) : (row.manifest ?? {});
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
  const rows = await db.query<{ plugin_id: string; manifest: unknown }>(
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active'",
    [siteId],
  );

  for (const row of rows) {
    if (isRuntimeSkippedFirstParty(row.plugin_id, row.manifest)) continue;
    try {
      await loader.activate(row.plugin_id, siteId);
    } catch (err) {
      console.error(`[plugins] activation failed for ${row.plugin_id}:`, err);
    }
  }
}

/**
 * First-party plugins whose behaviour the host renders itself, so their module is
 * normally left inactive at runtime.
 *
 * - `justflows.analytics` / `justflows.gallery` stay skipped unconditionally —
 *   their modules would double-count page views or expose a public page.
 * - `justflows.seo` is skipped **unless** its installed manifest declares
 *   `hostCooperative: true`. The SEO Toolkit package sets that flag from its
 *   `justflows.json`; it means the module only augments (feed routes,
 *   autodiscovery) and never re-registers `/sitemap.xml` or a full `<head>`
 *   block, so the host may safely activate it. An older SEO package without the
 *   flag stays skipped.
 */
function isRuntimeSkippedFirstParty(pluginId: string, manifest: unknown): boolean {
  if (pluginId === "justflows.analytics" || pluginId === "justflows.gallery") return true;
  if (pluginId === "justflows.seo") return !manifestIsHostCooperative(manifest);
  return false;
}

function manifestIsHostCooperative(manifest: unknown): boolean {
  const parsed =
    typeof manifest === "string"
      ? (() => {
          try {
            return JSON.parse(manifest) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : ((manifest as Record<string, unknown> | null) ?? {});
  return parsed.hostCooperative === true;
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
        justflowsVersion: getJustflowsVersion(),
        cacheFactory: (pluginId) => createPluginCacheApi(pluginId, getJfCache()),
        dataFactory: (pluginId, siteId) => createPluginDataApi(pluginId, siteId),
        jobsFactory: (pluginId) => createPluginJobsApi(pluginId),
        mailFactory: (pluginId, permissions) => ({
          send: async (message) => {
            if (!permissions.has("mail:send"))
              throw new Error(`Plugin "${pluginId}" requires the mail:send permission`);
            const { sendMail } = await import("./mail.js");
            const result = await sendMail({
              ...message,
              type: `plugin:${pluginId}`,
              transactional: true,
            });
            return result.ok
              ? { ok: true, ...(result.messageId ? { messageId: result.messageId } : {}) }
              : { ok: false, error: result.error };
          },
          register: (transport) => {
            if (!permissions.has("mail:transport"))
              throw new Error(`Plugin "${pluginId}" requires the mail:transport permission`);
            registerMailTransport(pluginId, transport);
          },
          registerTemplate: (template) => {
            if (!permissions.has("mail:templates"))
              throw new Error(`Plugin "${pluginId}" requires the mail:templates permission`);
            if (!template.key.startsWith(`${pluginId}.`))
              throw new Error(`Plugin email template keys must start with "${pluginId}."`);
            const dispose = registerEmailTemplate({
              ...template,
              owner: pluginId,
              disableSafe: template.disableSafe ?? true,
            });
            const cleanup = pluginEmailTemplateCleanup.get(pluginId) ?? [];
            cleanup.push(dispose);
            pluginEmailTemplateCleanup.set(pluginId, cleanup);
          },
        }),
        jobsCleanup: (pluginId) => getPluginJobScheduler().unregisterPrefix(pluginId),
        mailCleanup: unregisterPluginMail,
        secretsFactory: (pluginId, siteId) => createPluginSecretsApi(pluginId, siteId),
        databasesFactory: (pluginId, siteId, permissions) =>
          createPluginDatabasesApi(pluginId, siteId, permissions),
        contentFactory: (pluginId, siteId) => createPluginContentApi(pluginId, siteId),
        i18nProvider: (siteId) => ({
          defaultLocale: async () =>
            (await import("./i18n/languages-db.js")).getDefaultLocale(siteId),
          locales: async () =>
            (await import("./i18n/languages-db.js")).getActiveLocaleCodes(siteId),
        }),
        blockRegistry: pluginBlockAdapter(),
        coreCookies: async () => (await import("./cookie-registry.js")).getCoreCookies(),
        cookieOverrides: async (siteId) =>
          (await import("./cookie-registry.js")).getCookieOverrides(siteId),
        settingsAdapter: {
          get: async <T = unknown>(
            siteId: string,
            pluginId: string,
            key: string,
          ): Promise<T | undefined> => {
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

    if (isInstalled()) {
      await registerKnownPlugins();
      await activateActivePlugins();
    }
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
      : (rows[0]?.manifest ?? {});
  const pluginModule = await resolvePluginModule(manifest);
  if (!pluginModule) throw new Error(`Plugin module for "${pluginId}" could not be loaded`);
  loader.register(pluginModule);
}

export async function runtimeActivatePlugin(siteId: string, pluginId: string): Promise<void> {
  if (pluginId === "justflows.analytics" || pluginId === "justflows.gallery") return;
  if (pluginId === "justflows.seo") {
    const db = await getDb();
    const rows = await db.query<{ manifest: unknown }>(
      "SELECT manifest FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
      [siteId, pluginId],
    );
    if (isRuntimeSkippedFirstParty(pluginId, rows[0]?.manifest)) return;
  }
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
  const { refreshWebhookEventHooks } = await import("./webhooks.js");
  await refreshWebhookEventHooks();
}

export async function runtimeDeactivatePlugin(siteId: string, pluginId: string): Promise<void> {
  await ensurePluginRuntime();
  if (!loader) return;
  await loader.deactivate(pluginId, siteId);
}

/**
 * Forget a plugin module so a subsequent activate re-imports it. Call after a
 * (re)install or an uninstall — otherwise the loader keeps the previously
 * imported module and the new build never runs without a process restart.
 */
export async function runtimeUnloadPlugin(pluginId: string): Promise<void> {
  await ensurePluginRuntime();
  loader?.unregister(pluginId);
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
