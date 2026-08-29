// SPDX-License-Identifier: MIT

import { getPlugin } from "./plugins-db.js";
import { getPluginSetting } from "./plugin-kv.js";
import { getHomeContent } from "./home-page.js";
import { listPublishedContent } from "./content-public.js";
import { getDefaultLocale } from "./i18n/languages-db.js";
import { localePath } from "./i18n/locales.js";

export const SEO_PLUGIN_ID = "justflows.seo";

export interface SeoSettings {
  siteTitle: string;
  titleTemplate: string;
  defaultDescription: string;
  twitterHandle: string;
  extraSitemapPaths: string[];
}

export interface SeoPageInput {
  title: string;
  description?: string | null;
  excerpt?: string | null;
  path: string;
  canonical?: string | null;
  image?: string | null;
}

export function seoTextFromContent(content: {
  title?: string;
  excerpt?: string | null;
  fields?: Record<string, unknown>;
}): { title: string; description: string; canonical: string; image: string } {
  const fields = content.fields ?? {};
  const seoTitle = typeof fields.seoTitle === "string" ? fields.seoTitle.trim() : "";
  const seoDescription = typeof fields.seoDescription === "string" ? fields.seoDescription.trim() : "";
  const seoCanonical = typeof fields.seoCanonical === "string" ? fields.seoCanonical.trim() : "";
  const seoImage = typeof fields.seoImage === "string" ? fields.seoImage.trim() : "";
  return {
    title: seoTitle || String(content.title ?? "").trim(),
    description: seoDescription || String(content.excerpt ?? "").trim(),
    canonical: seoCanonical,
    image: seoImage,
  };
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Characters that let a JSON string escape its <script> element or break the
 * surrounding JavaScript. JSON.stringify leaves all of them literal, so a value
 * containing "</script>" would close the block and the rest would parse as HTML.
 */
const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

/** Serialize a value for embedding inside <script type="application/ld+json">. */
export function jsonLdPayload(value: unknown): string {
  return JSON.stringify(value).replace(
    SCRIPT_UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function siteOrigin(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}

export async function isSeoPluginActive(siteId: string): Promise<boolean> {
  const plugin = await getPlugin(siteId, SEO_PLUGIN_ID);
  return plugin?.status === "active";
}

export function asLocaleMap(value: unknown, defaultLocale: string): Record<string, string> {
  if (typeof value === "string") return value ? { [defaultLocale]: value } : {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string") out[key] = entry;
    }
    return out;
  }
  return {};
}

export function localizedString(
  value: unknown,
  locale: string,
  defaultLocale: string,
  fallback = "",
): string {
  if (typeof value === "string") return value;
  const map = asLocaleMap(value, defaultLocale);
  const exact = map[locale]?.trim();
  if (exact) return exact;
  const def = map[defaultLocale]?.trim();
  if (def) return def;
  const first = Object.values(map).find((entry) => entry.trim());
  return first ?? fallback;
}

async function setting<T>(siteId: string, key: string, fallback: T): Promise<T> {
  const value = await getPluginSetting<T>(SEO_PLUGIN_ID, siteId, key);
  return value ?? fallback;
}

export async function getSeoSettings(siteId: string, locale?: string): Promise<SeoSettings> {
  const defaultLocale = await getDefaultLocale();
  const lang = locale || defaultLocale;
  const extra = String((await setting(siteId, "extraSitemapPaths", "")) ?? "");
  return {
    siteTitle: localizedString(await setting(siteId, "siteTitle", ""), lang, defaultLocale),
    titleTemplate: localizedString(await setting(siteId, "titleTemplate", "%s"), lang, defaultLocale, "%s") || "%s",
    defaultDescription: localizedString(await setting(siteId, "defaultDescription", ""), lang, defaultLocale),
    twitterHandle: String((await setting(siteId, "twitterHandle", "")) ?? ""),
    extraSitemapPaths: extra.split("\n").map((line) => line.trim()).filter(Boolean),
  };
}

export function resolveSeoDescription(
  page: SeoPageInput,
  settings: SeoSettings,
): string {
  const fromPage = (page.description ?? "").trim() || (page.excerpt ?? "").trim();
  return fromPage || settings.defaultDescription.trim() || page.title.trim();
}

export function resolveSeoTitle(page: SeoPageInput, settings: SeoSettings): string {
  const pageTitle = page.title.trim();
  if (settings.titleTemplate.includes("%s")) {
    return settings.titleTemplate.replace("%s", pageTitle);
  }
  return pageTitle || settings.titleTemplate;
}

export function buildSeoHeadHtml(
  page: SeoPageInput,
  settings: SeoSettings,
  origin = siteOrigin(),
): string {
  const descriptionRaw = resolveSeoDescription(page, settings);
  const title = esc(resolveSeoTitle(page, settings));
  const description = esc(descriptionRaw);
  const path = page.path.startsWith("/") ? page.path : `/${page.path}`;
  const url = origin ? `${origin}${path}` : path;
  const canonicalRaw = (page.canonical ?? "").trim() || url;
  const image = (page.image ?? "").trim();
  const twitter = settings.twitterHandle.trim();
  const twitterCard = image ? "summary_large_image" : "summary";

  return [
    description ? `<meta name="description" content="${description}">` : "",
    title ? `<meta property="og:title" content="${title}">` : "",
    description ? `<meta property="og:description" content="${description}">` : "",
    url ? `<meta property="og:url" content="${esc(url)}">` : "",
    `<meta property="og:type" content="website">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : "",
    `<meta name="twitter:card" content="${twitterCard}">`,
    twitter ? `<meta name="twitter:site" content="${esc(twitter)}">` : "",
    image ? `<meta name="twitter:image" content="${esc(image)}">` : "",
    `<script type="application/ld+json">${jsonLdPayload({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: page.title,
      description: descriptionRaw,
      url,
      ...(image ? { image } : {}),
    })}</script>`,
    `<link rel="canonical" href="${esc(canonicalRaw)}">`,
    `<link rel="sitemap" type="application/xml" href="/sitemap.xml">`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function buildSitemapXml(siteId: string): Promise<string> {
  const settings = await getSeoSettings(siteId);
  const origin = siteOrigin();
  const defaultLocale = await getDefaultLocale();
  const published = await listPublishedContent(siteId);
  const home = await getHomeContent(siteId, defaultLocale, false);
  const paths = new Set<string>(["/", ...settings.extraSitemapPaths]);

  for (const item of published) {
    const isHome =
      home &&
      (item.id === home.id ||
        (item.translationGroupId && item.translationGroupId === home.translationGroupId));
    const pagePath = isHome || item.slug === "home" || item.slug === "" ? "/" : `/${item.slug}`;
    paths.add(localePath(item.locale, pagePath, defaultLocale));
  }

  const { getRuntimeHooks } = await import("./plugin-runtime.js");
  const hooks = getRuntimeHooks();
  let pathList = [...paths];
  if (hooks.has("seo.sitemapPaths")) {
    pathList = await hooks.applyFilter("seo.sitemapPaths", pathList, { siteId });
  }

  const urls = pathList.map((p) => {
    const loc = origin ? `${origin}${p}` : p;
    return `  <url><loc>${esc(loc)}</loc></url>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
