import { Router } from "express";
import { requireRole, requireSession } from "../middleware/auth.js";
import { param } from "../lib/params.js";
import {
  activatePlugin,
  deactivatePlugin,
  deletePlugin,
  getPlugin,
  insertPlugin,
  listPlugins,
  pluginToDto,
  type PluginRow,
} from "../lib/plugins-db.js";
import multer from "multer";
import { assertPackageIsTrusted } from "../lib/package-trust.js";
import { sendPackageInstallError } from "../lib/package-install-error.js";
import { packagesInstalledDir } from "../lib/packages-dir.js";
import { auditFromRequest } from "../lib/audit-log.js";
import { sendServerError } from "../lib/send-error.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function noStore(res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader("Cache-Control", "private, no-store");
}

async function readPluginSettings(
  plugin: PluginRow,
  siteId: string,
): Promise<{
  schema: NonNullable<ReturnType<typeof pluginToDto>["settingsSchema"]> | Record<string, never>;
  values: Record<string, unknown>;
  languages: Array<{ code: string; nativeName?: string; isDefault?: boolean }>;
}> {
  const { ensurePluginRuntime, getRuntimeHooks } = await import("../lib/plugin-runtime.js");
  await ensurePluginRuntime();
  const { getPluginSetting } = await import("../lib/plugin-kv.js");
  const { listLanguages, getDefaultLocale } = await import("../lib/i18n/languages-db.js");
  const { asLocaleMap } = await import("../lib/seo-public.js");
  const schema = pluginToDto(plugin).settingsSchema ?? {};
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

  if (plugin.plugin_id === "justflows.seo") {
    const db = await import("../lib/db.js").then((m) => m.getDb());
    const siteRows = await db.query<{ name: string; description: string | null }>(
      "SELECT name, description FROM sites WHERE id = ? LIMIT 1",
      [siteId],
    );
    const site = siteRows[0];
    const titles = (merged.siteTitle ?? {}) as Record<string, string>;
    const descriptions = (merged.defaultDescription ?? {}) as Record<string, string>;
    if (site?.name && !titles[defaultLocale]) titles[defaultLocale] = site.name;
    if (site?.description && !descriptions[defaultLocale]) descriptions[defaultLocale] = site.description;
    merged.siteTitle = titles;
    merged.defaultDescription = descriptions;
  }

  if (plugin.plugin_id === "justflows.analytics") {
    const { parseGoogleTagId } = await import("../lib/google-tag.js");
    const parsed = parseGoogleTagId(String(merged.googleTagId ?? ""));
    merged.googleTagId = parsed ?? "";
  }

  return { schema, values: merged, languages };
}

// The installed extension set and its versions fingerprint the site.
router.get("/", requireRole("administrator", "editor"), async (req, res) => {
  const session = req.session!;

  try {
    const { ensurePluginRuntime } = await import("../lib/plugin-runtime.js");
    await ensurePluginRuntime();
    const plugins = await listPlugins(session.siteId);
    res.json({ plugins });
  } catch (err) {
    sendServerError(res, "plugins", err);
  }
});

router.post("/", requireRole("administrator"), upload.single("file"), async (req, res) => {
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
    const result = await installer.installFromBuffer(file.buffer, {
      packagesDir,
      source: "upload",
      verify: (manifest, digest) => {
        if (manifest.type !== "plugin") {
          throw new Error("Uploaded package is not a plugin (manifest.type must be 'plugin')");
        }
        assertPackageIsTrusted(manifest as unknown as Record<string, unknown>, digest);
      },
    });

    const siteId = req.session?.siteId;
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
    res.json({ plugin });
  } catch (err) {
    sendPackageInstallError(res, err);
  }
});

router.post("/:id/activate", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const pluginId = param(req.params.id);
  const { runtimeActivatePlugin } = await import("../lib/plugin-runtime.js");
  await activatePlugin(session.siteId, pluginId);
  await runtimeActivatePlugin(session.siteId, pluginId).catch(() => null);
  auditFromRequest(req, "plugin.activated", { target: pluginId });
  const { revalidateOnUpdate } = await import("../lib/cache-revalidate.js");
  await revalidateOnUpdate("plugin");
  const row = await getPlugin(session.siteId, pluginId);
  const setupPath = row ? pluginToDto(row).setupPath : undefined;
  res.json({ ok: true, ...(setupPath ? { setupPath } : {}) });
});

router.post("/:id/deactivate", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const pluginId = param(req.params.id);
  const { runtimeDeactivatePlugin } = await import("../lib/plugin-runtime.js");
  await deactivatePlugin(session.siteId, pluginId);
  await runtimeDeactivatePlugin(session.siteId, pluginId).catch(() => null);
  auditFromRequest(req, "plugin.deactivated", { target: pluginId });
  const { revalidateOnUpdate } = await import("../lib/cache-revalidate.js");
  await revalidateOnUpdate("plugin");
  res.json({ ok: true });
});

router.delete("/:id", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const pluginId = param(req.params.id);
  const row = await getPlugin(session.siteId, pluginId);
  const version = row?.version ?? "";
  const { runtimeDeactivatePlugin, runtimeDeletePluginData, getRuntimeHooks } = await import(
    "../lib/plugin-runtime.js"
  );
  const { purgePluginStorage, purgePluginContent, shouldPurgePluginContent, shouldPurgePluginData } = await import("../lib/plugin-purge.js");
  const shouldPurge = await shouldPurgePluginData(session.siteId, pluginId);
  const shouldPurgeContent = await shouldPurgePluginContent(session.siteId, pluginId);

  let hookError: string | undefined;
  try {
    await runtimeDeletePluginData(session.siteId, pluginId);
  } catch (err) {
    const { sanitizeProbeError } = await import("../lib/db-probe.js");
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
      res.status(500).json({ error: purged.error ?? hookError ?? "Plugin data could not be deleted" });
      return;
    }
  }

  await runtimeDeactivatePlugin(session.siteId, pluginId).catch(() => null);
  await deletePlugin(session.siteId, pluginId);
  auditFromRequest(req, "plugin.deleted", { target: pluginId });
  await getRuntimeHooks()
    .dispatchAction(
      "plugin.uninstalled",
      { pluginId, version, siteId: session.siteId },
      { siteId: session.siteId, source: "system" },
    )
    .catch(() => null);
  const { revalidateOnUpdate } = await import("../lib/cache-revalidate.js");
  await revalidateOnUpdate("plugin");
  res.json({ ok: true });
});

// Registered ahead of "/:id" so the literal path is not swallowed by the param.
router.get("/admin-menu", requireSession, async (req, res) => {
  try {
    const { listPluginAdminMenu } = await import("../lib/admin-menu.js");
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
    const { setPluginSetting } = await import("../lib/plugin-kv.js");
    const { ensurePluginRuntime, getRuntimeHooks } = await import("../lib/plugin-runtime.js");
    await ensurePluginRuntime();
    const schema = pluginToDto(plugin).settingsSchema ?? {};
    const siteId = req.session!.siteId;
    let next: Record<string, unknown> = {};
    for (const key of Object.keys(schema)) {
      if (!(key in body)) continue;
      if (pluginId === "justflows.analytics" && key === "googleTagId") {
        const { parseGoogleTagId } = await import("../lib/google-tag.js");
        const raw = String(body[key] ?? "").trim();
        if (!raw) {
          next[key] = "";
          continue;
        }
        const parsed = parseGoogleTagId(raw);
        if (!parsed) {
          res.status(400).json({ error: "Enter a Google tag ID such as G-XXXXXXXX or GTM-XXXXXXX." });
          return;
        }
        next[key] = parsed;
        continue;
      }
      next[key] = body[key];
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
    const { clearGoogleTagIdCache } = await import("../lib/analytics-public.js");
    clearGoogleTagIdCache();
    const { revalidateOnUpdate } = await import("../lib/cache-revalidate.js");
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
  const { createPluginDataApi } = await import("../lib/plugin-data.js");
  const store = createPluginDataApi(pluginId, req.session!.siteId);
  res.json({ items: await store.list(collection) });
});

export default router;
