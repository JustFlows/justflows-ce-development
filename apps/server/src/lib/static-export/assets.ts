// SPDX-License-Identifier: MIT

import { isAccountPath } from "../../middleware/account-cache.js";
import { normalizeUrlPath } from "./paths.js";

/**
 * Any same-origin sub-resource a page pulls is downloaded into the export —
 * theme CSS, `/js/*`, uploads, **and plugin / custom-theme scripts and assets**
 * served from their own paths (e.g. `/ext/<plugin>/widget.js`). Only these
 * dynamic surfaces are excluded, because they are not static files.
 */
const DENY_PREFIXES = [
  "/admin",
  "/api",
  "/login",
  "/account",
  "/platform-account",
  "/register",
  "/install",
  "/forgot-password",
  "/reset-password",
  "/set-locale",
  "/justflows-forms",
  "/justflows-comments",
  "/justflows-analytics",
];

/** `<link rel>` values that point at a real sub-resource (not canonical/alternate/sitemap). */
const SUBRESOURCE_REL =
  /\b(?:stylesheet|icon|apple-touch-icon|mask-icon|preload|modulepreload|prefetch|preconnect|manifest)\b/i;

const SCRIPT_MEDIA_SRC =
  /<(?:script|img|source|video|audio|track|embed)\b[^>]*?\b(?:src|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const SRCSET_ATTR = /\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+("([^"]*)"|'([^']*)')/gi;
const ATTR = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s">]+))`, "i");

/** Hostname of a base URL, or "" — used to accept a page's own absolute-URL assets. */
export function originHost(baseUrl: string): string {
  try {
    return baseUrl ? new URL(baseUrl).host.toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * Resolve a reference to a downloadable same-origin path, or null. Absolute URLs
 * are accepted only when their host matches `publicHost` (the export's public
 * origin); everything else absolute is treated as an off-site resource and left
 * in the markup untouched.
 */
export function sameOriginPath(ref: string, publicHost = ""): string | null {
  const value = ref.trim();
  if (!value || value.startsWith("data:") || value.startsWith("#") || value.startsWith("//")) {
    return null;
  }
  let path: string;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!publicHost || url.host.toLowerCase() !== publicHost) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else if (value.startsWith("/")) {
    path = value;
  } else {
    return null; // mailto:, tel:, javascript:, or a page-relative path — skip
  }
  const normalized = normalizeUrlPath(path);
  if (normalized === "/") return null;
  if (isAccountPath(normalized)) return null;
  if (DENY_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p}/`))) return null;
  return normalized;
}

function pushRef(raw: string, out: Set<string>, publicHost: string): void {
  for (const piece of raw.split(",")) {
    // srcset entries look like "url 1x" / "url 640w"
    const url = piece.trim().split(/\s+/)[0] ?? "";
    const path = sameOriginPath(url, publicHost);
    if (path) out.add(path);
  }
}

function collectRegex(re: RegExp, body: string, out: Set<string>, publicHost: string): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    pushRef(match.slice(2).find((g) => g !== undefined) ?? "", out, publicHost);
  }
}

/** Same-origin asset paths referenced by an HTML document (scripts, styles, media, plugin assets). */
export function assetPathsFromHtml(html: string, publicHost = ""): string[] {
  const out = new Set<string>();
  collectRegex(SCRIPT_MEDIA_SRC, html, out, publicHost);
  collectRegex(SRCSET_ATTR, html, out, publicHost);

  // <link> only when it points at a real sub-resource.
  LINK_TAG.lastIndex = 0;
  let link: RegExpExecArray | null;
  while ((link = LINK_TAG.exec(html)) !== null) {
    const tag = link[0];
    const rel =
      tag
        .match(ATTR("rel"))
        ?.slice(2)
        .find((g) => g !== undefined) ?? "";
    if (rel && !SUBRESOURCE_REL.test(rel)) continue;
    const href =
      tag
        .match(ATTR("href"))
        ?.slice(2)
        .find((g) => g !== undefined) ?? "";
    const path = sameOriginPath(href, publicHost);
    if (path) out.add(path);
  }

  // Inline <style> blocks may pull fonts / images.
  for (const style of html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? []) {
    collectRegex(CSS_URL, style, out, publicHost);
    collectRegex(CSS_IMPORT, style, out, publicHost);
  }
  return [...out];
}

/** Same-origin asset paths referenced by a stylesheet (one level of recursion). */
export function assetPathsFromCss(css: string, publicHost = ""): string[] {
  const out = new Set<string>();
  collectRegex(CSS_URL, css, out, publicHost);
  collectRegex(CSS_IMPORT, css, out, publicHost);
  return [...out];
}

export function isCssPath(urlPath: string, contentType: string): boolean {
  return contentType.includes("text/css") || /\.css$/i.test(normalizeUrlPath(urlPath));
}
