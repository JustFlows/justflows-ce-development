// SPDX-License-Identifier: MIT

/**
 * Paths the static export leaves to the live app (`staticExport.exclude`).
 *
 * Pure helpers: validation, matching, and the split-origin link rewrite. The
 * exporter applies the filter and hands the result here. Exclusions end up in
 * the generated `.htaccess` / `_nginx.conf`, so every path is held to a strict
 * character set before anything else sees it.
 */

import { normalizeUrlPath } from "./paths.js";

export interface ExportExclusion {
  path: string;
  match: "exact" | "prefix";
}

/**
 * The dynamic prefixes core always routes to the app (union of `crawl.ts`
 * reserved prefixes and `assets.ts` deny prefixes), without the leading slash.
 * The configured admin path is added at render time.
 */
export const CORE_DYNAMIC_PREFIXES = [
  "api",
  "login",
  "account",
  "platform-account",
  "register",
  "install",
  "forgot-password",
  "reset-password",
  "set-locale",
  "justflows-forms",
  "justflows-comments",
  "justflows-analytics",
] as const;

/**
 * Paths the generated `_nginx.conf` already has its own `location` for. An
 * exclusion on one would emit a duplicate block and nginx would refuse the file.
 */
const CONFIG_OWNED_PATHS = new Set(["/ext", "/favicon.ico", "/robots.txt"]);

/** One or more segments of unreserved URL characters. No `.`/`..` segment is possible after the check below. */
const SAFE_PATH_RE = /^(?:\/[A-Za-z0-9._~-]+)+$/;
const MAX_PATH_LENGTH = 200;
const MAX_EXCLUSIONS = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True when `path` is `base` or sits below it on a `/` boundary. */
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Keep the well-formed entries of a `staticExport.exclude` filter result.
 * Drops anything that is not an object with a safe root-relative path, `/`
 * itself (that would un-export the whole site), paths under the core dynamic
 * prefixes or the admin path (already routed to the app), and duplicates.
 */
export function sanitizeExclusions(raw: unknown, adminPath = "/admin", mandatory = false): ExportExclusion[] {
  if (!Array.isArray(raw)) return [];
  const admin = normalizeUrlPath(adminPath);
  const core = [admin, ...CORE_DYNAMIC_PREFIXES.map((p) => `/${p}`)];
  const out: ExportExclusion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!mandatory && out.length >= MAX_EXCLUSIONS) break;
    const row = asRecord(item);
    if (!row || typeof row["path"] !== "string") continue;
    const rawPath = row["path"].trim();
    if (!rawPath.startsWith("/") || rawPath.startsWith("//") || /[?#]/.test(rawPath)) continue;
    const path = normalizeUrlPath(rawPath);
    if ((!mandatory && path === "/") || path.length > (mandatory ? 2048 : MAX_PATH_LENGTH) || (path !== "/" && !SAFE_PATH_RE.test(path))) continue;
    if (path.split("/").some((segment) => segment === "." || segment === "..")) continue;
    if (core.some((base) => within(path, base)) || CONFIG_OWNED_PATHS.has(path)) continue;
    const match = row["match"] === "exact" ? "exact" : "prefix";
    const key = `${match}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, match });
  }
  return out;
}

/** Whether a URL path (query and hash ignored) is covered by an exclusion. */
export function isExcludedPath(input: string, exclusions: readonly ExportExclusion[]): boolean {
  if (exclusions.length === 0) return false;
  const path = normalizeUrlPath(input);
  return exclusions.some((rule) =>
    rule.match === "exact" ? path === rule.path : within(path, rule.path),
  );
}

/**
 * Point `href="/…"` and `action="/…"` attributes at an excluded path to the
 * live origin, for a split-origin export where the static host cannot serve
 * them. Only double-quoted, root-relative values are touched; the query and
 * hash are kept.
 */
export function rewriteExcludedLinks(
  html: string,
  exclusions: readonly ExportExclusion[],
  originUrl: string,
): string {
  if (!originUrl || exclusions.length === 0) return html;
  // `originUrl` is operator config; escape the quote so it cannot leave the attribute.
  const origin = originUrl.replace(/\/+$/, "").replace(/"/g, "&quot;");
  return html.replace(
    /(\s(?:href|action)=")(\/(?!\/)[^"]*)"/gi,
    (whole, attr: string, url: string) =>
      isExcludedPath(url, exclusions) ? `${attr}${origin}${url}"` : whole,
  );
}

/**
 * nginx `location` blocks that hand each exclusion to `@fallback`. A prefix
 * gets the bare path and everything below its `/`, so `/shop/cart` does not
 * also capture `/shop/cartoon`.
 */
export function nginxExclusionLocations(exclusions: readonly ExportExclusion[]): string[] {
  // A Set: an exact and a prefix rule on one path share `location = /path`,
  // and nginx refuses a duplicate location.
  const lines = new Set<string>();
  for (const rule of exclusions) {
    lines.add(`location = ${rule.path}  { try_files /_pass @fallback; }`);
    if (rule.path === "/") continue;
    lines.add(
      rule.match === "exact"
        ? `location = ${rule.path}/ { try_files /_pass @fallback; }`
        : `location ^~ ${rule.path}/ { try_files /_pass @fallback; }`,
    );
  }
  return [...lines];
}

/** Regex-escaped paths without the leading slash, for an Apache `RewriteRule`. */
export function apacheExclusionPatterns(exclusions: readonly ExportExclusion[]): {
  prefix: string[];
  exact: string[];
} {
  const escape = (path: string) => path.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    prefix: exclusions.filter((rule) => rule.match === "prefix").map((rule) => escape(rule.path)),
    exact: exclusions.filter((rule) => rule.match === "exact").map((rule) => escape(rule.path)),
  };
}
