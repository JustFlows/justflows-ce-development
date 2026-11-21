import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { getTenantContext } from "../tenancy/context.js";
import { App, loadConfig } from "@justflows/core";
import { PluginLoader } from "@justflows/plugin-api";
import type { PluginModule } from "@justflows/sdk";
import { getDb } from "../database/db.js";
import { withRootPluginManifests } from "./plugin-root-manifest.js";
import { getHooks } from "../runtime/hooks.js";
import {
  mergeLoadedPluginManifest,
  pluginsDir,
  setLivePluginSettingsSchemaLookup,
} from "./plugins-db.js";
import { getSiteId } from "../themes/themes-db.js";
import { isSafePluginEntry, resolvePathUnderBase } from "../security/safe-path.js";
import { pluginBlockAdapter } from "../rendering/runtime-blocks.js";
import { createPluginDataApi } from "./plugin-data.js";
import { createPluginJobsApi, getDurableJobQueue, getPluginJobScheduler } from "./plugin-jobs.js";
import { createPluginSecretsApi } from "./plugin-secrets.js";
import { createPluginDatabasesApi } from "./plugin-databases.js";
import { createPluginCaptchaApi } from "./plugin-captcha.js";
import { createPluginAiApi } from "./plugin-ai.js";
import { createPluginTenancyApi } from "./plugin-tenancy.js";
import { createPluginNetworkApi } from "./plugin-network.js";
import { createPluginOutboundApi } from "./plugin-outbound.js";
import { createPluginQuotasApi } from "./plugin-quotas.js";
import { unregisterPluginMeters } from "../tenancy/quotas.js";
import { createPluginContentApi } from "./plugin-content.js";
import { createPluginFilesApi } from "./plugin-files.js";
import { registerOperatorKeyHook } from "./operator-keys.js";
import { isInstalled } from "../../middleware/install-guard.js";
import { getJustflowsVersion } from "../runtime/version.js";
import { recordDiagnosticError } from "../runtime/diagnostics.js";
import { registerMailTransport, unregisterMailTransports } from "../email/mail-transports.js";
import { unregisterCacheStores } from "../cache/cache-stores.js";
import { registerEmailTemplate } from "../email/email-templates.js";
import { resolvePlaceholderSync } from "../media/placeholders.js";

let app: App | null = null;
let loader: PluginLoader | null = null;
let initPromise: Promise<void> | null = null;
const pluginEmailTemplateCleanup = new Map<string, Array<() => void>>();

function unregisterPluginMail(pluginId: string): void {
  unregisterMailTransports(pluginId);
  for (const dispose of pluginEmailTemplateCleanup.get(pluginId) ?? []) dispose();
  pluginEmailTemplateCleanup.delete(pluginId);
}

/**
 * An installed package that does not match its baseline is not imported.
 * No baseline means an older install: it still loads and stays unverified.
 */
async function refuseUnverifiedPlugin(manifest: Record<string, unknown>): Promise<boolean> {
  const installedPath = typeof manifest.installedPath === "string" ? manifest.installedPath : null;
  if (!installedPath) return false;
  const { verifyInstalledDirectory } = await import("../security/extension-integrity.js");
  const report = await verifyInstalledDirectory(installedPath);
  if (report && (report.status === "verified" || report.status === "unverifiable")) return false;
  console.error("[plugins] integrity check refused load", JSON.stringify({
    id: report?.packageId ?? "",
    status: report?.status ?? "refused",
  }));
  const siteId = await runtimeSiteId();
  if (siteId) {
    const { auditLog } = await import("../security/audit-log.js");
    const paths = report
      ? [...report.modified, ...report.missing, ...report.unexpected].slice(0, 20)
      : [];
    void auditLog({
      siteId,
      action: "integrity.failed",
      outcome: "failure",
      target: report?.packageId ?? null,
      detail: `${report?.status ?? "refused"} ${paths.join(", ")}`.slice(0, 500),
    });
  }
  return true;
}

/**
 * With `JF_PLUGIN_SANDBOX=on`, a plugin that Justflows has not verified, that
 * the operator has not trusted, and that has no legacy grace runs in the
 * sandbox. Its code is not imported here. Where Node cannot sandbox, it is not
 * loaded at all: an unverified plugin never falls back to full access.
 */
async function sandboxedPluginModule(
  manifest: Record<string, unknown>,
  basePath: string,
  relativeCandidates: string[],
): Promise<PluginModule | null | "in-process"> {
  const trust = await import("../extensions/plugin-trust.js");
  if (trust.pluginSandboxMode() !== "on") return "in-process";
  const manifestPath = resolvePathUnderBase(basePath, "justflows.json");
  let fileManifest: Record<string, unknown> | null = null;
  try {
    fileManifest = manifestPath ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>) : null;
  } catch {
    fileManifest = null;
  }
  const pluginId = String(fileManifest?.id ?? manifest.id ?? "");
  const version = String(fileManifest?.version ?? manifest.version ?? "");
  if (!pluginId || !version) return "in-process";
  const hasRow = typeof manifest.installedPath === "string" || "id" in manifest;
  const state = await trust.trustForInstalledManifest(pluginId, version, manifest, hasRow).catch(() => null);
  if (state && state.state !== "unverified") return "in-process";
  const { sandboxSupported } = await import("./sandbox/sandbox-host.js");
  if (!sandboxSupported()) {
    console.error("[plugins] unverified plugin not loaded: this Node.js cannot sandbox it", JSON.stringify(pluginId));
    return null;
  }
  const entry = relativeCandidates
    .map((relative) => resolvePathUnderBase(basePath, relative))
    .find((candidate): candidate is string => !!candidate && fs.existsSync(candidate) && isSafePluginEntry(candidate) && !fs.lstatSync(candidate).isSymbolicLink());
  if (!entry || !fileManifest) return null;
  const { createSandboxedPluginModule } = await import("./sandbox/sandboxed-plugin.js");
  const { getTenantContext } = await import("../tenancy/context.js");
  return createSandboxedPluginModule({
    manifest: fileManifest as unknown as PluginModule["manifest"],
    pluginDir: basePath,
    entry,
    currentSiteId: () => getTenantContext()?.siteId ?? null,
    defaultSiteId: runtimeSiteId,
    report: (context, error) => recordDiagnosticError(`plugin:${pluginId} ${context}`, error),
  });
}

async function resolvePluginModule(
  manifest: Record<string, unknown>,
): Promise<PluginModule | null> {
  if (await refuseUnverifiedPlugin(manifest)) return null;
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

  /** An unverified plugin runs in the sandbox, or not at all, when sandboxing is on (justflows-ce#270). */
  const sandboxed = await sandboxedPluginModule(manifest, basePath, relativeCandidates);
  if (sandboxed !== "in-process") return sandboxed;

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

/**
 * The site whose active plugins this process should load. A request uses that
 * request's site. Boot has no request, and a multisite install then has more
 * than one row in `sites`, so getSiteId() is empty. Use the installation root
 * so the main site's plugins register and create their tables.
 */
async function runtimeSiteId(): Promise<string | null> {
  const current = await getSiteId();
  if (current) return current;
  const { installationRootSiteId } = await import("../tenancy/registry.js");
  return installationRootSiteId();
}

async function registerKnownPlugins(): Promise<void> {
  if (!loader) return;

  const siteId = await runtimeSiteId();
  if (!siteId) return;

  const db = await getDb();
  // Only active plugins. Importing a module runs its top-level code, so loading
  // every installed row meant "installed but not activated" already executed the
  // package — leaving no safe state in which to inspect one before enabling it.
  const siteRows = await db.query<{ plugin_id: string; manifest: string | Record<string, unknown> }>(
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active'",
    [siteId],
  );
  const rows = await withRootPluginManifests(siteId, siteRows);

  for (const row of rows) {
    if (loader.getPlugin(row.plugin_id)) continue;

    const manifest =
      typeof row.manifest === "string" ? JSON.parse(row.manifest) : (row.manifest ?? {});
    const pluginModule = await resolvePluginModule(manifest);
    if (!pluginModule) {
      console.error("[plugins] active plugin module could not be loaded:", JSON.stringify(row.plugin_id));
      continue;
    }

    try {
      loader.register(pluginModule);
    } catch (err) {
      console.error("[plugins] registration failed:", JSON.stringify(row.plugin_id), err);
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

  const siteId = await runtimeSiteId();
  if (!siteId) return;

  const db = await getDb();
  const siteRows = await db.query<{ plugin_id: string; manifest: unknown }>(
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active'",
    [siteId],
  );
  const rows = await withRootPluginManifests(siteId, siteRows);

  for (const row of rows) {
    try {
      const manifest = typeof row.manifest === "string"
        ? JSON.parse(row.manifest) as Record<string, unknown>
        : (row.manifest ?? {}) as Record<string, unknown>;
      if (await refuseUnverifiedPlugin(manifest)) continue;
      await loader.activate(row.plugin_id, siteId);
    } catch (err) {
      console.error("[plugins] activation failed", JSON.stringify(row.plugin_id), err);
    }
  }
}

/**
 * Plugins turned on at another site but not at the main site. The module is
 * shared by the whole process, so without this a plugin a sub-site activated
 * works until the next restart and then is gone there (its routes answer 404)
 * while its row still says active. Only plugins the main site has installed
 * and still offers to other sites are loaded, with the main site's manifest.
 */
async function activateOtherSitePlugins(): Promise<void> {
  if (!loader) return;
  const { installationRootSiteId } = await import("../tenancy/registry.js");
  const rootId = await installationRootSiteId().catch(() => null);
  if (!rootId) return;
  const { activePluginsOnOtherSites, isPluginOfferedToOtherSites } = await import("./plugin-multisite.js");
  const { rootPluginManifests } = await import("./plugin-root-manifest.js");
  const roots = await rootPluginManifests();
  const sites = await activePluginsOnOtherSites(rootId);
  for (const [siteId, pluginIds] of sites) {
    for (const pluginId of pluginIds) {
      if (loader.getPlugin(pluginId)?.state === "active") continue;
      const manifest = roots.get(pluginId);
      if (!manifest || !(await isPluginOfferedToOtherSites(pluginId, rootId))) continue;
      try {
        if (await refuseUnverifiedPlugin(manifest)) continue;
        if (!loader.getPlugin(pluginId)) {
          const pluginModule = await resolvePluginModule(manifest);
          if (!pluginModule) {
            console.error("[plugins] active plugin module could not be loaded:", JSON.stringify(pluginId));
            continue;
          }
          loader.register(pluginModule);
        }
        await loader.activate(pluginId, siteId);
      } catch (err) {
        console.error("[plugins] activation failed", JSON.stringify(pluginId), err);
      }
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
      registerOperatorKeyHook(app.hooks);
      await app.start();
      app.hooks.setPluginSiteGate(
        (pluginId, siteId, scope) => {
          const current = getTenantContext();
          if (!current || current.siteId !== siteId || current.activePluginIds === null) return true;
          if (current.activePluginIds.has(pluginId)) return true;
          return scope === "network" && current.networkPluginIds?.has(pluginId) === true;
        },
        () => getTenantContext()?.siteId,
      );
      const { getJfCache } = await import("../cache/jf-cache.js");
      const { createPluginCacheApi, pluginCacheStoreRegistrar } = await import("./plugin-cache.js");
      loader = new PluginLoader(app, {
        justflowsVersion: getJustflowsVersion(),
        // Mandatory for every plugin: logged errors and failing hook handlers
        // land in Admin → System → Diagnostics under the plugin's id.
        errorReporter: (pluginId, context, error) =>
          recordDiagnosticError(`plugin:${pluginId} ${context}`, error),
        cacheFactory: (pluginId, permissions, siteId) =>
          createPluginCacheApi(
            pluginId,
            getJfCache(),
            pluginCacheStoreRegistrar(pluginId, permissions, siteId),
          ),
        cacheCleanup: unregisterCacheStores,
        dataFactory: (pluginId, siteId) => createPluginDataApi(pluginId, siteId),
        jobsFactory: (pluginId) => createPluginJobsApi(pluginId),
        // Emitted hooks follow the request's or per-site job's site, like row calls (`pluginCallSiteId`).
        currentSiteId: () => getTenantContext()?.siteId,
        eventPublisher: async (event, payload, siteId) => {
          const { enqueueWebhookEvent } = await import("../http/webhooks.js");
          await enqueueWebhookEvent(event, payload, { siteId, source: "system" });
        },
        mailFactory: (pluginId, permissions) => ({
          send: async (message) => {
            if (!permissions.has("mail:send"))
              throw new Error(`Plugin "${pluginId}" requires the mail:send permission`);
            const { checkMailAttachments, sendMail } = await import("../email/mail.js");
            let attachments: ReturnType<typeof checkMailAttachments>;
            try {
              attachments = checkMailAttachments(message.attachments);
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            const result = await sendMail({
              ...message,
              ...(attachments ? { attachments } : {}),
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
        jobsCleanup: (pluginId) => {
          getPluginJobScheduler().unregisterPrefix(pluginId);
          getDurableJobQueue().unregisterPrefix(pluginId);
        },
        mailCleanup: unregisterPluginMail,
        secretsFactory: (pluginId, siteId) => createPluginSecretsApi(pluginId, siteId),
        databasesFactory: (pluginId, siteId, permissions) =>
          createPluginDatabasesApi(pluginId, siteId, permissions),
        tenancyFactory: (pluginId, permissions) => createPluginTenancyApi(pluginId, permissions),
        networkFactory: (pluginId) => createPluginNetworkApi(pluginId),
        outboundFactory: (pluginId) => createPluginOutboundApi(pluginId),
        runForSite: async (siteId, fn) => {
          const { runPluginCallForSite } = await import("./plugin-call-site.js");
          return runPluginCallForSite(siteId, fn);
        },
        quotasFactory: (pluginId, permissions, siteId) => createPluginQuotasApi(pluginId, permissions, siteId),
        quotasCleanup: unregisterPluginMeters,
        filesFactory: (pluginId, siteId) => createPluginFilesApi(pluginId, siteId),
        usersFactory: (pluginId, siteId) => ({
          create: async (input, actor) => {
            const { createUser, CreateUserSchema } = await import("../auth/users-admin.js");
            const parsed = CreateUserSchema.safeParse(input);
            if (!parsed.success) {
              return {
                ok: false,
                status: 400,
                error: parsed.error.issues[0]?.message ?? "Invalid user",
              };
            }
            try {
              const result = await createUser(parsed.data, {
                siteId,
                userId: actor.userId,
                role: actor.role,
                // The loader only lets a plugin create users in a role it registered.
                trustedCaller: true,
              });
              const body = result.body as { error?: string; id?: string; email?: string; username?: string; displayName?: string; role?: string };
              if (result.status >= 400 || !body.id || !body.email || !body.username || !body.displayName || !body.role) {
                return { ok: false, status: result.status, error: body.error ?? "Could not create the user." };
              }
              return {
                ok: true,
                user: {
                  id: body.id,
                  email: body.email,
                  username: body.username,
                  displayName: body.displayName,
                  role: body.role,
                },
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (/unique|duplicate/i.test(message)) {
                return { ok: false, status: 409, error: "A user with that email or username already exists." };
              }
              throw err;
            }
          },
          addRole: async (target, role, actor) => {
            const { addAdditionalRole } = await import("../auth/users-admin.js");
            return addAdditionalRole(siteId, target, role, actor);
          },
          removeRole: async (target, role, actor) => {
            const { removeAdditionalRole } = await import("../auth/users-admin.js");
            return removeAdditionalRole(siteId, target, role, actor);
          },
          sendPasswordSetup: async (target, actor) => {
            const { pluginCallSiteId } = await import("./request-site.js");
            const { findUserRoles } = await import("../auth/users-admin.js");
            const { sendPasswordSetup } = await import("../auth/password-reset.js");
            const site = pluginCallSiteId(siteId);
            const user = await findUserRoles(site, target);
            if (!user) return { ok: false, status: 404, error: "User not found." };
            return sendPasswordSetup(site, user.id, actor);
          },
          /** The loader has already checked that the actor is the member, or that the account is wholly the plugin's. */
          updateProfile: async (target, fields, actor) => {
            const { pluginCallSiteId } = await import("./request-site.js");
            const { emitUserEvent, findUserRoles } = await import("../auth/users-admin.js");
            const { validBirthDate } = await import("../account/personal.js");
            const { auditLog } = await import("../security/audit-log.js");
            const { getDb } = await import("../database/db.js");
            const site = pluginCallSiteId(siteId);
            const user = await findUserRoles(site, target);
            if (!user) return { ok: false, status: 404, error: "User not found." };
            if (fields.birthDate === undefined) return { ok: true };
            const birthDate = validBirthDate(fields.birthDate);
            if (birthDate === undefined) return { ok: false, status: 400, error: "Enter a date of birth as a real date, not in the future." };
            if ((user.birthDate ?? null) === birthDate) return { ok: true };
            const db = await getDb();
            await db.run("UPDATE users SET birth_date = ?, updated_at = ? WHERE id = ? AND site_id = ?", [birthDate, new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""), user.id, site]);
            await auditLog({ siteId: site, action: "user.birth_date_changed", actorId: actor.userId, actorRole: actor.role, target: user.id, detail: `${birthDate ? "set" : "cleared"} by plugin ${pluginId}` });
            await emitUserEvent("user.updated", user.id, site);
            return { ok: true };
          },
          /** The loader has already checked that every role of the user is the calling plugin's. */
          delete: async (target, actor) => {
            const { pluginCallSiteId } = await import("./request-site.js");
            const { deleteUser, findUserRoles } = await import("../auth/users-admin.js");
            const site = pluginCallSiteId(siteId);
            const user = await findUserRoles(site, target);
            if (!user) return { ok: false, status: 404, error: "User not found." };
            const result = await deleteUser(user.id, { siteId: site, userId: actor.userId, role: actor.role });
            return result.status < 400 ? { ok: true } : { ok: false, status: result.status, error: String((result.body as { error?: string }).error ?? "Could not delete the user.") };
          },
          get: async (userId) => {
            const { getUserRoles } = await import("../auth/users-admin.js");
            return getUserRoles(siteId, userId);
          },
          /** The request's site, like the i18n facade: a shared plugin module may have been loaded by another site. */
          find: async (target) => {
            const { pluginCallSiteId } = await import("./request-site.js");
            const { findUserRoles } = await import("../auth/users-admin.js");
            return findUserRoles(pluginCallSiteId(siteId), target);
          },
          search: async (input) => {
            const { pluginCallSiteId } = await import("./request-site.js");
            const { searchUsers } = await import("../auth/users-admin.js");
            return searchUsers(pluginCallSiteId(siteId), input.query, input.limit);
          },
          /** Only for an account on the calling site, so a plugin cannot probe other sites' accounts. */
          secondFactors: async (userId) => {
            const { pluginCallSiteId } = await import("./request-site.js");
            const { findUserRoles } = await import("../auth/users-admin.js");
            const user = await findUserRoles(pluginCallSiteId(siteId), { userId });
            if (!user) return null;
            const { secondFactorsOf } = await import("../auth/mfa-policy.js");
            const factors = await secondFactorsOf(user.id);
            return { totp: factors.totp, passkeys: factors.passkeys };
          },
        }),
        contentFactory: (pluginId, siteId) => createPluginContentApi(pluginId, siteId),
        placeholderResolver: (siteId, kind) => resolvePlaceholderSync(siteId, kind),
        i18nProvider: (siteId) => ({
          /**
           * The request's site, not the site that first loaded the shared module:
           * that site may be deleted, and listing its languages would insert a default row for it.
           */
          defaultLocale: async () => {
            const { pluginCallSiteId } = await import("./request-site.js");
            return (await import("../i18n/languages-db.js")).getDefaultLocale(pluginCallSiteId(siteId));
          },
          locales: async () => {
            const { pluginCallSiteId } = await import("./request-site.js");
            return (await import("../i18n/languages-db.js")).getActiveLocaleCodes(pluginCallSiteId(siteId));
          },
          // The request's site, like other plugin facades, so another site gets its own zone.
          timeZone: async () => {
            const { pluginCallSiteId } = await import("./request-site.js");
            const { getGeneralSettings } = await import("../settings/general-settings.js");
            const { isValidTimeZone } = await import("../i18n/datetime-format.js");
            const zone = (await getGeneralSettings(pluginCallSiteId(siteId))).timezone;
            return zone && isValidTimeZone(zone) ? zone : "UTC";
          },
          countries: async (locale?: string) => {
            const { listCountries } = await import("../i18n/countries.js");
            if (locale) return listCountries(locale);
            const { pluginCallSiteId } = await import("./request-site.js");
            const { getDefaultLocale } = await import("../i18n/languages-db.js");
            return listCountries(await getDefaultLocale(pluginCallSiteId(siteId)));
          },
        }),
        blockRegistry: pluginBlockAdapter(),
        coreCookies: async () => (await import("../security/cookie-registry.js")).getCoreCookies(),
        cookieOverrides: async (siteId) =>
          (await import("../security/cookie-registry.js")).getCookieOverrides(siteId),
        settingsAdapter: {
          get: async <T = unknown>(
            siteId: string,
            pluginId: string,
            key: string,
          ): Promise<T | undefined> => {
            const { getPluginSetting } = await import("./plugin-kv.js");
            const { pluginCallSiteId } = await import("./request-site.js");
            return getPluginSetting<T>(pluginId, pluginCallSiteId(siteId), key);
          },
          set: async (siteId: string, pluginId: string, key: string, value: unknown) => {
            const { setPluginSetting } = await import("./plugin-kv.js");
            const { pluginCallSiteId } = await import("./request-site.js");
            await setPluginSetting(pluginId, pluginCallSiteId(siteId), key, value);
          },
          delete: async (siteId: string, pluginId: string, key: string) => {
            const { deletePluginSetting } = await import("./plugin-kv.js");
            const { pluginCallSiteId } = await import("./request-site.js");
            await deletePluginSetting(pluginId, pluginCallSiteId(siteId), key);
          },
        },
        captchaFactory: (pluginId) => createPluginCaptchaApi(pluginId),
        aiFactory: () => createPluginAiApi(),
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
      await activateOtherSitePlugins();
    }
  })();

  return initPromise;
}

async function ensureRegistered(siteId: string, pluginId: string): Promise<void> {
  await ensurePluginRuntime();
  if (!loader) throw new Error("Plugin runtime is unavailable");
  if (loader.getPlugin(pluginId)) return;

  const db = await getDb();
  const siteRows = await db.query<{ plugin_id: string; manifest: string | Record<string, unknown> }>(
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
    [siteId, pluginId],
  );
  const rows = await withRootPluginManifests(siteId, siteRows);
  const manifest =
    rows[0]?.manifest && typeof rows[0].manifest === "string"
      ? JSON.parse(rows[0].manifest)
      : (rows[0]?.manifest ?? {});
  const pluginModule = await resolvePluginModule(manifest);
  if (!pluginModule) throw new Error(`Plugin module for "${pluginId}" could not be loaded`);
  loader.register(pluginModule);
}

export async function runtimeActivatePlugin(siteId: string, pluginId: string): Promise<void> {
  await ensureRegistered(siteId, pluginId);
  if (!loader) throw new Error("Plugin runtime is unavailable");
  const { pluginRequirementError } = await import("./plugin-requirements.js");
  const loadedManifest = loader.getPlugin(pluginId)?.manifest;
  const requirement = await pluginRequirementError(siteId, loadedManifest, "activate");
  if (requirement) throw new Error(requirement);
  await loader.activate(pluginId, siteId);
  const loaded = loader.getPlugin(pluginId);
  if (loaded) {
    await mergeLoadedPluginManifest(
      siteId,
      pluginId,
      JSON.parse(JSON.stringify(loaded.manifest)) as Record<string, unknown>,
    );
  }
  const { refreshWebhookEventHooks } = await import("../http/webhooks.js");
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
