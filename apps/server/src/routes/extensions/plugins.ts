import { Router } from "express";
import { requireRole, requireSession } from "../../middleware/auth.js";
import { isInstallationRootRequest } from "../../lib/tenancy/access.js";
import { param } from "../../lib/http/params.js";
import {
  deletePlugin,
  getPlugin,
  insertPlugin,
  pluginToDto,
  type PluginRow,
} from "../../lib/plugins/plugins-db.js";
import { activatePluginAdmin, deactivatePluginAdmin } from "../../lib/plugins/plugins-admin.js";
import multer from "multer";
import { assertPackageIsTrusted } from "../../lib/extensions/package-trust.js";
import { sendPackageInstallError } from "../../lib/extensions/package-install-error.js";
import { packagesInstalledDir } from "../../lib/extensions/packages-dir.js";
import { auditFromRequest } from "../../lib/security/audit-log.js";
import { recordInstalledPackageBaseline } from "../../lib/security/extension-integrity.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { getJustflowsVersion } from "../../lib/runtime/version.js";
import rateLimit from "express-rate-limit";
import { admitPackageUpload, multipartLimits, PACKAGE_UPLOAD_BYTES, withMultipartErrors } from "../../lib/security/upload-admission.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: multipartLimits(PACKAGE_UPLOAD_BYTES) });
// Extension and import uploads unpack archives and touch the filesystem;
// counted per client before anything is buffered.
const packageUploadRequestLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function noStore(res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader("Cache-Control", "private, no-store");
}

type SettingsSchema = NonNullable<ReturnType<typeof pluginToDto>["settingsSchema"]>;

/**
 * The plugin's settings form for this site. The plugin may drop fields or fill
 * select options through `plugin.settings.schema`; only fields it keeps are
 * shown or saved. A failed or malformed filter result keeps the manifest form.
 */
async function settingsSchemaForSite(plugin: PluginRow, siteId: string): Promise<SettingsSchema> {
  const schema: SettingsSchema = { ...(pluginToDto(plugin).settingsSchema ?? {}) };
  const { getRuntimeHooks } = await import("../../lib/plugins/plugin-runtime.js");
  const hooks = getRuntimeHooks();
  if (!hooks.has("plugin.settings.schema")) return schema;
  const filtered = await hooks
    .applyFilter("plugin.settings.schema", schema, { pluginId: plugin.plugin_id, siteId }, { siteId, source: "http" })
    .catch(() => schema);
  if (!filtered || typeof filtered !== "object" || Array.isArray(filtered)) return schema;
  /** A plugin can narrow its own form, never add fields the manifest did not declare. */
  const out: SettingsSchema = {};
  for (const [key, field] of Object.entries(filtered as Record<string, unknown>)) {
    if (schema[key] && field && typeof field === "object") out[key] = { ...schema[key], ...(field as object), type: schema[key].type };
  }
  return out;
}

async function readPluginSettings(
  plugin: PluginRow,
  siteId: string,
): Promise<{
  schema: NonNullable<ReturnType<typeof pluginToDto>["settingsSchema"]> | Record<string, never>;
  values: Record<string, unknown>;
  languages: Array<{ code: string; nativeName?: string; isDefault?: boolean }>;
}> {
  const { ensurePluginRuntime, getRuntimeHooks } = await import("../../lib/plugins/plugin-runtime.js");
  await ensurePluginRuntime();
  const { getPluginSetting } = await import("../../lib/plugins/plugin-kv.js");
  const { listLanguages, getDefaultLocale } = await import("../../lib/i18n/languages-db.js");
  const { asLocaleMap } = await import("../../lib/i18n/locale-map.js");
  const schema = await settingsSchemaForSite(plugin, siteId);
  const languages = await listLanguages(siteId, true);
  const defaultLocale = await getDefaultLocale(siteId);
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    const raw = (await getPluginSetting(plugin.plugin_id, siteId, key)) ?? schema[key]?.default;
    values[key] = schema[key]?.localized ? asLocaleMap(raw, defaultLocale) : raw;
  }
  const merged = (await getRuntimeHooks().applyFilter(
    "plugin.settings",
    values,
    { pluginId: plugin.plugin_id, siteId },
    { siteId, source: "http" },
  )) as Record<string, unknown>;

  const { resolveSettingsSchema } = await import("../../lib/plugins/plugin-settings-options.js");
  return { schema: resolveSettingsSchema(schema, defaultLocale), values: merged, languages };
}

// The installed extension set and its versions fingerprint the site.
router.get("/", requireRole("administrator", "editor"), async (req, res) => {
  const session = req.session!;

  try {
    const { ensurePluginRuntime } = await import("../../lib/plugins/plugin-runtime.js");
    await ensurePluginRuntime();
    const { listVisiblePlugins } = await import("../../lib/plugins/plugin-multisite.js");
    const plugins = await listVisiblePlugins(session.siteId);
    res.json({ plugins });
  } catch (err) {
    sendServerError(res, "plugins", err);
  }
});

router.post("/", packageUploadRequestLimit, requireRole("administrator"), admitPackageUpload("plugin"), withMultipartErrors(upload.single("file")), async (req, res) => {
  if (!isInstallationRootRequest()) {
    res.status(403).json({ error: "Plugins are installed on the main site." });
    return;
  }
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      res.status(413).json({ error: "File too large (max 50 MB)" });
      return;
    }
    if (!file.originalname.endsWith(".jfpkg") && !file.originalname.endsWith(".zip")) {
      res.status(400).json({ error: "Only .jfpkg files are accepted" });
      return;
    }

    const { PackageInstaller } = await import("@justflows/installer");
    const installer = new PackageInstaller();
    const packagesDir = packagesInstalledDir();

    // Both checks run inside the installer, while the package is still staged.
    // Run after the install they left a refused package sitting in its final
    // location with nothing to clean it up.
    const siteId = req.session?.siteId;
    const result = await installer.installFromBuffer(file.buffer, {
      packagesDir,
      justflowsVersion: getJustflowsVersion(),
      source: "upload",
      // Plugins run as code — install each build to its own directory so a
      // reinstall is imported fresh without a process restart.
      revisioned: true,
      verify: async (manifest, digest) => {
        if (manifest.type !== "plugin") {
          throw new Error("Uploaded package is not a plugin (manifest.type must be 'plugin')");
        }
        assertPackageIsTrusted(manifest as unknown as Record<string, unknown>, digest);
        if (!siteId) return;
        const { pluginRequirementError } = await import("../../lib/plugins/plugin-requirements.js");
        const requirement = await pluginRequirementError(siteId, manifest, "install");
        if (requirement) throw new Error(requirement);
      },
    });
    await recordInstalledPackageBaseline({
      packageDir: result.installedPath,
      packageId: result.manifest.id,
      packageType: "plugin",
      version: result.manifest.version,
      archiveDigest: result.digest,
    });
    if (!siteId) {
      res.status(503).json({ error: "No site found — complete install first" });
      return;
    }

    const plugin = await insertPlugin(siteId, {
      pluginId: result.manifest.id,
      version: result.manifest.version,
      manifest: {
        ...result.manifest,
        installedPath: result.installedPath,
      },
      status: "installed",
    });

    auditFromRequest(req, "plugin.installed", {
      target: result.manifest.id,
      detail: `version=${result.manifest.version} digest=${result.digest.slice(0, 16)}`,
    });
    // Drop any previously imported module so the next activate picks up this
    // build without a process restart.
    const { getRuntimeHooks, runtimeUnloadPlugin } = await import("../../lib/plugins/plugin-runtime.js");
    await runtimeUnloadPlugin(result.manifest.id).catch(() => null);
    await getRuntimeHooks().dispatchAction(
      "plugin.installed",
      { pluginId: result.manifest.id, version: result.manifest.version, siteId },
      { siteId, source: "http" },
    );
    res.json({ plugin });
  } catch (err) {
    sendPackageInstallError(res, err);
  }
});

router.post("/:id/multisite", requireRole("administrator"), async (req, res) => {
  if (!isInstallationRootRequest()) {
    res.status(403).json({ error: "This is managed on the main site." });
    return;
  }
  const session = req.session!;
  const pluginId = param(req.params.id);
  const row = await getPlugin(session.siteId, pluginId);
  if (!row) {
    res.status(404).json({ error: "Plugin not found" });
    return;
  }
  const { setPluginOfferedToOtherSites } = await import("../../lib/plugins/plugin-multisite.js");
  const enabled = req.body?.enabled === true;
  await setPluginOfferedToOtherSites(pluginId, session.siteId, enabled);
  res.json({ ok: true, multisiteEnabled: enabled });
});

router.post("/:id/activate", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const pluginId = param(req.params.id);
  if (!isInstallationRootRequest()) {
    const { prepareSubsitedActivation } = await import("../../lib/plugins/plugin-multisite.js");
    const ready = await prepareSubsitedActivation(session.siteId, pluginId);
    if (!ready.ok) {
      res.status(403).json({ error: ready.error });
      return;
    }
  }
  const result = await activatePluginAdmin(pluginId, {
    siteId: session.siteId,
    userId: session.userId,
    role: session.role,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });
  res.status(result.status).json(result.body);
});

router.post("/:id/deactivate", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const result = await deactivatePluginAdmin(param(req.params.id), {
    siteId: session.siteId,
    userId: session.userId,
    role: session.role,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });
  res.status(result.status).json(result.body);
});

router.delete("/:id", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const pluginId = param(req.params.id);
  const row = await getPlugin(session.siteId, pluginId);
  const version = row?.version ?? "";
  const { runtimeDeactivatePlugin, runtimeDeletePluginData, runtimeUnloadPlugin, getRuntimeHooks } =
    await import("../../lib/plugins/plugin-runtime.js");
  const {
    purgePluginFiles,
    purgePluginStorage,
    purgePluginContent,
    shouldPurgePluginContent,
    shouldPurgePluginData,
  } = await import("../../lib/plugins/plugin-purge.js");
  if (!isInstallationRootRequest()) {
    res.status(403).json({ error: "Only the main site can remove a plugin." });
    return;
  }
  const shouldPurge = await shouldPurgePluginData(session.siteId, pluginId);
  const shouldPurgeContent = await shouldPurgePluginContent(session.siteId, pluginId);
  const { getDb } = await import("../../lib/database/db.js");
  const db = await getDb();
  await db.run("DELETE FROM plugins WHERE plugin_id = ? AND site_id <> ?", [pluginId, session.siteId]);
  const { otherSitesHavePlugin } = await import("../../lib/plugins/plugin-multisite.js");
  const others = await otherSitesHavePlugin(pluginId, session.siteId);

  let hookError: string | undefined;
  try {
    await runtimeDeletePluginData(session.siteId, pluginId);
  } catch (err) {
    const { sanitizeProbeError } = await import("../../lib/database/db-probe.js");
    hookError = sanitizeProbeError(err);
  }

  if (shouldPurgeContent) {
    const purgedContent = await purgePluginContent(session.siteId, pluginId, row?.manifest);
    if (!purgedContent.ok) {
      res.status(500).json({
        error: purgedContent.error ?? hookError ?? "Plugin pages and posts could not be deleted",
      });
      return;
    }
  }

  if (shouldPurge) {
    const purged = await purgePluginStorage(session.siteId, pluginId);
    if (!purged.ok) {
      res
        .status(500)
        .json({ error: purged.error ?? hookError ?? "Plugin data could not be deleted" });
      return;
    }
  }

  // Deactivate unloads the process-wide module. Leave it running while another
  // site still has the plugin.
  if (!others) await runtimeDeactivatePlugin(session.siteId, pluginId);
  const ownsPackage = isInstallationRootRequest() && !others;
  if (ownsPackage) await runtimeUnloadPlugin(pluginId).catch(() => null);
  const filesPurged = ownsPackage ? purgePluginFiles(row?.manifest) : { ok: true as const };
  await deletePlugin(session.siteId, pluginId);
  auditFromRequest(req, "plugin.deleted", { target: pluginId });
  await getRuntimeHooks()
    .dispatchAction(
      "plugin.uninstalled",
      { pluginId, version, siteId: session.siteId },
      { siteId: session.siteId, source: "system" },
    )
    .catch(() => null);
  const { revalidateOnUpdate } = await import("../../lib/cache/cache-revalidate.js");
  await revalidateOnUpdate("plugin");
  res.json({
    ok: true,
    ...(filesPurged.ok
      ? {}
      : { warning: `Plugin removed, but its files could not be deleted: ${filesPurged.error}` }),
  });
});

// Registered ahead of "/:id" so the literal path is not swallowed by the param.
router.get("/editor-panels", requireSession, async (req, res) => {
  try {
    const { syncBundledPlugins } = await import("../../lib/plugins/plugins-db.js");
    await syncBundledPlugins(req.session!.siteId).catch(() => false);
    const { listEditorPanels } = await import("../../lib/admin/editor-panels.js");
    res.json({ panels: await listEditorPanels(req.session!.siteId) });
  } catch (err) {
    sendServerError(res, "plugins", err);
  }
});

router.get("/workspace-panels", requireSession, async (req, res) => {
  try {
    const { listWorkspacePanels } = await import("../../lib/admin/workspace-panels.js");
    res.json({ panels: await listWorkspacePanels(req.session!.siteId) });
  } catch (err) {
    sendServerError(res, "plugins", err);
  }
});

router.get("/admin-menu", requireSession, async (req, res) => {
  try {
    const { listPluginAdminMenu } = await import("../../lib/admin/admin-menu.js");
    res.json({ items: await listPluginAdminMenu(req.session!.siteId) });
  } catch (err) {
    sendServerError(res, "plugins", err);
  }
});

router.get("/:id", requireRole("administrator", "editor"), async (req, res) => {
  const plugin = await getPlugin(req.session!.siteId, param(req.params.id));
  if (!plugin) {
    res.status(404).json({ error: "Plugin not found" });
    return;
  }
  res.json({ plugin: pluginToDto(plugin) });
});

router.get("/:id/settings", requireRole("administrator"), async (req, res) => {
  try {
    const pluginId = param(req.params.id);
    const plugin = await getPlugin(req.session!.siteId, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    noStore(res);
    res.json(await readPluginSettings(plugin, req.session!.siteId));
  } catch (err) {
    sendServerError(res, "plugins", err);
  }
});

router.put("/:id/settings", requireRole("administrator"), async (req, res) => {
  try {
    const pluginId = param(req.params.id);
    const plugin = await getPlugin(req.session!.siteId, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { setPluginSetting } = await import("../../lib/plugins/plugin-kv.js");
    const { ensurePluginRuntime, getRuntimeHooks } = await import("../../lib/plugins/plugin-runtime.js");
    await ensurePluginRuntime();
    const siteId = req.session!.siteId;
    const schema = await settingsSchemaForSite(plugin, siteId);
    let next: Record<string, unknown> = {};
    for (const key of Object.keys(schema)) {
      if (!(key in body)) continue;
      const { checkSettingValue } = await import("../../lib/plugins/plugin-settings-options.js");
      const checked = checkSettingValue(schema[key], body[key]);
      if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
      }
      next[key] = checked.value;
    }
    next = (await getRuntimeHooks().applyFilter(
      "plugin.settings.write",
      next,
      { pluginId, siteId },
      { siteId, source: "http" },
    )) as Record<string, unknown>;
    for (const [key, value] of Object.entries(next)) {
      if (!(key in schema)) continue;
      await setPluginSetting(pluginId, siteId, key, value);
    }
    const { revalidateOnUpdate } = await import("../../lib/cache/cache-revalidate.js");
    await revalidateOnUpdate("plugin");
    noStore(res);
    res.json(await readPluginSettings(plugin, siteId));
  } catch (err) {
    sendServerError(res, "plugins", err);
  }
});

router.get("/:id/data/:collection", requireRole("administrator"), async (req, res) => {
  const pluginId = param(req.params.id);
  const collection = param(req.params.collection);
  const { createPluginDataApi } = await import("../../lib/plugins/plugin-data.js");
  const store = createPluginDataApi(pluginId, req.session!.siteId);
  res.json({ items: await store.list(collection) });
});

export default router;
