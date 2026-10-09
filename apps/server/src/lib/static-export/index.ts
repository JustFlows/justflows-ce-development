// SPDX-License-Identifier: MIT

import {
  staticExportDriver,
  deployStaticExport,
  clearDeployedStaticExport,
  staticExportObjectStore,
} from "./object-storage.js";
import type { CacheRevalidateTrigger } from "@justflows/sdk";
import { getRuntimeHooks } from "../plugins/plugin-runtime.js";
import { getJustflowsVersion } from "../runtime/version.js";
import { assetPathsFromCss, isCssPath, originHost } from "./assets.js";
import {
  assertExportOrigin,
  getStaticExportConfig,
  secondaryExportSite,
  STATIC_EXPORT_HEADER,
  stripTrailingSlashes,
  type StaticExportConfig,
} from "./config.js";
import { crawlPages, type FetchedResource } from "./crawl.js";
import { exportFetch } from "./export-fetch.js";
import { discoverRoutes, NOT_FOUND_PROBE } from "./discover.js";
import {
  isExcludedPath,
  rewriteExcludedLinks,
  sanitizeExclusions,
  type ExportExclusion,
} from "./exclusions.js";
import { computeAffected } from "./invalidate.js";
import {
  manifestFiles,
  readManifest,
  sha256,
  suggestCacheControl,
  renderHostHeaders,
  HOST_HEADERS_FILE,
  HTACCESS_FILE,
  NGINX_FILE,
  renderHtaccess,
  renderNginxConf,
  writeManagedFile,
  writeManifest,
  type ManifestAsset,
  type ManifestRoute,
  type RouteDeps,
  type StaticExportManifest,
} from "./manifest.js";
import { getAdminPathConfig } from "../admin/admin-path.js";
import { getPerformanceConfig } from "../cache/performance-settings.js";
import { normalizeUrlPath, urlPathToFile } from "./paths.js";
import { isCurrentSiteStaticExportEnabled } from "./site-enabled.js";
import { redirectStubHtml, writeExport, type OutputFile } from "./write-fs.js";

export interface RunStaticExportOptions {
  mode?: "full" | "incremental";
  baseUrl?: string;
  publicUrl?: string;
  /** Incremental: the revalidation trigger that scheduled this run. */
  trigger?: CacheRevalidateTrigger;
  /** Incremental: content ids / translation groups that changed. */
  contentIds?: string[];
  translationGroupIds?: string[];
  /** Explicit path list to rebuild (overrides trigger-based selection). */
  only?: string[];
  reason?: string;
  /** Run even when `STATIC_EXPORT_ENABLED=0` (used by the "Clear + one last run" paths). */
  force?: boolean;
  log?: (line: string) => void;
}

export interface StaticExportSummary {
  ok: boolean;
  mode: "full" | "incremental";
  outDir: string;
  publicUrl: string;
  pages: number;
  assets: number;
  bytes: number;
  pruned: number;
  durationMs: number;
  hitPageLimit: boolean;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

export interface StaticExportStatus {
  configured: StaticExportConfig;
  hasExport: boolean;
  lastRun: {
    generatedAt: string;
    mode: string;
    pages: number;
    assets: number;
    publicUrl: string;
  } | null;
}

const ANALYTICS_BUFFER_MS = 400;

function localeFromPath(path: string): string | undefined {
  const match = /^\/([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\//.exec(path);
  return match?.[1];
}

/** Build a fetcher bound to the export origin that reports redirects instead of following them. */
function makeFetcher(baseUrl: string): (path: string) => Promise<FetchedResource> {
  return async (path: string) => {
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await exportFetch(url, {
      redirect: "manual",
      headers: { [STATIC_EXPORT_HEADER]: "1", "user-agent": "JustFlows-StaticExport/1" },
    });
    const status = res.status;
    const location = res.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      let target = location;
      try {
        target = new URL(location, url).pathname;
      } catch {
        // keep raw location
      }
      return {
        path,
        status,
        contentType: "",
        body: Buffer.alloc(0),
        redirectedTo: normalizeUrlPath(target),
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      path,
      status,
      contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
      body: buf,
      redirectedTo: null,
    };
  };
}

type OriginVerdict =
  /** `/api/healthz` on our origin reports the site installed — crawl it. */
  | { kind: "ok"; detail: string }
  /** `/` renders a real page even though healthz was unclear — crawl anyway. */
  | { kind: "ok-soft"; detail: string }
  /** Confirmed not installed — `/` redirects to the install wizard. */
  | { kind: "not-installed"; detail: string }
  /** Nothing usable answered — a proxy, a wrong origin, or the server is down. */
  | { kind: "unreachable"; detail: string };

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether `origin` is this site and ready to crawl. `/api/healthz` is the
 * fast path; something in front of the app (the production bootstrap wrapper, a
 * CDN, a WAF) can answer it with JSON that omits `installed`, so an unclear
 * health result is cross-checked against `/` — which only redirects to
 * `/install` when the site genuinely is not set up.
 */
async function verifyOrigin(origin: string): Promise<OriginVerdict> {
  let health: Response;
  try {
    health = await exportFetch(`${origin}/api/healthz`, {
      redirect: "manual",
      headers: { [STATIC_EXPORT_HEADER]: "1" },
    });
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  const body = await readJson(health);
  // The real healthz always carries a boolean `installed`. Anything else is a
  // proxy / health-checker / wrong server talking, not our origin.
  if (typeof body?.installed === "boolean") {
    if (body.installed) return { kind: "ok", detail: "healthz installed=true" };
  }

  // A secondary site must prove it reached this application. "Something
  // answered /" is only accepted for the main site's operator-configured
  // origins, where a proxy may shadow /api/healthz.
  if (secondaryExportSite()) {
    return body?.installed === false
      ? { kind: "not-installed", detail: "healthz installed=false" }
      : { kind: "unreachable", detail: "no JustFlows healthz" };
  }

  // healthz was missing, not ours, or said installed=false — confirm against `/`.
  let root: Response;
  try {
    root = await exportFetch(`${origin}/`, {
      redirect: "manual",
      headers: { [STATIC_EXPORT_HEADER]: "1", "user-agent": "JustFlows-StaticExport/1" },
    });
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  const location = root.headers.get("location") ?? "";
  if (root.status >= 300 && root.status < 400 && /\/install(\b|\/|$)/.test(location)) {
    return { kind: "not-installed", detail: `/ redirects to ${location}` };
  }
  if (root.status >= 200 && root.status < 400) {
    const via =
      typeof body?.installed === "boolean" ? "healthz installed=false" : "no JustFlows healthz";
    return { kind: "ok-soft", detail: `${via}, but / responded ${root.status}` };
  }
  return { kind: "unreachable", detail: `/ responded ${root.status}` };
}

/**
 * Resolve the origin to crawl. Tries the configured base first, then falls back
 * to `APP_URL`, so a mis-set loopback port on a proxied host still exports.
 * Throws with a pointed message when nothing usable answers.
 */
async function resolveCrawlOrigin(baseUrl: string, log: (line: string) => void): Promise<string> {
  // APP_URL is the root site's origin; a secondary site only crawls itself.
  const appUrl = secondaryExportSite()
    ? ""
    : stripTrailingSlashes(process.env.APP_URL?.trim() ?? "");
  const requested = appUrl && appUrl !== baseUrl ? [baseUrl, appUrl] : [baseUrl];

  // `assertExportOrigin` is the single gate every fetch below sits behind
  // (`verifyOrigin` here, then `makeFetcher` in `runStaticExport`): it rejects
  // anything that is not loopback or an operator-configured origin, so a
  // tampered request body or env var cannot aim the crawler at another host.
  const candidates: string[] = [];
  for (const candidate of requested) {
    try {
      const safe = assertExportOrigin(candidate);
      if (!candidates.includes(safe)) candidates.push(safe);
    } catch (err) {
      log(`⚠ ignoring crawl origin ${candidate}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `No usable crawl origin for this site. Set STATIC_EXPORT_CRAWL_URL (or APP_URL) ` +
        `to this site's own reachable origin — behind Passenger / Plesk that is your ` +
        `public domain, not a loopback port.`,
    );
  }
  const primary = candidates[0]!;

  const tried: string[] = [];
  for (const candidate of candidates) {
    const verdict = await verifyOrigin(candidate);
    tried.push(`${candidate} (${verdict.detail})`);
    if (verdict.kind === "not-installed") {
      throw new Error(`The site at ${candidate} is not installed yet — nothing to export.`);
    }
    if (verdict.kind === "ok" || verdict.kind === "ok-soft") {
      if (candidate !== primary) {
        log(`⚠ ${primary} did not answer as this site — crawling ${candidate} instead.`);
      }
      if (verdict.kind === "ok-soft") {
        log(
          `⚠ Could not confirm ${candidate} via /api/healthz (${verdict.detail}) — crawling anyway.`,
        );
      }
      log(`↻ Crawling ${candidate}`);
      return candidate;
    }
  }
  throw new Error(
    `Could not reach this JustFlows site to crawl it. Tried: ${tried.join("; ")}. ` +
      `Set STATIC_EXPORT_CRAWL_URL (or APP_URL) to an origin that serves this site — ` +
      `behind Passenger / Plesk that is your public domain, not a loopback port.`,
  );
}

/** Fetch every referenced asset once, following one level of CSS `url()` / `@import`. */
async function collectAssets(
  refs: Set<string>,
  fetcher: (path: string) => Promise<FetchedResource>,
  limit: number,
  publicHost: string,
): Promise<Map<string, FetchedResource>> {
  const fetched = new Map<string, FetchedResource>();
  const queue = [...refs];
  let cursor = 0;
  while (cursor < queue.length && fetched.size < limit) {
    const path = queue[cursor++]!;
    if (fetched.has(path)) continue;
    let res: FetchedResource;
    try {
      res = await fetcher(path);
    } catch {
      continue;
    }
    if (res.redirectedTo) {
      // e.g. /favicon.ico → /uploads/...; keep the redirect target instead.
      if (!fetched.has(res.redirectedTo) && !queue.includes(res.redirectedTo)) {
        queue.push(res.redirectedTo);
      }
      fetched.set(path, res);
      continue;
    }
    fetched.set(path, res);
    if (isCssPath(path, res.contentType)) {
      for (const nested of assetPathsFromCss(res.body.toString("utf8"), publicHost)) {
        if (!fetched.has(nested) && !queue.includes(nested)) queue.push(nested);
      }
    }
  }
  return fetched;
}

/** Endpoint paths a static host cannot serve — POST handlers on the Node origin. */
const DYNAMIC_ENDPOINTS = [
  { key: "forms" as const, path: "/justflows-forms/submit" },
  { key: "comments" as const, path: "/justflows-comments/submit" },
];

/**
 * Resolve the `<form action>` each dynamic endpoint should point at in the
 * exported HTML. `STATIC_EXPORT_ORIGIN_URL` makes them absolute (so a purely
 * static host can still submit to a reachable Node origin); the
 * `staticExport.formAction` filter can override per endpoint (e.g. a serverless
 * function or a third-party form service).
 */
async function resolveActionRewrites(
  originUrl: string,
  siteId: string,
): Promise<Map<string, string>> {
  const hooks = getRuntimeHooks();
  const hasFilter = hooks.has("staticExport.formAction");
  const out = new Map<string, string>();
  for (const { key, path } of DYNAMIC_ENDPOINTS) {
    let action = originUrl ? `${originUrl}${path}` : path;
    if (hasFilter) {
      try {
        const filtered = await hooks.applyFilter("staticExport.formAction", action, {
          siteId,
          endpoint: key,
          defaultAction: path,
        });
        if (typeof filtered === "string" && filtered) action = filtered;
      } catch {
        // a broken filter must not abort the export
      }
    }
    if (action !== path) out.set(path, action);
  }
  return out;
}

function rewriteActions(html: string, rewrites: Map<string, string>): string {
  let out = html;
  for (const [from, to] of rewrites) {
    // `to` is an admin-set origin or a plugin-filter result — escape the quote
    // so it cannot break out of the `action="…"` attribute it is spliced into.
    const safeTo = to.replace(/"/g, "&quot;");
    out = out.split(`action="${from}"`).join(`action="${safeTo}"`);
  }
  return out;
}

/**
 * Paths plugins leave to the live app (`staticExport.exclude`), validated. A
 * broken filter must not abort the export, so it counts as no exclusions.
 */
async function resolveExclusions(siteId: string, adminPath: string): Promise<ExportExclusion[]> {
  const hooks = getRuntimeHooks();
  if (!hooks.has("staticExport.exclude")) return [];
  try {
    return sanitizeExclusions(
      await hooks.applyFilter("staticExport.exclude", [], { siteId }),
      adminPath,
    );
  } catch {
    return [];
  }
}

/**
 * Stamp every exported page with a `window.__JF_ORIGIN__` hint in `<head>`.
 *
 * This is deliberately generic — the exporter has no per-plugin knowledge. Two
 * things read it:
 *   - its mere presence marks the page as export-served rather than
 *     server-rendered, so a plugin script that ships in both (e.g. the Analytics
 *     pageview beacon) can stay inert on the live site and only act here;
 *   - its value is the Node origin such a script should call back to
 *     (`STATIC_EXPORT_ORIGIN_URL`), or `""` for a same-origin / hybrid deploy
 *     where a relative URL already reaches the origin.
 */
function decoratePage(html: string, originUrl: string): string {
  // `JSON.stringify` does not escape `<` / `/`, so an origin containing
  // `</script>` would close the tag early. Escape `<` for the inline script.
  const json = JSON.stringify(originUrl).replace(/</g, "\\u003c");
  const head = `<script>window.__JF_ORIGIN__=${json};</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  return `${head}${html}`;
}

function routeDeps(
  path: string,
  html: string,
  contentIdsForPath: string[],
  groupIdsForPath: string[],
): RouteDeps {
  const dynamicList =
    path === "/" ||
    /^\/[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(path) ||
    /\/page\/\d+["/\s]/.test(html);
  return {
    content: contentIdsForPath,
    translationGroups: groupIdsForPath,
    locale: localeFromPath(path),
    dynamicList,
  };
}

export async function runStaticExport(
  options: RunStaticExportOptions = {},
): Promise<StaticExportSummary> {
  const startedAt = new Date();
  const log = options.log ?? (() => {});
  const mode: "full" | "incremental" = options.mode ?? "full";
  const cfg = getStaticExportConfig({ baseUrl: options.baseUrl, publicUrl: options.publicUrl });
  const errors: string[] = [];

  if (!cfg.enabled && !options.force) {
    throw new Error(
      "Static export is disabled (STATIC_EXPORT_ENABLED=0). Enable it in Admin → Tools.",
    );
  }
  if (!options.force && !(await isCurrentSiteStaticExportEnabled())) {
    throw new Error("Static export is turned off for this website.");
  }

  if (staticExportDriver() === "s3") staticExportObjectStore();
  const crawlBase = await resolveCrawlOrigin(cfg.baseUrl, log);
  const fetcher = makeFetcher(crawlBase);
  const fetchText = async (path: string) => {
    const res = await fetcher(path);
    return { ok: res.status >= 200 && res.status < 300, body: res.body.toString("utf8") };
  };

  const { getSiteId } = await import("../themes/themes-db.js");
  const siteId = (await getSiteId()) ?? "";
  const adminPath = await getAdminPathConfig()
    .then((config) => config.path)
    .catch(() => "/admin");
  const exclusions = await resolveExclusions(siteId, adminPath);
  const excluded = (path: string) => isExcludedPath(path, exclusions);
  if (exclusions.length > 0) {
    log(
      `• Leaving ${exclusions.length} path(s) to the live app: ` +
        exclusions
          .map((rule) => (rule.match === "exact" ? rule.path : `${rule.path}/*`))
          .join(", "),
    );
  }

  const discovered = await discoverRoutes(fetchText);
  const pathToContentIds = new Map<string, string[]>();
  const pathToGroupIds = new Map<string, string[]>();
  for (const [id, paths] of discovered.contentPaths) {
    const group = discovered.translationGroups.get(id);
    for (const p of paths) {
      const ids = pathToContentIds.get(p) ?? [];
      if (!ids.includes(id)) ids.push(id);
      pathToContentIds.set(p, ids);
      if (group) {
        const groups = pathToGroupIds.get(p) ?? [];
        if (!groups.includes(group)) groups.push(group);
        pathToGroupIds.set(p, groups);
      }
    }
  }

  const prev = await readManifest(cfg.outDir);
  let seeds: string[];
  let prune: boolean;
  let discoverLinks: boolean;
  let assetsWanted = true;

  if (mode === "full") {
    seeds = discovered.paths;
    prune = true;
    discoverLinks = true;
    log(`• Full export — ${seeds.length} seed route(s)`);
  } else if (options.only && options.only.length > 0) {
    seeds = options.only.map(normalizeUrlPath);
    prune = false;
    discoverLinks = false;
    log(`• Incremental export — ${seeds.length} explicit route(s)`);
  } else {
    const selection = computeAffected(options.trigger ?? "manual", prev, {
      contentIds: options.contentIds,
      translationGroupIds: options.translationGroupIds,
    });
    log(`• Incremental export — ${selection.reason}`);
    if (selection.all) {
      seeds = discovered.paths;
      prune = true;
      discoverLinks = true;
    } else {
      const known = new Set(prev?.routes.map((r) => r.path) ?? []);
      const newlyPublished = discovered.paths.filter((p) => !known.has(p));
      seeds = [...new Set([...selection.paths, ...newlyPublished])];
      prune = false;
      discoverLinks = false;
      assetsWanted = selection.assets;
    }
  }

  seeds = seeds.filter((path) => path === NOT_FOUND_PROBE || !excluded(path));
  const crawl = await crawlPages(seeds, fetcher, {
    maxPages: cfg.maxPages,
    concurrency: cfg.concurrency,
    publicUrl: cfg.publicUrl,
    discoverLinks,
    exclude: excluded,
  });
  errors.push(...crawl.errors);
  // A crawl that threw on some fetches or stopped at the page cap did not see
  // the whole site this run. Pruning (removing every on-disk file the crawl did
  // not re-produce) would then delete pages that are still live at the origin.
  let crawlDegraded = crawl.errors.length > 0 || crawl.hitLimit;
  if (crawl.hitLimit) {
    log(`⚠ Stopped at STATIC_EXPORT_MAX_PAGES=${cfg.maxPages}; raise it to export the rest.`);
  }

  const actionRewrites = await resolveActionRewrites(cfg.originUrl, siteId);
  if (actionRewrites.size > 0) {
    log(
      `• Rewriting ${actionRewrites.size} dynamic form action(s) → ${cfg.originUrl || "(filter)"}`,
    );
  }

  /** Bytes to write for a page — HTML gets form actions rewritten + the origin stamp. */
  const pageBody = (page: { body: Buffer; contentType: string }): Buffer => {
    if (!page.contentType.includes("text/html")) return page.body;
    let html = page.body.toString("utf8");
    if (actionRewrites.size > 0) html = rewriteActions(html, actionRewrites);
    // Split origin: the static host cannot serve an excluded page, so send links there to the app.
    html = rewriteExcludedLinks(html, exclusions, cfg.originUrl);
    html = decoratePage(html, cfg.originUrl);
    return Buffer.from(html, "utf8");
  };

  // ── Routes ────────────────────────────────────────────────────────────────
  const routes: ManifestRoute[] = [];
  const files: OutputFile[] = [];
  const browserCache = getPerformanceConfig().browserCache;
  const prunePaths = new Set<string>();
  // Client scripts a plugin ships in the export (the Analytics beacon, the Forms
  // enhancement) ride along in the crawled `/jf-plugins.<hash>.js` bundle, so
  // there is nothing plugin-specific to seed here.
  const assetRefs = new Set<string>(["/favicon.ico"]);

  for (const page of crawl.pages) {
    for (const ref of page.assetRefs) assetRefs.add(ref);

    if (page.path === NOT_FOUND_PROBE) {
      // The themed 404 body, served from the site root as 404.html.
      const body = pageBody(page);
      files.push({ rel: "404.html", body });
      routes.push({
        path: "/404.html",
        file: "404.html",
        status: page.status,
        contentType: page.contentType || "text/html",
        bytes: body.length,
        sha256: sha256(body),
        deps: { content: [], translationGroups: [], dynamicList: false },
        cacheControl: suggestCacheControl("/404.html", "text/html", browserCache),
      });
      continue;
    }

    if (page.status >= 400) {
      if (page.status === 404 || page.status === 410) {
        // Genuinely gone: drop its previously-exported file.
        if (prev?.routes.some((r) => r.path === page.path)) prunePaths.add(page.path);
        errors.push(`${page.path}: origin returned ${page.status}`);
      } else {
        // 5xx / 401 / 403 — a transient or auth blip, not a deletion. Keep any
        // file already on disk and skip the destructive prune for this run.
        crawlDegraded = true;
        errors.push(`${page.path}: origin returned ${page.status} (kept previous copy)`);
      }
      continue;
    }

    const file = urlPathToFile(page.path, page.contentType);
    const html = page.contentType.includes("text/html") ? page.body.toString("utf8") : "";
    const body = pageBody(page);
    files.push({ rel: file, body });
    routes.push({
      path: page.path,
      file,
      status: page.status,
      contentType: page.contentType || "application/octet-stream",
      bytes: body.length,
      sha256: sha256(body),
      deps: routeDeps(
        page.path,
        html,
        pathToContentIds.get(page.path) ?? [],
        pathToGroupIds.get(page.path) ?? [],
      ),
      cacheControl: suggestCacheControl(page.path, page.contentType || "text/html", browserCache),
    });
  }

  // Origin redirects → refresh stubs so a deep link still lands somewhere.
  for (const { from, to } of crawl.redirects) {
    if (from === "/favicon.ico") {
      assetRefs.add(to);
      continue;
    }
    const file = urlPathToFile(from, "text/html");
    const body = redirectStubHtml(to);
    files.push({ rel: file, body });
    routes.push({
      path: from,
      file,
      status: 200,
      contentType: "text/html",
      bytes: body.length,
      sha256: sha256(body),
      deps: { content: [], translationGroups: [], dynamicList: false },
      cacheControl: suggestCacheControl(from, "text/html", browserCache),
    });
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  // Let a plugin / custom theme add asset URLs the scanner cannot see
  // (dynamic imports, workers, runtime-fetched JSON, fonts loaded from JS).
  const assetHooks = getRuntimeHooks();
  if (assetHooks.has("staticExport.assets")) {
    try {
      const extra = await assetHooks.applyFilter("staticExport.assets", [...assetRefs], { siteId });
      if (Array.isArray(extra)) {
        for (const p of extra) {
          if (typeof p === "string" && p.startsWith("/")) assetRefs.add(normalizeUrlPath(p));
        }
      }
    } catch {
      // a broken filter must not abort the export
    }
  }

  // `assetsWanted` is false on a targeted content incremental — those runs do
  // not re-download assets that may merely have changed (theme.css, fonts). But
  // a rebuilt page can *newly* reference an asset the previous manifest never
  // had (an image added to a page, a gallery block), and that file still has to
  // be fetched or it 404s on the static host. So always pull refs the previous
  // manifest is missing; only skip the re-fetch of already-known ones.
  const knownAssetPaths = new Set((prev?.assets ?? []).map((a) => a.path));
  const refsToFetch = assetsWanted
    ? assetRefs
    : new Set([...assetRefs].filter((ref) => !knownAssetPaths.has(ref)));

  for (const ref of [...refsToFetch]) {
    if (excluded(ref)) refsToFetch.delete(ref);
  }

  const assets: ManifestAsset[] = [];
  if (refsToFetch.size > 0) {
    const fetchedAssets = await collectAssets(
      refsToFetch,
      fetcher,
      cfg.maxPages * 3,
      originHost(cfg.publicUrl),
    );
    for (const [refPath, res] of fetchedAssets) {
      const finalRes = res.redirectedTo ? (fetchedAssets.get(res.redirectedTo) ?? res) : res;
      if (finalRes.redirectedTo || finalRes.status >= 400 || finalRes.body.length === 0) continue;
      const sourcePath = refPath === "/favicon.ico" && res.redirectedTo ? "/favicon.ico" : refPath;
      const file = urlPathToFile(sourcePath, finalRes.contentType);
      if (assets.some((a) => a.file === file)) continue;
      files.push({ rel: file, body: finalRes.body });
      assets.push({
        path: sourcePath,
        file,
        status: finalRes.status,
        contentType: finalRes.contentType || "application/octet-stream",
        bytes: finalRes.body.length,
        sha256: sha256(finalRes.body),
        cacheControl: suggestCacheControl(sourcePath, finalRes.contentType || "", browserCache),
      });
    }
  }

  // A pruning run (full export, or an "all" incremental) that came back
  // incomplete is downgraded to non-pruning: keep whatever is already on disk,
  // carry its manifest entries forward, and only remove the paths the origin
  // explicitly reported as 404/410 this run.
  if (prune && crawlDegraded) {
    prune = false;
    log(
      "⚠ Crawl was incomplete (errors or page limit) — keeping existing files, no prune this run.",
    );
  }

  // A path a plugin now excludes must not keep serving an old static copy,
  // whether or not this run prunes.
  const staleAssets = new Set<string>();
  for (const route of prev?.routes ?? []) {
    if (route.path !== "/404.html" && excluded(route.path)) prunePaths.add(route.path);
  }
  for (const asset of prev?.assets ?? []) {
    if (excluded(asset.path)) staleAssets.add(asset.file);
  }

  // ── Merge with the previous manifest when not pruning ─────────────────────
  // `prune` is false on a targeted incremental run (and on a downgraded run
  // above), so untouched files stay on disk; carry their manifest entries
  // forward so the manifest still describes the whole export.
  let finalRoutes = routes;
  let finalAssets = assets;
  if (!prune && prev) {
    const replaced = new Set(routes.map((r) => r.path));
    finalRoutes = [
      ...prev.routes.filter((r) => !replaced.has(r.path) && !prunePaths.has(r.path)),
      ...routes,
    ];
    // Keep every previous asset we did not re-fetch this run, then add what we
    // did (a full/asset run replaces the lot; a targeted run adds only the new
    // files a rebuilt page pulled in).
    const replacedAssets = new Set(assets.map((a) => a.file));
    finalAssets = [
      ...prev.assets.filter((a) => !replacedAssets.has(a.file) && !staleAssets.has(a.file)),
      ...assets,
    ];
  }

  // Files that vanished (seed now 404s, or a plugin now excludes the path) must
  // be removed even without a full prune.
  if ((prunePaths.size > 0 || staleAssets.size > 0) && !prune && prev) {
    const { rm, realpath, mkdir } = await import("node:fs/promises");
    const { resolvePathUnderBase } = await import("../security/safe-path.js");
    await mkdir(cfg.outDir, { recursive: true });
    const base = await realpath(cfg.outDir);
    for (const p of prunePaths) {
      const gone = prev.routes.find((r) => r.path === p);
      if (!gone) continue;
      const abs = resolvePathUnderBase(base, gone.file);
      if (abs) await rm(abs, { force: true }).catch(() => {});
      log(`↻ removed ${gone.file} (${excluded(p) ? "left to the live app" : "origin now 404"})`);
    }
    for (const file of staleAssets) {
      const abs = resolvePathUnderBase(base, file);
      if (abs) await rm(abs, { force: true }).catch(() => {});
      log(`↻ removed ${file} (left to the live app)`);
    }
  }

  const manifest: StaticExportManifest = {
    generatedAt: new Date().toISOString(),
    mode,
    justflowsVersion: getJustflowsVersion(),
    publicUrl: cfg.publicUrl,
    routes: finalRoutes.sort((a, b) => a.path.localeCompare(b.path)),
    assets: finalAssets.sort((a, b) => a.file.localeCompare(b.file)),
    config: { maxPages: cfg.maxPages, concurrency: cfg.concurrency },
  };

  const keep = manifestFiles(manifest);
  files.push({ rel: HOST_HEADERS_FILE, body: Buffer.from(renderHostHeaders(manifest), "utf8") });
  const writeReport = await writeExport(
    cfg.outDir,
    files.filter((f) => f.rel),
    keep,
    prune,
  );
  for (const skipped of writeReport.skipped) errors.push(`unsafe output path skipped: ${skipped}`);

  await writeManifest(cfg.outDir, manifest);

  // Web-server config beside the export, the counterpart to `_headers` for
  // Cloudflare Pages / Netlify. Each file is regenerated only while it still
  // carries the sentinel line, so a hand-edited one is left alone.
  try {
    const managed: Array<[string, string]> = [
      [HTACCESS_FILE, renderHtaccess({ adminPath, exclusions })],
      [NGINX_FILE, renderNginxConf({ adminPath, rootDir: cfg.outDir, exclusions })],
    ];
    for (const [name, body] of managed) {
      const result = await writeManagedFile(cfg.outDir, name, body);
      if (result === "kept-custom") log(`· ${name} is hand-edited — left as-is`);
    }
  } catch (err) {
    log(`⚠ could not write server config: ${(err as Error).message}`);
  }

  const bytes =
    manifest.routes.reduce((n, r) => n + r.bytes, 0) +
    manifest.assets.reduce((n, a) => n + a.bytes, 0);
  const finishedAt = new Date();
  const summary: StaticExportSummary = {
    ok: errors.length === 0,
    mode,
    outDir: cfg.outDir,
    publicUrl: cfg.publicUrl,
    pages: manifest.routes.length,
    assets: manifest.assets.length,
    bytes,
    pruned: writeReport.pruned.length,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    hitPageLimit: crawl.hitLimit,
    errors,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };

  log(
    `✓ ${summary.pages} page(s), ${summary.assets} asset(s), ` +
      `${(bytes / 1024).toFixed(0)} KB → ${cfg.outDir}` +
      (summary.pruned ? ` (${summary.pruned} pruned)` : ""),
  );
  for (const err of errors.slice(0, 20)) log(`✗ ${err}`);

  if (summary.ok && staticExportDriver() === "s3") {
    try {
      await deployStaticExport(cfg.outDir, manifest);
      log("✓ Static export deployed to object storage");
    } catch {
      summary.ok = false;
      summary.errors.push(
        "Object storage deployment failed; check the storage connection and retry the export.",
      );
      log("✗ Object storage deployment failed; the previous deployment remains available.");
    }
  }

  // Let a deploy plugin push the directory to object storage / a CDN.
  try {
    const hooks = getRuntimeHooks();
    await hooks.dispatchAction("staticExport.completed", summary, { source: "system" });
    await hooks.dispatchAction(
      "staticExport.deploy",
      { outDir: cfg.outDir, publicUrl: cfg.publicUrl, manifest, summary },
      { source: "system" },
    );
  } catch {
    // deploy hooks must not fail the export
  }

  // Give the fire-and-forget analytics skip a beat (defensive; header already skips).
  await new Promise((r) => setTimeout(r, ANALYTICS_BUFFER_MS));

  return summary;
}

/**
 * Delete the export directory. Refuses unless it holds our manifest (proof the
 * folder is ours and not, say, a mistyped `STATIC_EXPORT_DIR` pointing at
 * something important) — pass `force` to skip that check.
 */
export async function clearStaticExport(
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; removed: boolean; outDir: string; reason?: string }> {
  const { outDir } = getStaticExportConfig();
  const fsp = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const { getJfRoot } = await import("../runtime/jf-root.js");

  // `force` skips only the manifest-presence check below — never this one. A
  // misconfigured `STATIC_EXPORT_DIR` (`.`, `..`, an absolute path) must not let
  // a recursive delete escape the app directory. `outDir` is resolved against
  // `getJfRoot()` in getStaticExportConfig, so compare against the same base.
  const rel = nodePath.relative(getJfRoot(), outDir);
  if (rel === "" || rel === "." || rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    return {
      ok: false,
      removed: false,
      outDir,
      reason: "refusing to clear a path that is not inside the app directory",
    };
  }

  const remoteRemoved = staticExportDriver() === "s3" ? await clearDeployedStaticExport() : false;
  let exists = false;
  try {
    exists = (await fsp.stat(outDir)).isDirectory();
  } catch {
    return { ok: true, removed: remoteRemoved, outDir, reason: "nothing to clear" };
  }

  const manifest = await readManifest(outDir);
  if (!manifest && !opts.force) {
    return {
      ok: false,
      removed: false,
      outDir,
      reason: `${nodePath.basename(outDir)} has no ${"_static-export.json"} — refusing to delete it`,
    };
  }
  if (exists) await fsp.rm(outDir, { recursive: true, force: true });
  return { ok: true, removed: true, outDir };
}

export async function getStaticExportStatus(): Promise<StaticExportStatus> {
  const configured = getStaticExportConfig();
  const manifest = await readManifest(configured.outDir);
  return {
    configured,
    hasExport: manifest != null,
    lastRun: manifest
      ? {
          generatedAt: manifest.generatedAt,
          mode: manifest.mode,
          pages: manifest.routes.length,
          assets: manifest.assets.length,
          publicUrl: manifest.publicUrl,
        }
      : null,
  };
}
