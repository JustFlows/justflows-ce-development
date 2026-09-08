// SPDX-License-Identifier: MIT

import { contentPermalink, getPermalinkState } from "../permalinks-db.js";
import { getSiteId } from "../themes-db.js";
import { listPublishedContent } from "../content-public.js";
import { getHomeContent } from "../home-page.js";
import { getDefaultLocale, getActiveLocaleCodes } from "../i18n/languages-db.js";
import { localePath } from "../i18n/locales.js";
import { getRuntimeHooks } from "../plugin-runtime.js";
import { normalizeUrlPath } from "./paths.js";

/** A synthetic path that never resolves, used to capture the themed 404 page. */
export const NOT_FOUND_PROBE = "/__justflows_static_export_404__";

export interface DiscoveredRoutes {
  /** Ordered, de-duplicated URL paths to crawl first (before link discovery). */
  paths: string[];
  /** contentId → the paths that render it, seeded from the database. */
  contentPaths: Map<string, string[]>;
  /** contentId → translationGroupId, for sibling invalidation. */
  translationGroups: Map<string, string>;
}

function extractSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const raw = (match[1] ?? "").replace(/&amp;/g, "&").trim();
    if (raw) out.push(normalizeUrlPath(raw));
  }
  return out;
}

/**
 * Seed the crawl. The site's own `sitemap.xml` already resolves locale prefixes,
 * `seo.sitemapPaths` plugin additions and the SEO plugin's extra paths, so it is
 * the primary source; the database pass fills the dependency map and covers the
 * (unusual) case of a disabled sitemap.
 */
export async function discoverRoutes(
  fetchText: (path: string) => Promise<{ ok: boolean; body: string }>,
): Promise<DiscoveredRoutes> {
  const permalinkSiteId = await getSiteId();
  if (permalinkSiteId && (await getPermalinkState(permalinkSiteId)).settings.structure.startsWith("/?")) {
    throw new Error("Static export requires path-based permalinks. Choose a preset other than Plain in Settings → Permalinks.");
  }
  const paths = new Set<string>(["/"]);
  const contentPaths = new Map<string, string[]>();
  const translationGroups = new Map<string, string>();

  // Always exported, whatever the crawl finds.
  paths.add("/sitemap.xml");
  paths.add("/robots.txt");

  try {
    const sitemap = await fetchText("/sitemap.xml");
    if (sitemap.ok) for (const loc of extractSitemapLocs(sitemap.body)) paths.add(loc);
  } catch {
    // fall back to the database pass below
  }

  const siteId = await getSiteId();
  if (siteId) {
    const defaultLocale = await getDefaultLocale(siteId);
    const [activeLocales, published, home] = await Promise.all([
      getActiveLocaleCodes(siteId),
      listPublishedContent(siteId),
      getHomeContent(siteId, defaultLocale, false).catch(() => null),
    ]);

    for (const locale of activeLocales.length ? activeLocales : [defaultLocale]) {
      paths.add(normalizeUrlPath(localePath(locale, "/", defaultLocale)));
    }

    for (const item of published) {
      const isHome =
        home != null &&
        (item.id === home.id ||
          (item.translationGroupId != null && item.translationGroupId === home.translationGroupId));
      const slugPath = isHome || item.slug === "home" || item.slug === "" ? "/" : `/${item.slug}`;
      const urlPath = normalizeUrlPath(isHome || slugPath === "/" ? localePath(item.locale, "/", defaultLocale) : await contentPermalink(item));
      paths.add(urlPath);
      const list = contentPaths.get(item.id) ?? [];
      if (!list.includes(urlPath)) list.push(urlPath);
      contentPaths.set(item.id, list);
      if (item.translationGroupId) translationGroups.set(item.id, item.translationGroupId);
    }
  }

  paths.add(NOT_FOUND_PROBE);

  let list = [...paths];
  const hooks = getRuntimeHooks();
  if (hooks.has("staticExport.routes")) {
    try {
      const filtered = await hooks.applyFilter("staticExport.routes", list, {
        siteId: siteId ?? "",
      });
      if (Array.isArray(filtered)) {
        list = filtered
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .map((p) => normalizeUrlPath(p));
      }
    } catch {
      // a broken filter must not abort the export
    }
  }

  return { paths: [...new Set(list)], contentPaths, translationGroups };
}
