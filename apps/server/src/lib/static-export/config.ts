// SPDX-License-Identifier: MIT

import path from "node:path";
import { parseEnvBool } from "@justflows/core";
import { getJfRoot } from "../runtime/jf-root.js";
import { getTenantContext } from "../tenancy/context.js";

/** Resolved `STATIC_EXPORT_*` configuration for one export run. */
export interface StaticExportConfig {
  /**
   * Master switch. When false the admin "Run" actions and the auto-rebuild are
   * refused; the exporter is dormant. Default true (available, run on demand).
   */
  enabled: boolean;
  /** Absolute directory the filesystem adapter writes into. */
  outDir: string;
  /**
   * Origin the crawler fetches from. Loopback in dev; on production it resolves
   * to `STATIC_EXPORT_CRAWL_URL` / `APP_URL` so a proxied host (Passenger, Plesk)
   * is crawled by its real domain, not an unreachable `127.0.0.1:PORT`.
   */
  baseUrl: string;
  /** Public origin written into the manifest / used for absolute-URL rewriting. */
  publicUrl: string;
  /**
   * Origin that keeps serving the dynamic endpoints (form + comment POST) for a
   * static deployment. When set, `<form action>` in the exported HTML is
   * rewritten to absolute URLs against it. Empty = leave actions relative.
   */
  originUrl: string;
  /**
   * Origins allowed to cross-origin `fetch()` the submit endpoints (CORS). The
   * site's own `APP_URL` / `STATIC_EXPORT_BASE_URL` and, off production,
   * `localhost` are always allowed; this adds more. Comma-separated in the env.
   */
  allowedOrigins: string[];
  /** Hard ceiling on crawled pages, so a link loop cannot run forever. */
  maxPages: number;
  /** Parallel in-flight fetches during the crawl. */
  concurrency: number;
  /** Re-run an incremental export when `cache.revalidated` fires. */
  auto: boolean;
  /** Quiet period (ms) that coalesces a burst of revalidations into one run. */
  debounceMs: number;
  /**
   * `full`: files are built ahead of time by a full or incremental export.
   * `on-demand`: a page's file is built the first time someone visits it, and
   * the app serves it while it is fresh (justflows-ce#344).
   */
  mode: StaticExportMode;
  /** On demand: seconds after which a built file is refreshed even without an edit. */
  ttlSeconds: number;
  /** On demand: background renders this process runs at once, across all sites. */
  renderCap: number;
  /** On demand: background renders this process runs at once for one site. */
  siteRenderCap: number;
}

export type StaticExportMode = "full" | "on-demand";

/** Read `STATIC_EXPORT_MODE`. Anything other than `on-demand` is `full`. */
export function parseStaticExportMode(raw: string | undefined): StaticExportMode {
  return raw?.trim().toLowerCase() === "on-demand" ? "on-demand" : "full";
}

/**
 * Parse an integer env var, clamped to `[min, max]`. Exported so the Tools
 * settings reader coerces `.env` values exactly the way an export run does —
 * otherwise the form and the run disagree on an out-of-range value.
 */
export function intFromEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Strip trailing "/" with a linear scan. `/\/+$/` is a polynomial-time match on
 * a long run of slashes (CodeQL `js/polynomial-redos`), and this runs on
 * request-body and `Origin`-header values.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return value.slice(0, end);
}

function trimSlash(value: string): string {
  return stripTrailingSlashes(value);
}

/**
 * A host where the app has no reachable loopback TCP port (Passenger on Plesk /
 * cPanel) — treated like production even when `NODE_ENV` is unset, so loopback
 * shortcuts (dev crawl base, permissive CORS) are not taken there.
 */
export function isProxiedHost(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    !!(
      process.env.PASSENGER_APP_ENV ||
      process.env.PASSENGER_LISTEN_PORT ||
      process.env.PHUSION_PASSENGER
    )
  );
}

/**
 * The site this export belongs to when it is not the installation's root site.
 * Each such site gets its own output folder and crawls its own hostname; the
 * `STATIC_EXPORT_*` / `APP_URL` env values describe the root site only. Null
 * for a single-site install, the root site, and CLI runs (no request context).
 */
export function secondaryExportSite(): { hostname: string; siteId: string } | null {
  const ctx = getTenantContext();
  if (!ctx || ctx.rootSite) return null;
  return { hostname: ctx.hostname, siteId: ctx.siteId };
}

/**
 * Folder name for a site's export. The hostname is readable on disk; anything
 * that is not a plain hostname falls back to the site id.
 */
function siteFolderName(site: { hostname: string; siteId: string }): string {
  if (/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(site.hostname) && !site.hostname.includes("..")) {
    return site.hostname;
  }
  return site.siteId.replace(/[^A-Za-z0-9_-]/g, "_") || "site";
}

/** Loopback-reachable origin for the current site's hostname, or plain loopback. */
export function siteLoopbackOrigin(port: number): string {
  const host = getTenantContext()?.hostname;
  return host ? `http://${host}:${port}` : `http://127.0.0.1:${port}`;
}

/**
 * The origin the crawler fetches bytes from. Precedence:
 *
 *   1. an explicit override — CLI `--base-url`, the admin request body, or (off
 *      production) the loopback port the admin request arrived on;
 *   2. `STATIC_EXPORT_CRAWL_URL` — this site's own origin addressed however it is
 *      actually reachable from the server process. Behind Passenger / Plesk the
 *      app has no loopback TCP port, so point this at the real domain;
 *   3. on production, `APP_URL` (the origin that renders pages) then
 *      `STATIC_EXPORT_BASE_URL` — never a bare loopback IP, which does not
 *      resolve to this app on a proxied host;
 *   4. loopback on `PORT` — the self-contained default for dev and plain Node.
 */
function resolveCrawlBase(override: string | undefined, port: number): string {
  if (override) return trimSlash(override);
  // A secondary site is addressed by its own hostname; the env origins belong
  // to the root site.
  const site = secondaryExportSite();
  if (site) return isProxiedHost() ? `https://${site.hostname}` : `http://${site.hostname}:${port}`;
  // Passenger (Plesk, cPanel) gives the app no reachable loopback TCP port, so
  // treat it like production even if NODE_ENV is unset.
  const proxied = isProxiedHost();
  const candidates = [
    override,
    process.env.STATIC_EXPORT_CRAWL_URL?.trim(),
    proxied ? process.env.APP_URL?.trim() : "",
    proxied ? process.env.STATIC_EXPORT_BASE_URL?.trim() : "",
  ];
  for (const candidate of candidates) {
    if (candidate) return trimSlash(candidate);
  }
  return siteLoopbackOrigin(port);
}

/** Origins the operator has explicitly declared as this site's own. */
function configuredCrawlOrigins(): string[] {
  return [
    process.env.APP_URL,
    process.env.STATIC_EXPORT_BASE_URL,
    process.env.STATIC_EXPORT_CRAWL_URL,
    ...(process.env.STATIC_EXPORT_ALLOWED_ORIGINS ?? "").split(","),
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v));
}

const listenerPorts = new Set<number>();

/** Record a port this process is serving on (the port an admin request arrived on). */
export function noteListenerPort(port: number | undefined): void {
  if (port && Number.isInteger(port) && port > 0 && port <= 65535) listenerPorts.add(port);
}

function isListenerPort(port: number): boolean {
  return port === intFromEnv(process.env.PORT, 3000, 1, 65535) || listenerPorts.has(port);
}

/**
 * Resolve `raw` to an origin the exporter is allowed to fetch from, or throw.
 *
 * The exporter only ever crawls *this* site, so the target must be loopback
 * (any port — dev) or exactly an origin the operator configured (`APP_URL`,
 * `STATIC_EXPORT_BASE_URL`, `STATIC_EXPORT_CRAWL_URL`,
 * `STATIC_EXPORT_ALLOWED_ORIGINS`). An admin "Run" request body and any env
 * value both pass through here, so a compromised admin session or a stray env
 * cannot turn the crawler into an SSRF probe / DoS cannon against another host.
 * Returns a normalized `scheme://host[:port]`.
 */
export function assertExportOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`crawl origin is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`crawl origin must use http(s): ${raw}`);
  }

  // Reassemble the origin from values that do NOT carry `raw` forward: a scheme
  // literal, an allow-listed host literal, and a numerically-parsed port. What
  // the crawler fetches is therefore fully decoupled from the caller's string
  // (SSRF / DoS hardening).
  const scheme = url.protocol === "https:" ? "https" : "http";
  const portNum = Number(url.port);
  const port = Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? `:${portNum}` : "";

  // `URL` keeps IPv6 hosts bracketed (`[::1]`); accept both spellings. Values
  // are literals, so nothing from `raw` reaches the return.
  const LOOPBACK: Record<string, string> = {
    localhost: "localhost",
    "127.0.0.1": "127.0.0.1",
    "::1": "[::1]",
    "[::1]": "[::1]",
  };
  const secondary = secondaryExportSite();
  // Loopback means this app's own listener, never "any local service". Only
  // the main site off production may aim at another local port (a dev server).
  const onListener = isListenerPort(portNum || (scheme === "https" ? 443 : 80));
  const loopbackHost = LOOPBACK[url.hostname.toLowerCase()];
  if (loopbackHost) {
    if (onListener || (!secondary && !isProxiedHost())) return `${scheme}://${loopbackHost}${port}`;
    throw new Error(`crawl origin ${raw} is not this application's own port`);
  }

  // The current site's own registered hostname, on the app's port or the
  // default port. With more than one site, loopback no longer maps to a site,
  // so this is how the crawler reaches it.
  const ctx = getTenantContext();
  if (ctx?.hostname && url.hostname.toLowerCase() === ctx.hostname) {
    if (!port || onListener) return `${scheme}://${ctx.hostname}${port}`;
    throw new Error(`crawl origin ${raw} must use this site's default port`);
  }
  // The env origins describe the root site; a secondary site must not crawl it.
  if (secondary) {
    throw new Error(`crawl origin ${raw} is not loopback or this site's own hostname`);
  }

  for (const entry of configuredCrawlOrigins()) {
    let configured: URL;
    try {
      configured = new URL(entry);
    } catch {
      continue;
    }
    if (configured.protocol === url.protocol && configured.host === url.host) {
      // Return the operator-configured origin, built from its own (env) parts.
      const cScheme = configured.protocol === "https:" ? "https" : "http";
      const cPortNum = Number(configured.port);
      const cPort =
        Number.isInteger(cPortNum) && cPortNum > 0 && cPortNum <= 65535 ? `:${cPortNum}` : "";
      return `${cScheme}://${configured.hostname}${cPort}`;
    }
  }
  throw new Error(`crawl origin ${raw} is not loopback or an origin configured for this site`);
}

/**
 * Read configuration from the environment. The exporter always crawls the site's
 * own running server so the output matches what a visitor receives; `baseUrl`
 * (see {@link resolveCrawlBase}) is loopback on `PORT` in dev and the real
 * domain on production.
 */
export function getStaticExportConfig(
  overrides: Partial<StaticExportConfig> = {},
): StaticExportConfig {
  const port = intFromEnv(process.env.PORT, 3000, 1, 65535);
  const jfRoot = getJfRoot();
  const defaultDir = path.resolve(jfRoot, "static-export");
  const configuredDir = process.env.STATIC_EXPORT_DIR?.trim();
  const site = secondaryExportSite();
  const baseUrl = resolveCrawlBase(overrides.baseUrl, port);
  // A secondary site publishes under its own hostname, not the root's APP_URL.
  const publicUrl = site
    ? baseUrl
    : trimSlash(process.env.STATIC_EXPORT_BASE_URL?.trim() || process.env.APP_URL?.trim() || "");

  // The export directory is written to and recursively cleared, so a
  // configured value that resolves outside the app root (`.`, `..`, `/var/www`)
  // is rejected in favour of the safe default rather than trusted.
  const resolveOutDir = (value: string, base: string): string => {
    const abs = path.resolve(base, value);
    const rel = path.relative(jfRoot, abs);
    if (rel === "" || rel === "." || rel.startsWith("..") || path.isAbsolute(rel))
      return defaultDir;
    return abs;
  };
  const rootDir = overrides.outDir
    ? resolveOutDir(overrides.outDir, process.cwd())
    : configuredDir
      ? resolveOutDir(configuredDir, jfRoot)
      : defaultDir;

  return {
    enabled: overrides.enabled ?? parseEnvBool(process.env.STATIC_EXPORT_ENABLED, true),
    // Each secondary site writes to its own sibling folder
    // (`static-export-sites/<hostname>`), never inside the root site's export,
    // so a deploy, prune, or clear of one site cannot touch another's files.
    outDir: site ? path.join(`${rootDir}-sites`, siteFolderName(site)) : rootDir,
    baseUrl,
    publicUrl: overrides.publicUrl !== undefined ? trimSlash(overrides.publicUrl) : publicUrl,
    originUrl:
      overrides.originUrl !== undefined
        ? trimSlash(overrides.originUrl)
        : site
          ? ""
          : trimSlash(process.env.STATIC_EXPORT_ORIGIN_URL?.trim() || ""),
    allowedOrigins:
      overrides.allowedOrigins ??
      (process.env.STATIC_EXPORT_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => trimSlash(s.trim()))
        .filter(Boolean),
    maxPages:
      overrides.maxPages ?? intFromEnv(process.env.STATIC_EXPORT_MAX_PAGES, 2000, 1, 100_000),
    concurrency:
      overrides.concurrency ?? intFromEnv(process.env.STATIC_EXPORT_CONCURRENCY, 4, 1, 32),
    auto: overrides.auto ?? parseEnvBool(process.env.STATIC_EXPORT_AUTO, false),
    debounceMs:
      overrides.debounceMs ?? intFromEnv(process.env.STATIC_EXPORT_DEBOUNCE_MS, 5000, 250, 600_000),
    mode: overrides.mode ?? parseStaticExportMode(process.env.STATIC_EXPORT_MODE),
    ttlSeconds:
      overrides.ttlSeconds ??
      intFromEnv(process.env.STATIC_EXPORT_TTL_SECONDS, 3600, 60, 2_592_000),
    renderCap: overrides.renderCap ?? intFromEnv(process.env.STATIC_EXPORT_RENDER_CAP, 2, 1, 16),
    siteRenderCap:
      overrides.siteRenderCap ?? intFromEnv(process.env.STATIC_EXPORT_SITE_RENDER_CAP, 1, 1, 16),
  };
}

/** Header the crawler sends so the origin can skip analytics / preview / toolbars. */
export const STATIC_EXPORT_HEADER = "x-jf-static-export";

/** Manifest filename at the root of the output directory. */
export const MANIFEST_FILE = "_static-export.json";
