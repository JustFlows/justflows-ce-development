import fs from "node:fs/promises";
import path from "node:path";
import { getJfCache, cacheStorageDir } from "./jf-cache.js";

export const PAGE_CACHE_PREFIX = "page:html:";
export const SITE_CTX_PREFIX = "site:ctx:";
export const THEME_MODS_PREFIX = "theme:mods:";
export const MENUS_PREFIX = "menus:";
export const CSS_PROVIDER_PREFIX = "css:provider:";

let defaultTtlSeconds = 300;

export async function publicCacheTtl(): Promise<number> {
  if (defaultTtlSeconds !== 300) return defaultTtlSeconds;
  try {
    const { loadConfig } = await import("@justflows/core");
    defaultTtlSeconds = loadConfig().cache.ttlSeconds;
  } catch {
    try {
      const ttl = parseInt(process.env.CACHE_TTL_SECONDS ?? "300", 10);
      if (Number.isFinite(ttl)) defaultTtlSeconds = ttl;
    } catch {
      // keep default
    }
  }
  return defaultTtlSeconds;
}

/**
 * Drop every cached public page HTML. Unconditional — unlike
 * revalidateOnUpdate() this is not gated by the operator's revalidation
 * settings, so an explicit editorial change (comment moderation, a discussion
 * setting) always takes effect on the next request.
 */
export async function invalidatePublicPages(): Promise<void> {
  try {
    await getJfCache().invalidate(PAGE_CACHE_PREFIX);
  } catch {
    // A cache backend hiccup must not fail the write that triggered this.
  }
}

/** Cached full HTML page (skipped for preview / when cache disabled). */
export async function getCachedPageHtml(
  pageKey: string,
  preview: boolean,
  render: () => Promise<string>,
  ttlLimit?: number,
): Promise<string> {
  const cache = getJfCache();
  if (preview || !cache.enabled) {
    return render();
  }
  const { getTenantContext } = await import("../tenancy/context.js");
  const siteId = getTenantContext()?.siteId ?? "site";
  return cache.remember(`${PAGE_CACHE_PREFIX}${siteId}:${pageKey}`, Math.min(await publicCacheTtl(), ttlLimit ?? Infinity), render);
}

/** Generic remember helper for public-site data. */
export async function rememberPublic<T>(
  key: string,
  fn: () => Promise<T>,
  preview = false,
): Promise<T> {
  const cache = getJfCache();
  if (preview || !cache.enabled) return fn();
  return cache.remember(key, await publicCacheTtl(), fn);
}

/** Wipe all public-site cache layers (content, pages, layout data). */
export async function invalidatePublicSiteCache(): Promise<void> {
  const { revalidateOnUpdate } = await import("./cache-revalidate.js");
  await revalidateOnUpdate("manual");
}

const SITE_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function inspectCacheStorage(): Promise<{
  keyCount: number;
  totalBytes: number;
  sampleKeys: string[];
}> {
  const cacheDir = cacheStorageDir();
  let keyCount = 0;
  let totalBytes = 0;
  const sampleKeys: string[] = [];

  async function readJson(dir: string, label: string): Promise<void> {
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      keyCount += 1;
      totalBytes += stat.size;
      if (sampleKeys.length < 20) sampleKeys.push(label ? `${label}/${name}` : name);
    }
  }

  try {
    await readJson(cacheDir, "");
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SITE_DIR.test(entry.name)) {
        await readJson(path.join(cacheDir, entry.name), entry.name);
      }
    }
  } catch {
    return { keyCount: 0, totalBytes: 0, sampleKeys: [] };
  }

  return { keyCount, totalBytes, sampleKeys };
}
