import type { CacheObjectType, CacheRevalidateTrigger } from "@justflows/sdk";
import { parseEnvBool } from "@justflows/core";
import { getJfCache } from "./jf-cache.js";
import { scopeCacheKeyTo } from "./site-cache-key.js";
import { getTenantContext } from "../tenancy/context.js";
import {
  CSS_PROVIDER_PREFIX,
  MENUS_PREFIX,
  PAGE_CACHE_PREFIX,
  SITE_CTX_PREFIX,
  THEME_MODS_PREFIX,
} from "./public-cache.js";
import { getRuntimeHooks } from "../plugins/plugin-runtime.js";
import { purgeCdnCache } from "../cdn/cdn-purge.js";

export const CACHE_OBJECT_TYPES: readonly CacheObjectType[] = [
  "pages",
  "content",
  "menus",
  "theme",
  "cssProviders",
  "site",
];

export interface CacheObjectSelection {
  pages: boolean;
  content: boolean;
  menus: boolean;
  theme: boolean;
  cssProviders: boolean;
  site: boolean;
}

export interface RevalidateSettings {
  enabled: boolean;
  objects: CacheObjectSelection;
}

const PREFIX_BY_OBJECT: Record<CacheObjectType, string> = {
  pages: PAGE_CACHE_PREFIX,
  content: "content:",
  menus: MENUS_PREFIX,
  theme: THEME_MODS_PREFIX,
  cssProviders: CSS_PROVIDER_PREFIX,
  site: SITE_CTX_PREFIX,
};

/** Which layers a given update typically affects (intersected with user selection). */
const TRIGGER_OBJECTS: Record<CacheRevalidateTrigger, readonly CacheObjectType[]> = {
  content: ["content", "pages"],
  menus: ["menus", "pages"],
  theme: ["theme", "pages", "site"],
  settings: ["site", "pages", "theme"],
  cssProviders: ["cssProviders", "pages"],
  manual: ["pages", "content", "menus", "theme", "cssProviders", "site"],
  plugin: ["pages", "content", "menus", "theme", "cssProviders", "site"],
};

export function defaultRevalidateObjects(): CacheObjectSelection {
  return {
    pages: true,
    content: true,
    menus: true,
    theme: true,
    cssProviders: true,
    site: true,
  };
}

function parseObjectList(raw: string | undefined): CacheObjectSelection {
  const defaults = defaultRevalidateObjects();
  if (raw === undefined || raw.trim() === "") return defaults;

  const selected = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const out = { ...defaults };
  for (const key of CACHE_OBJECT_TYPES) {
    out[key] = selected.has(key);
  }
  return out;
}

export function getRevalidateSettings(): RevalidateSettings {
  return {
    enabled: parseEnvBool(process.env.CACHE_REVALIDATE_ENABLED, false),
    objects: parseObjectList(process.env.CACHE_REVALIDATE_OBJECTS),
  };
}

export function revalidateObjectsToEnv(objects: CacheObjectSelection): string {
  return CACHE_OBJECT_TYPES.filter((k) => objects[k]).join(",");
}

/**
 * Selective revalidation after a write.
 * No-op when revalidation is disabled (entries expire via TTL only).
 */
export async function revalidateOnUpdate(
  trigger: CacheRevalidateTrigger,
  opts?: { siteId?: string; forceObjects?: CacheObjectType[] },
): Promise<{ revalidated: CacheObjectType[]; skipped: boolean }> {
  /**
   * The on-demand static export marks every file stale on a site-wide change,
   * whether or not cache revalidation is on. Entry changes arrive through the
   * content hooks instead, with the ids they need.
   */
  if (trigger !== "content" && process.env.STATIC_EXPORT_MODE?.trim().toLowerCase() === "on-demand") {
    try {
      const { noteOnDemandSiteChange } = await import("../static-export/serve-on-demand.js");
      await noteOnDemandSiteChange(opts?.siteId);
    } catch (err) {
      console.error("[justflows] static-export on-demand: could not mark pages stale", err);
    }
  }
  const settings = getRevalidateSettings();
  if (!settings.enabled) {
    return { revalidated: [], skipped: true };
  }

  const candidates = opts?.forceObjects ?? TRIGGER_OBJECTS[trigger];
  const objects = candidates.filter((obj) => settings.objects[obj]);

  if (objects.length === 0) {
    return { revalidated: [], skipped: true };
  }

  const cache = getJfCache();
  const siteId = opts?.siteId ?? getTenantContext()?.siteId;
  for (const obj of objects) {
    await cache.invalidate(scopeCacheKeyTo(siteId, PREFIX_BY_OBJECT[obj]));
  }

  try {
    await getRuntimeHooks().dispatchAction(
      "cache.revalidated",
      { trigger, objects, siteId: opts?.siteId },
      { siteId: opts?.siteId, source: "system" },
    );
  } catch {
    // hooks must not break cache invalidation
  }

  try {
    await purgeCdnCache({
      siteId: typeof siteId === "string" ? siteId : undefined,
      hostname: getTenantContext()?.hostname,
    });
  } catch {
    // A CDN failure must not fail the save that cleared the local cache.
  }

  return { revalidated: objects, skipped: false };
}

/** Wipe every selected layer (Tools → Clear, or force full flush). */
export async function revalidateSelected(objects?: CacheObjectType[]): Promise<CacheObjectType[]> {
  const settings = getRevalidateSettings();
  const list =
    objects && objects.length > 0
      ? objects
      : CACHE_OBJECT_TYPES.filter((k) => settings.objects[k]);

  const cache = getJfCache();
  for (const obj of list) {
    await cache.invalidate(PREFIX_BY_OBJECT[obj]);
  }

  try {
    await getRuntimeHooks().dispatchAction(
      "cache.revalidated",
      { trigger: "manual", objects: list },
      { source: "system" },
    );
  } catch {
    // ignore
  }

  return list;
}
