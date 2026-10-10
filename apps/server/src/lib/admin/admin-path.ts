// SPDX-License-Identifier: MIT

import { getSiteId, getSiteSetting, setSiteSetting } from "../settings/site-settings.js";

export const ADMIN_PATH_SETTING_KEY = "security.admin_path";
export const DEFAULT_ADMIN_PATH = "/admin";

export type AdminPathConfig = {
  path: string;
  oldPathBehavior: "not_found" | "redirect";
};

const DEFAULT_CONFIG: AdminPathConfig = { path: DEFAULT_ADMIN_PATH, oldPathBehavior: "not_found" };
const RESERVED_FIRST_SEGMENTS = new Set([
  "api",
  "assets",
  "uploads",
  "install",
  "login",
  "register",
  "admin",
  "account",
  "platform-account",
  "justflows-forms",
  "justflows-comments",
  ".well-known",
  "security.txt",
  "sitemap.xml",
]);

/** Per site. A single slot made the first site's path apply to every hostname. */
const cachedBySite = new Map<string, AdminPathConfig>();

export function clearAdminPathCache(siteId?: string): void {
  if (siteId) cachedBySite.delete(siteId);
  else cachedBySite.clear();
}

export function validateAdminPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("Admin path must be a string.");
  const path = value.trim();
  if (!path.startsWith("/") || path === "/" || path.endsWith("/")) {
    throw new Error("Use a path such as /control-room, without a trailing slash.");
  }
  if (path.length > 80) throw new Error("Admin path must be 80 characters or fewer.");
  if (/%|\\|\?|#|\/\.|\.\.|\/\//i.test(path)) {
    throw new Error("Encoded, ambiguous, or traversal-style paths are not allowed.");
  }
  if (!/^\/[a-z0-9][a-z0-9/_-]*$/i.test(path)) {
    throw new Error("Use letters, numbers, hyphens, underscores, and single slashes only.");
  }
  const first = path.slice(1).split("/")[0]!.toLowerCase();
  if (RESERVED_FIRST_SEGMENTS.has(first)) throw new Error("That path is reserved by Justflows.");
  return path;
}

function normalize(raw: unknown): AdminPathConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const value = raw as Partial<AdminPathConfig>;
  try {
    return {
      path: value.path === DEFAULT_ADMIN_PATH ? DEFAULT_ADMIN_PATH : validateAdminPath(value.path),
      oldPathBehavior: value.oldPathBehavior === "redirect" ? "redirect" : "not_found",
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function getAdminPathConfig(): Promise<AdminPathConfig> {
  const recovery = process.env.JF_ADMIN_PATH_RECOVERY;
  if (recovery) {
    return {
      path: recovery === DEFAULT_ADMIN_PATH ? DEFAULT_ADMIN_PATH : validateAdminPath(recovery),
      oldPathBehavior: "not_found",
    };
  }
  const siteId = await getSiteId();
  if (!siteId) return { ...DEFAULT_CONFIG };
  const hit = cachedBySite.get(siteId);
  if (hit) return hit;
  const config = normalize(await getSiteSetting(siteId, ADMIN_PATH_SETTING_KEY));
  cachedBySite.set(siteId, config);
  return config;
}

export async function saveAdminPathConfig(config: AdminPathConfig): Promise<AdminPathConfig> {
  const siteId = await getSiteId();
  if (!siteId) throw new Error("Site is not installed.");
  const normalized: AdminPathConfig = {
    path: config.path === DEFAULT_ADMIN_PATH ? DEFAULT_ADMIN_PATH : validateAdminPath(config.path),
    oldPathBehavior: config.oldPathBehavior === "redirect" ? "redirect" : "not_found",
  };
  await setSiteSetting(siteId, ADMIN_PATH_SETTING_KEY, normalized);
  cachedBySite.set(siteId, normalized);
  return normalized;
}

export function toInternalAdminPath(pathname: string, base: string): string | null {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  return `/admin${pathname.slice(base.length)}`;
}

export function toPublicAdminPath(pathname: string, base: string): string {
  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return pathname;
  return `${base}${pathname.slice("/admin".length)}`;
}
