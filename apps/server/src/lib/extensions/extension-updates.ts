// SPDX-License-Identifier: MIT

// Plugin and theme updates from the Marketplace.
//
// An installed extension has an update when the Marketplace catalogue (filtered
// to builds this core can run) lists a newer SemVer version under the same id.
// Administrators update by hand from Plugins / Themes / Marketplace, or opt an
// individual extension into automatic updates. Like core auto-update, the
// unattended job never crosses a major version and honours the operator kill
// switch `JUSTFLOWS_DISABLE_AUTO_UPDATE=1`.

import {
  FETCH_TIMEOUT_MS,
  installMarketplacePackage,
  JUSTFLOWS_API_BASE,
  MarketplaceRequestError,
  type MarketplacePackageType,
} from "./marketplace-package.js";
import {
  MARKETPLACE_ALLOW_BETA_SETTING,
  marketplaceListingIsBeta,
  marketplaceListingIsComingSoon,
  marketplaceListingIsPaid,
  marketplaceListingIsVisible,
} from "./marketplace-catalog.js";
import { compareCoreVersions, parseCoreVersion } from "../updates/core-release-check.js";
import { PackageRejectedError } from "@justflows/installer";
import { PluginPermissionApprovalError } from "../plugins/plugin-permission-approval.js";
import { isAutoUpdateKillSwitchOn } from "../updates/core-auto-update.js";
import { getJustflowsVersion } from "../runtime/version.js";
import { auditLog } from "../security/audit-log.js";
import { getSiteId, getSiteSetting, setSiteSetting } from "../settings/site-settings.js";
import { registerCoreJob, unregisterCoreJob } from "../jobs/core-jobs.js";

export const EXTENSION_AUTO_UPDATE_SETTING = "extensions.auto_update";

const CHECK_CACHE_MS = 60 * 60 * 1000;
const AUTO_UPDATE_BOOT_DELAY_MS = 3 * 60 * 1000;

export interface ExtensionAutoUpdateSettings {
  plugin: string[];
  theme: string[];
}

export interface ExtensionUpdate {
  type: MarketplacePackageType;
  id: string;
  name: string;
  installedVersion: string;
  availableVersion: string;
  /** False when the update crosses a major version; those wait for a human. */
  autoUpdatable: boolean;
  autoUpdate: boolean;
  beta: boolean;
}

export interface ExtensionUpdatesReport {
  checkedAt: string;
  updates: ExtensionUpdate[];
  autoUpdate: ExtensionAutoUpdateSettings;
  autoUpdateDisabledByOperator: boolean;
}

interface InstalledExtension {
  type: MarketplacePackageType;
  id: string;
  name: string;
  version: string;
}

interface CatalogItem {
  id?: unknown;
  type?: unknown;
  version?: unknown;
  name?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Auto-update preferences                                                    */
/* -------------------------------------------------------------------------- */

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export async function getExtensionAutoUpdate(siteId: string): Promise<ExtensionAutoUpdateSettings> {
  const stored = await getSiteSetting<Partial<ExtensionAutoUpdateSettings>>(
    siteId,
    EXTENSION_AUTO_UPDATE_SETTING,
  );
  return { plugin: cleanIds(stored?.plugin), theme: cleanIds(stored?.theme) };
}

export async function setExtensionAutoUpdate(
  siteId: string,
  type: MarketplacePackageType,
  id: string,
  enabled: boolean,
): Promise<ExtensionAutoUpdateSettings> {
  const current = await getExtensionAutoUpdate(siteId);
  const ids = new Set(current[type]);
  if (enabled) ids.add(id);
  else ids.delete(id);
  const next = { ...current, [type]: [...ids].sort() };
  await setSiteSetting(siteId, EXTENSION_AUTO_UPDATE_SETTING, next);
  return next;
}

/* -------------------------------------------------------------------------- */
/* Update discovery                                                           */
/* -------------------------------------------------------------------------- */

async function listInstalledExtensions(siteId: string): Promise<InstalledExtension[]> {
  const { listPlugins } = await import("../plugins/plugins-db.js");
  const { listThemes } = await import("../themes/themes-db.js");
  const [plugins, themes] = await Promise.all([listPlugins(siteId), listThemes(siteId)]);
  return [
    ...plugins.map((p) => ({
      type: "plugin" as const,
      id: p.id,
      name: p.name,
      version: p.version,
    })),
    ...themes.map((t) => ({
      type: "theme" as const,
      id: t.theme_id,
      name: t.name,
      version: t.version,
    })),
  ];
}

async function fetchCompatibleCatalog(): Promise<
  Map<string, CatalogItem & Record<string, unknown>>
> {
  const params = new URLSearchParams({ compatibleWith: getJustflowsVersion() });
  const res = await fetch(`${JUSTFLOWS_API_BASE}/v1/marketplace?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Marketplace API returned ${res.status}`);
  const body = (await res.json()) as { items?: unknown };
  const items = Array.isArray(body.items)
    ? (body.items as (CatalogItem & Record<string, unknown>)[])
    : [];
  const byKey = new Map<string, CatalogItem & Record<string, unknown>>();
  for (const item of items) {
    if (typeof item.id !== "string" || (item.type !== "plugin" && item.type !== "theme")) continue;
    byKey.set(`${item.type}:${item.id}`, item);
  }
  return byKey;
}

/** Newer, installable, SemVer-comparable listings only. Pure for testing. */
export function findExtensionUpdates(
  installed: InstalledExtension[],
  catalog: Map<string, CatalogItem & Record<string, unknown>>,
  autoUpdate: ExtensionAutoUpdateSettings,
  allowBeta = false,
): ExtensionUpdate[] {
  const updates: ExtensionUpdate[] = [];
  for (const ext of installed) {
    const listing = catalog.get(`${ext.type}:${ext.id}`);
    if (!listing || typeof listing.version !== "string") continue;
    if (!marketplaceListingIsVisible(listing)) continue;
    if (marketplaceListingIsComingSoon(listing) || marketplaceListingIsPaid(listing)) continue;
    // Same gate as install: no beta builds unless the site opted in.
    const beta = marketplaceListingIsBeta(listing);
    if (beta && !allowBeta) continue;
    const current = parseCoreVersion(ext.version);
    const available = parseCoreVersion(listing.version);
    if (!current || !available || compareCoreVersions(available, current) <= 0) continue;
    updates.push({
      type: ext.type,
      id: ext.id,
      name: ext.name,
      installedVersion: ext.version,
      availableVersion: listing.version,
      autoUpdatable: available.major === current.major,
      autoUpdate: autoUpdate[ext.type].includes(ext.id),
      beta,
    });
  }
  return updates;
}

let cached: { siteId: string; at: number; updates: ExtensionUpdate[] } | null = null;

export function clearExtensionUpdatesCache(): void {
  cached = null;
}

export async function checkExtensionUpdates(
  siteId: string,
  options: { force?: boolean } = {},
): Promise<ExtensionUpdatesReport> {
  const autoUpdate = await getExtensionAutoUpdate(siteId);
  if (
    !options.force &&
    cached &&
    cached.siteId === siteId &&
    Date.now() - cached.at < CHECK_CACHE_MS
  ) {
    return {
      checkedAt: new Date(cached.at).toISOString(),
      // Preferences may have changed since the catalogue was read.
      updates: cached.updates.map((u) => ({ ...u, autoUpdate: autoUpdate[u.type].includes(u.id) })),
      autoUpdate,
      autoUpdateDisabledByOperator: isAutoUpdateKillSwitchOn(),
    };
  }

  const [installed, catalog, allowBeta] = await Promise.all([
    listInstalledExtensions(siteId),
    fetchCompatibleCatalog(),
    getSiteSetting<boolean>(siteId, MARKETPLACE_ALLOW_BETA_SETTING),
  ]);
  const updates = findExtensionUpdates(installed, catalog, autoUpdate, allowBeta === true);
  const at = Date.now();
  cached = { siteId, at, updates };
  return {
    checkedAt: new Date(at).toISOString(),
    updates,
    autoUpdate,
    autoUpdateDisabledByOperator: isAutoUpdateKillSwitchOn(),
  };
}

/* -------------------------------------------------------------------------- */
/* Applying an update                                                         */
/* -------------------------------------------------------------------------- */

export interface ExtensionUpdateActor {
  userId?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ExtensionUpdateResult {
  type: MarketplacePackageType;
  id: string;
  previousVersion: string;
  version: string;
  /** Set when an active plugin was updated but its new build failed to activate. */
  activationError?: string;
}

/**
 * Install `version` (or the latest listing) over an installed extension.
 *
 * The new package is downloaded and verified before the running plugin is
 * touched, so a failed download leaves the site exactly as it was. An active
 * plugin is deactivated, swapped, and re-activated on the new build; if that
 * activation throws, the plugin is marked `error` like any failed activation.
 */
export async function updateExtension(
  siteId: string,
  type: MarketplacePackageType,
  id: string,
  options: {
    version?: string;
    actor?: ExtensionUpdateActor;
    source?: "manual" | "auto";
    approvedPermissions?: readonly string[];
  } = {},
): Promise<ExtensionUpdateResult> {
  const actor = options.actor ?? {};
  if (type === "plugin") {
    const { isInstallationRootSite } = await import("../tenancy/registry.js");
    if (!(await isInstallationRootSite(siteId))) {
      throw new MarketplaceRequestError(403, { error: "Plugins are updated on the main site." });
    }
    const { getPlugin, insertPlugin, markPluginError } = await import("../plugins/plugins-db.js");
    const existing = await getPlugin(siteId, id);
    if (!existing) throw new MarketplaceRequestError(404, { error: "Plugin not found" });

    const result = await installMarketplacePackage({
      type,
      id,
      version: options.version,
      siteId,
      expectedNewerThan: existing.version,
      approvedPermissions: options.approvedPermissions,
    });

    const { runtimeActivatePlugin, runtimeDeactivatePlugin, runtimeUnloadPlugin } =
      await import("../plugins/plugin-runtime.js");
    const wasActive = existing.status === "active";
    if (wasActive) await runtimeDeactivatePlugin(siteId, id).catch(() => null);
    await insertPlugin(siteId, {
      pluginId: result.manifest.id,
      version: result.manifest.version,
      manifest: { ...result.manifest, installedPath: result.installedPath },
    });
    // Forget the old module so the next activate imports the new build.
    await runtimeUnloadPlugin(id).catch(() => null);

    let activationError: string | undefined;
    if (wasActive) {
      try {
        await runtimeActivatePlugin(siteId, id);
      } catch (err) {
        activationError = err instanceof Error ? err.message : String(err);
        await markPluginError(siteId, id).catch(() => null);
      }
    }

    /**
     * Only a successful update removes the old builds, so a failed activation
     * still leaves the previous version on disk to go back to.
     */
    if (!activationError) {
      const { purgeOtherPluginVersions } = await import("../plugins/plugin-purge.js");
      const pruned = purgeOtherPluginVersions(result.installedPath);
      if (pruned.removed.length > 0) {
        const { invalidateIntegrityCache } = await import("../security/extension-integrity.js");
        invalidateIntegrityCache();
      }
    }

    if (result.approvedPermissions.length > 0) {
      const { approvedPermissionsDetail } =
        await import("../plugins/plugin-permission-approval.js");
      void auditLog({
        siteId,
        action: "plugin.permissions_approved",
        actorId: actor.userId ?? null,
        actorRole: actor.role ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        target: id,
        detail: approvedPermissionsDetail(result.approvedPermissions),
      });
    }
    void auditLog({
      siteId,
      action: "plugin.updated",
      outcome: activationError ? "failure" : "success",
      actorId: actor.userId ?? null,
      actorRole: actor.role ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      target: id,
      detail: `${existing.version} -> ${result.manifest.version} (${options.source ?? "manual"}) digest=${result.digest.slice(0, 16)}`,
    });
    const { revalidateOnUpdate } = await import("../cache/cache-revalidate.js");
    await revalidateOnUpdate("plugin");
    clearExtensionUpdatesCache();
    return {
      type,
      id,
      previousVersion: existing.version,
      version: result.manifest.version,
      ...(activationError ? { activationError } : {}),
    };
  }

  const { getTheme, updateThemePackage } = await import("../themes/themes-db.js");
  const existing = await getTheme(siteId, id);
  if (!existing) throw new MarketplaceRequestError(404, { error: "Theme not found" });

  const result = await installMarketplacePackage({
    type,
    id,
    version: options.version,
    siteId,
    expectedNewerThan: existing.version,
  });
  const { mergeInstalledThemeRecord } = await import("../themes/theme-files.js");
  const installed = mergeInstalledThemeRecord({
    themeId: result.manifest.id,
    manifest: {
      ...(result.manifest as unknown as Record<string, unknown>),
      installedPath: result.installedPath,
    },
    cssVariables: {},
  });
  await updateThemePackage(siteId, id, {
    name: result.manifest.name,
    version: result.manifest.version,
    publisher: result.manifest.publisher,
    description: result.manifest.description,
    cssVariables: installed.cssVariables,
    manifest: installed.manifest,
  });

  void auditLog({
    siteId,
    action: "theme.updated",
    actorId: actor.userId ?? null,
    actorRole: actor.role ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    target: id,
    detail: `${existing.version} -> ${result.manifest.version} (${options.source ?? "manual"}) digest=${result.digest.slice(0, 16)}`,
  });
  const { revalidateOnUpdate } = await import("../cache/cache-revalidate.js");
  await revalidateOnUpdate("theme", { siteId });
  clearExtensionUpdatesCache();
  return { type, id, previousVersion: existing.version, version: result.manifest.version };
}

/* -------------------------------------------------------------------------- */
/* Unattended updates                                                         */
/* -------------------------------------------------------------------------- */

const AUTO_UPDATE_JOB = "extensions.auto-update";

let running = false;

/** One pass over opted-in extensions. Exported for tests. */
export async function runExtensionAutoUpdate(): Promise<{
  success: false;
  message: string;
} | void> {
  if (running) return;
  running = true;
  try {
    if (isAutoUpdateKillSwitchOn()) return;
    const siteId = await getSiteId();
    if (!siteId) return;
    const prefs = await getExtensionAutoUpdate(siteId);
    if (prefs.plugin.length === 0 && prefs.theme.length === 0) return;

    const report = await checkExtensionUpdates(siteId, { force: true });
    for (const update of report.updates) {
      if (!update.autoUpdate) continue;
      if (!update.autoUpdatable) {
        void auditLog({
          siteId,
          action: "extension.auto_update_skipped",
          target: `${update.type}:${update.id}`,
          detail: `${update.installedVersion} -> ${update.availableVersion} (major change needs manual approval)`,
        });
        continue;
      }
      try {
        // Sequential on purpose: plugins swap modules in a shared runtime.
        await updateExtension(siteId, update.type, update.id, {
          version: update.availableVersion,
          source: "auto",
        });
      } catch (err) {
        /** Nobody is present to approve, so this waits for a manual update. */
        if (
          err instanceof PackageRejectedError &&
          err.cause instanceof PluginPermissionApprovalError
        ) {
          void auditLog({
            siteId,
            action: "extension.auto_update_skipped",
            target: `${update.type}:${update.id}`,
            detail: `${update.installedVersion} -> ${update.availableVersion} (new permissions need manual approval)`,
          });
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        void auditLog({
          siteId,
          action: "extension.auto_update_failed",
          outcome: "failure",
          target: `${update.type}:${update.id}`,
          detail: `${update.installedVersion} -> ${update.availableVersion}: ${message}`,
        });
      }
    }
  } catch (err) {
    console.error(
      "[justflows] Extension auto-update check failed:",
      String(err).replace(/\n/g, " "),
    );
    return { success: false, message: "Extension auto-update check failed" };
  } finally {
    running = false;
  }
}

/** Runs shortly after boot, then twice a day. No-op until an admin opts an extension in. */
export function startExtensionAutoUpdateJob(): void {
  registerCoreJob(
    {
      name: AUTO_UPDATE_JOB,
      schedule: "37 */12 * * *",
      handler: async () => (await runExtensionAutoUpdate()) ?? { success: true },
    },
    { runAfterMs: AUTO_UPDATE_BOOT_DELAY_MS },
  );
}

export function stopExtensionAutoUpdateJob(): void {
  unregisterCoreJob(AUTO_UPDATE_JOB);
}
