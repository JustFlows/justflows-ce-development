// SPDX-License-Identifier: MIT

import { getContentTypeSettingsMap } from "../content/content-types-db.js";
import { isExcludedPath } from "../static-export/exclusions.js";
import { accountPageExclusions } from "../account/pages.js";
import { slashPath } from "../navigation/permalinks.js";
import { createContentPermalinkResolver, getPermalinkState, listPermalinkTerms, taxonomyPermalink } from "../navigation/permalinks-db.js";
import { getHomeContent } from "../content/home-page.js";
import { listPublishedContent } from "../content/content-public.js";
import { getAnonymousVisibilityScope } from "../content/visibility-scope.js";
import { getDefaultLocale } from "../i18n/languages-db.js";
import { localePath } from "../i18n/locales.js";
import { siteOrigin } from "./site-origin.js";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * `/sitemap.xml` without any SEO plugin: the home page, every published entry
 * whose type is included in search engines, and term archives. Plugins add
 * paths through `seo.sitemapPaths`; private account pages are always left out.
 */
export async function buildSitemapXml(siteId: string): Promise<string> {
  const origin = siteOrigin();
  const defaultLocale = await getDefaultLocale(siteId);
  const typeSettings = await getContentTypeSettingsMap(siteId);
  const published = (await listPublishedContent(siteId)).filter(item => typeSettings.get(item.type)?.seo !== false);
  const home = await getHomeContent(siteId, defaultLocale, false);
  const state = await getPermalinkState(siteId);
  const permalinks = state.settings;
  const terms = await listPermalinkTerms(siteId);
  const resolvePermalink = await createContentPermalinkResolver(siteId, {
    state, defaultLocale, terms, homes: new Map([[defaultLocale, home]]),
  });
  const scope = await getAnonymousVisibilityScope(siteId);
  const homeListed = !home || (typeSettings.get(home.type)?.seo !== false && scope.allows(home));
  const paths = new Set<string>(homeListed ? ["/"] : []);

  for (const item of published) {
    const isHome =
      home &&
      (item.id === home.id ||
        (item.translationGroupId && item.translationGroupId === home.translationGroupId));
    const pagePath = isHome || item.slug === "home" || item.slug === "" ? "/" : `/${item.slug}`;
    paths.add(isHome || pagePath === "/" ? slashPath(localePath(item.locale, "/", defaultLocale), permalinks.trailingSlash) : await resolvePermalink(item));
  }

  const localeByContent = new Map(published.map((item) => [item.id, item.locale]));
  const publishedLocales = new Set(published.map((item) => item.locale));
  for (const term of terms) {
    const locales = new Set<string>();
    for (const id of term.contentIds) {
      const locale = localeByContent.get(id);
      if (locale) locales.add(locale);
    }
    for (const locale of publishedLocales) {
      if (locales.has(locale)) paths.add(taxonomyPermalink(term, locale, permalinks, defaultLocale));
    }
  }
  const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  const hooks = getRuntimeHooks();
  let pathList = [...paths];
  if (hooks.has("seo.sitemapPaths")) {
    pathList = await hooks.applyFilter("seo.sitemapPaths", pathList, { siteId });
  }

  const privateRules = await accountPageExclusions(siteId);
  pathList = pathList.filter(p => !isExcludedPath(p, privateRules));
  const urls = pathList.map((p) => {
    const loc = origin ? `${origin}${p}` : p;
    return `  <url><loc>${esc(loc)}</loc></url>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
