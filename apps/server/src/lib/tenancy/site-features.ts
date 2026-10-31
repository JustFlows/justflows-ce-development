// SPDX-License-Identifier: MIT

import { PLUGIN_ID_RE, pluginAdminBasePath } from "@justflows/sdk";
import type { RequestHandler } from "express";
import { getTenantContext } from "./context.js";
import { enforceQuota, quotaLimitMap } from "./quotas.js";

/** A site feature. Off (stored 0) hides the admin paths and blocks the feature. Absent stays on. */
export interface SiteFeature {
  key: string;
  paths: readonly string[];
}

export const SITE_FEATURES: readonly SiteFeature[] = [
  { key: "feature.comments", paths: ["/admin/comments"] },
  { key: "feature.themeUpload", paths: [] },
  { key: "feature.design", paths: ["/admin/design"] },
  { key: "feature.roles", paths: [] },
  { key: "feature.responsiveImages", paths: [] },
  { key: "feature.securityAdvanced", paths: ["/admin/security/advanced"] },
  { key: "feature.securityHeaders", paths: ["/admin/security/headers", "/admin/security/header-grade"] },
  { key: "feature.securityAdminPath", paths: ["/admin/security/admin-path"] },
  { key: "feature.securityAudit", paths: ["/admin/security/audit"] },
  { key: "feature.pwa", paths: ["/admin/settings/pwa"] },
  { key: "feature.redirects", paths: ["/admin/redirects"] },
  { key: "feature.permalinks", paths: ["/admin/settings/permalinks"] },
  { key: "feature.placeholders", paths: ["/admin/settings/placeholders"] },
  { key: "feature.emails", paths: ["/admin/emails"] },
  { key: "feature.languages", paths: ["/admin/languages"] },
  { key: "feature.webhooks", paths: ["/admin/webhooks"] },
  { key: "feature.api", paths: ["/admin/settings/api"] },
  { key: "feature.ai", paths: ["/admin/settings/ai"] },
  { key: "feature.mcp", paths: [] },
  { key: "feature.cdn", paths: ["/admin/settings/cdn"] },
  { key: "feature.trash", paths: ["/admin/trash"] },
  { key: "feature.tools", paths: ["/admin/tools"] },
  { key: "feature.plugins", paths: ["/admin/plugins"] },
  { key: "feature.customDomains", paths: ["/admin/settings/domains"] },
  { key: "feature.managedDns", paths: [] },
];

/** Plan switch for a website's own private-file storage; off hides Settings → Storage there. */
export const OWN_STORAGE_FEATURE = "feature.ownStorage";
export const STORAGE_ADMIN_PATH = "/admin/settings/storage";

async function isRootSite(siteId: string): Promise<boolean> {
  const { installationRootSiteId } = await import("./registry.js");
  const rootId = await installationRootSiteId().catch(() => null);
  return !rootId || rootId === siteId;
}

/** Admin paths hidden because this website turned the feature off. */
export async function disabledAdminPaths(siteId: string): Promise<string[]> {
  const limits = await quotaLimitMap("site", siteId);
  const paths = disabledPathsFromLimits(limits);
  // Storage is the platform's own connection on the root site, so only other sites lose the page.
  if (limits.get(OWN_STORAGE_FEATURE) === 0 && !(await isRootSite(siteId))) paths.push(STORAGE_ADMIN_PATH);
  const { cachedDomainSettings } = await import("../domains/domain-settings.js");
  if (!(await cachedDomainSettings()).enabled) paths.push("/admin/settings/domains");
  return paths;
}

/** Feature keys stored as off, so in-page controls can be removed. */
export async function disabledFeatureKeys(siteId: string): Promise<string[]> {
  const limits = await quotaLimitMap("site", siteId);
  return SITE_FEATURES.filter((feature) => limits.get(feature.key) === 0).map((feature) => feature.key);
}

/** Suffix of a plugin's own site switch, such as `justflows.example.enabled`. */
const PLUGIN_FEATURE_SUFFIX = ".enabled";

function disabledPathsFromLimits(limits: Map<string, number>): string[] {
  const paths: string[] = [];
  for (const feature of SITE_FEATURES) {
    if (limits.get(feature.key) === 0) paths.push(...feature.paths);
  }
  /** A plugin's `<plugin id>.enabled` switch stored as off hides that plugin's admin pages. */
  for (const [key, value] of limits) {
    if (value !== 0 || !key.endsWith(PLUGIN_FEATURE_SUFFIX)) continue;
    const pluginId = key.slice(0, -PLUGIN_FEATURE_SUFFIX.length);
    if (PLUGIN_ID_RE.test(pluginId)) paths.push(pluginAdminBasePath(pluginId));
  }
  return paths;
}

/** True when the feature is allowed. No site, or no stored 0, means allowed. */
export async function siteFeatureEnabled(key: string, siteId?: string | null): Promise<boolean> {
  const id = siteId || getTenantContext()?.siteId;
  if (!id) return true;
  const block = await enforceQuota(key, id, 0);
  return block === null;
}

/** Block a route when the current website has this feature turned off. */
export function requireSiteFeature(key: string): RequestHandler {
  return (req, res, next) => {
    const siteId = req.session?.siteId || getTenantContext()?.siteId;
    if (!siteId) {
      next();
      return;
    }
    void enforceQuota(key, siteId, 0)
      .then((block) => {
        if (!block) {
          next();
          return;
        }
        res.status(block.status).json({ error: block.error, code: block.code, meter: block.meter });
      })
      .catch(next);
  };
}
