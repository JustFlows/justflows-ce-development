// SPDX-License-Identifier: MIT

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { isInstallationRootRequest } from "../../lib/tenancy/access.js";
import { auditFromRequest } from "../../lib/security/audit-log.js";
import { sendPackageInstallError } from "../../lib/extensions/package-install-error.js";
import { filterMarketplaceCatalogBody } from "../../lib/extensions/marketplace-catalog.js";
import {
  FETCH_TIMEOUT_MS,
  installMarketplacePackage,
  JUSTFLOWS_API_BASE,
  MarketplaceRequestError,
} from "../../lib/extensions/marketplace-package.js";
import {
  checkExtensionUpdates,
  setExtensionAutoUpdate,
  updateExtension,
} from "../../lib/extensions/extension-updates.js";
import {
  approvedPermissionsDetail,
  MAX_APPROVED_PERMISSIONS,
} from "../../lib/plugins/plugin-permission-approval.js";

const router = Router();

// Updates download, extract, and swap packages on disk.
const updateRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many update requests" },
});

router.get("/", requireRole("administrator"), async (req, res) => {
  try {
    const params = new URLSearchParams();
    for (const key of ["q", "category", "channel", "compatibleWith", "type"] as const) {
      const value = req.query[key];
      if (typeof value === "string" && value) params.set(key, value);
    }
    const qs = params.toString();
    const url = `${JUSTFLOWS_API_BASE}/v1/marketplace${qs ? `?${qs}` : ""}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const body = await upstream.text();
    // Always JSON. Echoing the upstream Content-Type would let a compromised or
    // misconfigured registry serve text/html from this site's origin.
    res
      .status(upstream.status)
      .type("application/json")
      .send(upstream.ok ? filterMarketplaceCatalogBody(body) : body);
  } catch (err) {
    res.status(503).json({ error: `Marketplace API unavailable: ${String(err)}` });
  }
});

const ApprovedPermissions = z.array(z.string().min(1)).max(MAX_APPROVED_PERMISSIONS).optional();

const InstallSchema = z.object({
  type: z.enum(["plugin", "theme"]),
  id: z.string().min(1),
  version: z.string().optional(),
  approvedPermissions: ApprovedPermissions,
});

router.post("/install", requireRole("administrator"), async (req, res) => {
  try {
    const { type, id, version, approvedPermissions } = InstallSchema.parse(req.body);
    const { siteFeatureEnabled } = await import("../../lib/tenancy/site-features.js");
    /** feature.themeUpload only covers uploading a .jfpkg; marketplace themes stay installable. */
    if (type === "plugin" && !(await siteFeatureEnabled("feature.plugins", req.session?.siteId))) {
      res.status(403).json({ error: "Plugins are turned off for this website.", code: "feature_disabled", meter: "feature.plugins" });
      return;
    }
    if (type === "plugin" && !isInstallationRootRequest()) {
      res.status(403).json({ error: "Plugins are installed on the main site." });
      return;
    }
    const result = await installMarketplacePackage({
      type,
      id,
      version,
      siteId: req.session?.siteId,
      approvedPermissions,
    });

    if (type === "plugin") {
      const { insertPlugin } = await import("../../lib/plugins/plugins-db.js");
      const siteId = req.session?.siteId;
      if (!siteId) {
        res.status(503).json({ error: "No site found — complete install first" });
        return;
      }
      const plugin = await insertPlugin(siteId, {
        pluginId: result.manifest.id,
        version: result.manifest.version,
        manifest: { ...result.manifest, installedPath: result.installedPath },
        status: "installed",
      });
      /** The row now points at this build, so versions left by earlier installs are unused. */
      const { purgeOtherPluginVersions } = await import("../../lib/plugins/plugin-purge.js");
      if (purgeOtherPluginVersions(result.installedPath).removed.length > 0) {
        const { invalidateIntegrityCache } = await import("../../lib/security/extension-integrity.js");
        invalidateIntegrityCache();
      }
      if (result.approvedPermissions.length > 0) {
        auditFromRequest(req, "plugin.permissions_approved", {
          target: result.manifest.id,
          detail: approvedPermissionsDetail(result.approvedPermissions),
        });
      }
      // Forget any previously imported module so the next activate runs this
      // build without a process restart.
      const { runtimeUnloadPlugin } = await import("../../lib/plugins/plugin-runtime.js");
      await runtimeUnloadPlugin(result.manifest.id).catch(() => null);
      res.json({ plugin });
      return;
    }

    const { ensureThemesTable, getSiteId, insertTheme } = await import("../../lib/themes/themes-db.js");
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found — complete install first" });
      return;
    }
    const { mergeInstalledThemeRecord } = await import("../../lib/themes/theme-files.js");
    const installed = mergeInstalledThemeRecord({
      themeId: result.manifest.id,
      manifest: {
        ...(result.manifest as unknown as Record<string, unknown>),
        installedPath: result.installedPath,
      },
      cssVariables: {},
    });
    const theme = {
      id: crypto.randomUUID(),
      themeId: result.manifest.id,
      name: result.manifest.name,
      version: result.manifest.version,
      publisher: result.manifest.publisher,
      description: result.manifest.description,
      cssVariables: installed.cssVariables,
      manifest: installed.manifest,
    };
    await insertTheme(siteId, theme);
    res.json({ theme: { ...theme, status: "installed", active: false } });
  } catch (err) {
    if (err instanceof MarketplaceRequestError) {
      res.status(err.status).json(err.body);
      return;
    }
    sendPackageInstallError(res, err);
  }
});

// Installed plugins/themes that have a newer compatible Marketplace build.
// Cached for an hour; `?force=1` re-reads the catalogue.
router.get("/updates", updateRateLimit, requireRole("administrator"), async (req, res) => {
  const siteId = req.session?.siteId;
  if (!siteId) {
    res.status(503).json({ error: "No site found — complete install first" });
    return;
  }
  try {
    const report = await checkExtensionUpdates(siteId, { force: req.query.force === "1" });
    res.setHeader("Cache-Control", "private, no-store");
    res.json(report);
  } catch (err) {
    console.error("[justflows] extension update check failed:", String(err).replace(/\n/g, " "));
    res.status(503).json({ error: "Could not check the Marketplace for updates" });
  }
});

const UpdateSchema = z.object({
  type: z.enum(["plugin", "theme"]),
  id: z.string().min(1),
  version: z.string().optional(),
  approvedPermissions: ApprovedPermissions,
});

router.post("/update", updateRateLimit, requireRole("administrator"), async (req, res) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "type and id are required" });
    return;
  }
  const siteId = req.session?.siteId;
  if (!siteId) {
    res.status(503).json({ error: "No site found — complete install first" });
    return;
  }
  const { type, id, version, approvedPermissions } = parsed.data;
  try {
    const result = await updateExtension(siteId, type, id, {
      version,
      source: "manual",
      approvedPermissions,
      actor: {
        userId: req.session?.userId ?? null,
        role: req.session?.role ?? null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof MarketplaceRequestError) {
      res.status(err.status).json(err.body);
      return;
    }
    sendPackageInstallError(res, err);
  }
});

const AutoUpdateSchema = z.object({
  type: z.enum(["plugin", "theme"]),
  id: z.string().min(1),
  enabled: z.boolean(),
});

router.put("/auto-update", requireRole("administrator"), async (req, res) => {
  const parsed = AutoUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "type, id, and enabled are required" });
    return;
  }
  const siteId = req.session?.siteId;
  if (!siteId) {
    res.status(503).json({ error: "No site found — complete install first" });
    return;
  }
  const { type, id, enabled } = parsed.data;
  const autoUpdate = await setExtensionAutoUpdate(siteId, type, id, enabled);
  auditFromRequest(req, "extension.auto_update_toggled", {
    target: `${type}:${id}`,
    detail: enabled ? "enabled" : "disabled",
  });
  res.json({ ok: true, autoUpdate });
});

export default router;
