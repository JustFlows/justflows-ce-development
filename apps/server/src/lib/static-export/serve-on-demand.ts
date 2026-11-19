// SPDX-License-Identifier: MIT

import type { NextFunction, Request, Response } from "express";
import { isAccountPath } from "../../middleware/account-cache.js";
import { getAdminPathConfig } from "../admin/admin-path.js";
import { getSession } from "../auth/session.js";
import { getSiteId } from "../settings/site-settings.js";
import { isSiteClosed } from "../settings/site-visibility.js";
import { getTenantContext } from "../tenancy/context.js";
import {
  getStaticExportConfig,
  noteListenerPort,
  siteLoopbackOrigin,
  STATIC_EXPORT_HEADER,
  type StaticExportConfig,
} from "./config.js";
import { isCrawlablePath } from "./crawl.js";
import { NOT_FOUND_PROBE } from "./discover.js";
import { CORE_DYNAMIC_PREFIXES } from "./exclusions.js";
import { exportFetch } from "./export-fetch.js";
import { exportPageTools, resolveCrawlOrigin, type ExportPageTools } from "./index.js";
import {
  createOnDemandEngine,
  freshness,
  type OnDemandEnv,
  type OnDemandEngine,
  type RenderedPage,
} from "./on-demand.js";
import { onDemandFiles, type OnDemandFiles } from "./on-demand-files.js";
import { dbOnDemandStore, type OnDemandPage, type OnDemandStats } from "./on-demand-store.js";
import { normalizeUrlPath } from "./paths.js";
import { EXPORT_DEPS_HEADER, onDemandRenderHeaderValue, parseExportDeps } from "./render-request.js";
import { isCurrentSiteStaticExportEnabled } from "./site-enabled.js";

/**
 * Express wiring for the on-demand export (justflows-ce#344): the middleware
 * that serves built files, and the handlers that mark them stale.
 */

const TOOLS_TTL_MS = 30_000;
const ORIGIN_TTL_MS = 5 * 60_000;
const RENDER_TIMEOUT_MS = 30_000;

const toolsCache = new Map<string, { at: number; tools: Promise<ExportPageTools> }>();
const originCache = new Map<string, { at: number; origin: Promise<string> }>();
let lastLocalPort: number | undefined;

function siteKey(siteId: string): string {
  return `${siteId}\n${getTenantContext()?.hostname ?? ""}`;
}

/** Bounded per-site cache: the oldest entry goes first. */
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (!cache.has(key) && cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function toolsFor(siteId: string, cfg: StaticExportConfig): Promise<ExportPageTools> {
  const key = siteKey(siteId);
  const hit = toolsCache.get(key);
  if (hit && Date.now() - hit.at < TOOLS_TTL_MS) return hit.tools;
  const tools = exportPageTools(siteId, cfg);
  tools.catch(() => toolsCache.delete(key));
  return remember(toolsCache, key, { at: Date.now(), tools }).tools;
}

function log(line: string): void {
  const host = getTenantContext()?.hostname ?? "";
  console.log(`[justflows] static-export on-demand ${host.replace(/[\r\n]/g, "")} ${line.replace(/[\r\n]/g, "")}`);
}

/**
 * The origin renders go to, checked once and then reused. Off production
 * this is loopback on the port visitors arrive on, as for an admin run.
 */
function renderOrigin(siteId: string): Promise<string> {
  const key = siteKey(siteId);
  const hit = originCache.get(key);
  if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit.origin;
  const isProd = process.env.NODE_ENV === "production";
  const cfg = getStaticExportConfig({
    baseUrl: !isProd && lastLocalPort ? siteLoopbackOrigin(lastLocalPort) : undefined,
  });
  const origin = resolveCrawlOrigin(cfg.baseUrl, () => undefined);
  origin.catch(() => originCache.delete(key));
  return remember(originCache, key, { at: Date.now(), origin }).origin;
}

async function renderThroughApp(siteId: string, path: string): Promise<RenderedPage> {
  const origin = await renderOrigin(siteId);
  const url = `${origin}${path}`;
  const res = await exportFetch(url, {
    redirect: "manual",
    headers: { [STATIC_EXPORT_HEADER]: onDemandRenderHeaderValue(), "user-agent": "JustFlows-StaticExport/1" },
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    let target = location ?? "/";
    try {
      target = new URL(target, url).pathname;
    } catch {
      // keep the raw value
    }
    return {
      status: res.status,
      contentType: "",
      body: Buffer.alloc(0),
      redirectedTo: normalizeUrlPath(target),
      cacheControl: "",
      deps: [],
    };
  }
  return {
    status: res.status,
    contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
    body: Buffer.from(await res.arrayBuffer()),
    redirectedTo: null,
    cacheControl: res.headers.get("cache-control") ?? "",
    deps: parseExportDeps(res.headers.get(EXPORT_DEPS_HEADER)),
  };
}

function currentFiles(): OnDemandFiles {
  return onDemandFiles(() => getStaticExportConfig().outDir);
}

function liveEnv(): OnDemandEnv {
  const cfg = getStaticExportConfig();
  return {
    store: dbOnDemandStore,
    files: currentFiles(),
    limits: {
      ttlMs: cfg.ttlSeconds * 1000,
      renderCap: cfg.renderCap,
      siteRenderCap: cfg.siteRenderCap,
      maxPages: cfg.maxPages,
    },
    render: async (path) => {
      const siteId = await getSiteId();
      if (!siteId) throw new Error("no site");
      return renderThroughApp(siteId, path);
    },
    prepare: async (path, page) => {
      const siteId = (await getSiteId()) ?? "";
      const tools = await toolsFor(siteId, cfg);
      return { body: tools.pageBody(page), cacheControl: tools.cacheControlFor(path, page.contentType) };
    },
    enforceGrowth: async (siteId, bytes) => {
      await (await import("../storage/storage-quota.js")).enforceStorageGrowth(siteId, bytes);
    },
    now: () => Date.now(),
    log,
  };
}

/** One engine per process: it owns the single-flight map and the render caps. */
export const onDemandEngine: OnDemandEngine = createOnDemandEngine(liveEnv);

function isOnDemandMode(): boolean {
  const cfg = getStaticExportConfig();
  return cfg.enabled && cfg.mode === "on-demand";
}

async function isDynamicSurface(path: string): Promise<boolean> {
  const admin = (await getAdminPathConfig()).path;
  return [admin, "/admin", ...CORE_DYNAMIC_PREFIXES.map((p) => `/${p}`)].some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

/** Stream a stored file. False when it is gone from storage. */
async function sendStored(
  req: Request,
  res: Response,
  page: OnDemandPage,
  state: string,
): Promise<boolean> {
  const conditional: Record<string, string> = {};
  const etag = req.get("if-none-match");
  if (etag) conditional["if-none-match"] = etag;
  const opened = await currentFiles().open(page.siteId, page.file, conditional);
  if (!opened) return false;
  res.status(opened.status);
  if (opened.etag) res.setHeader("ETag", opened.etag);
  if (opened.lastModified) res.setHeader("Last-Modified", opened.lastModified);
  res.setHeader("X-Justflows-Render", "static-export");
  res.setHeader("X-Justflows-Export", state);
  res.setHeader("Content-Type", page.contentType);
  res.setHeader("Cache-Control", page.cacheControl);
  if (req.method === "HEAD" || opened.status === 304 || !opened.body) {
    opened.body?.destroy();
    res.end();
    return true;
  }
  opened.body.on("error", (err) => res.destroy(err));
  opened.body.pipe(res);
  return true;
}

/**
 * Serve a page from the on-demand export. Fresh files are served as they are.
 * A stale or expired file is served once more while a fresh copy renders in
 * the background. A page without a file renders now (sharing any render
 * already running for it) and is served from the new file; over the render
 * caps the live app answers instead.
 */
export async function serveOnDemandStaticExport(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    !["GET", "HEAD"].includes(req.method) ||
    isAccountPath(req.path) ||
    res.locals.jfBypassStatic ||
    req.get(STATIC_EXPORT_HEADER) ||
    req.originalUrl.includes("?") ||
    getSession(req) ||
    !isOnDemandMode()
  ) {
    next();
    return;
  }
  try {
    const path = normalizeUrlPath(req.path);
    if (path !== req.path || path === NOT_FOUND_PROBE || !isCrawlablePath(path) || (await isDynamicSurface(path))) {
      next();
      return;
    }
    if (!(await isCurrentSiteStaticExportEnabled()) || (await isSiteClosed())) {
      next();
      return;
    }
    const siteId = await getSiteId();
    if (!siteId) {
      next();
      return;
    }
    noteListenerPort(req.socket.localPort);
    lastLocalPort = req.socket.localPort ?? lastLocalPort;
    const cfg = getStaticExportConfig();
    if ((await toolsFor(siteId, cfg)).excluded(path)) {
      next();
      return;
    }

    const [stored, version] = await Promise.all([
      dbOnDemandStore.get(siteId, path),
      dbOnDemandStore.getVersion(siteId),
    ]);
    const state = freshness(stored, version, Date.now(), cfg.ttlSeconds * 1000);
    let page = stored;
    if (state === "stale") onDemandEngine.refresh(siteId, path);
    if (state === "missing") {
      const run = onDemandEngine.render(siteId, path);
      const outcome = run ? await run : null;
      if (outcome?.kind !== "stored") {
        next();
        return;
      }
      page = outcome.page;
    }
    if (!page) {
      next();
      return;
    }
    if (await sendStored(req, res, page, state === "missing" ? "new" : state)) return;
    /** The file vanished from storage. Drop the row unless a refresh already replaced it. */
    const current = await dbOnDemandStore.get(siteId, path);
    if (current?.file === page.file) await onDemandEngine.forget(siteId, current);
    next();
  } catch {
    // A database or storage outage falls back to the live renderer.
    if (!res.headersSent) next();
    else res.destroy();
  }
}

/** An entry's translation group and whether it is live now. */
async function entryState(
  siteId: string,
  contentId: string,
): Promise<{ group: string | null; published: boolean }> {
  const { getDb } = await import("../database/db.js");
  const rows = await (await getDb()).query<{ translation_group_id: unknown; status: unknown }>(
    "SELECT translation_group_id, status FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [contentId, siteId],
  );
  const group = rows[0]?.translation_group_id;
  return {
    group: typeof group === "string" && group ? group : null,
    published: rows[0]?.status === "published",
  };
}

/**
 * React to an entry being published, updated, unpublished or deleted. Nothing
 * renders: pages are marked stale, and a removed entry's own files are deleted
 * now so its URL answers 404 straight away.
 */
export async function noteOnDemandContentChange(
  kind: "published" | "updated" | "unpublished" | "deleted",
  ref: { contentId?: string; translationGroupId?: string; siteId?: string },
): Promise<void> {
  if (!isOnDemandMode() || !ref.contentId) return;
  const siteId = ref.siteId ?? (await getSiteId());
  if (!siteId) return;
  const state = await entryState(siteId, ref.contentId);
  const deps = [`c:${ref.contentId}`];
  const group = ref.translationGroupId ?? state.group;
  if (group) deps.push(`g:${group}`);
  /**
   * `content.updated` covers direct edits of a live entry (API, MCP, a status
   * change) and draft saves. A live entry is treated as published. A draft
   * that never had a file is a no-op, so saving drafts does not touch lists.
   */
  const live = kind === "published" || (kind === "updated" && state.published);
  if (live) {
    await onDemandEngine.contentChanged(siteId, deps);
    return;
  }
  const removed = await onDemandEngine.contentRemoved(siteId, deps, {
    lists: kind === "updated" ? "if-removed" : "always",
  });
  if (removed > 0) {
    const { purgeCdnCache } = await import("../cdn/cdn-purge.js");
    await purgeCdnCache({ siteId }).catch(() => undefined);
  }
}

/**
 * Content changed without ids (plugin-owned pages, imports, restores): mark
 * every list page stale. Entry pages follow their own hooks or the expiry.
 */
export async function noteOnDemandListsChange(siteId?: string): Promise<void> {
  if (!isOnDemandMode()) return;
  const id = siteId ?? (await getSiteId());
  if (id) await onDemandEngine.listsChanged(id);
}

/**
 * Comments were added, approved, edited or removed: mark only the pages of
 * the entries they belong to as stale. Lists do not show comments.
 */
export async function noteOnDemandCommentChange(
  ref: { commentIds?: string[]; contentIds?: string[]; siteId?: string },
): Promise<void> {
  if (!isOnDemandMode()) return;
  const siteId = ref.siteId ?? (await getSiteId());
  if (!siteId) return;
  const contentIds = new Set(ref.contentIds ?? []);
  const commentIds = [...new Set(ref.commentIds ?? [])];
  if (commentIds.length > 0) {
    const { getDb } = await import("../database/db.js");
    const db = await getDb();
    for (let i = 0; i < commentIds.length; i += 200) {
      const batch = commentIds.slice(i, i + 200);
      const rows = await db.query<{ content_id: unknown }>(
        `SELECT DISTINCT content_id FROM comments WHERE site_id = ? AND id IN (${batch.map(() => "?").join(", ")})`,
        [siteId, ...batch],
      );
      for (const row of rows) if (typeof row.content_id === "string") contentIds.add(row.content_id);
    }
  }
  await onDemandEngine.pagesChanged(siteId, [...contentIds].map((id) => `c:${id}`));
}

/**
 * A menu, theme, Customizer, CSS provider, settings or plugin change: bump the
 * site's export version so every file is stale. Called from cache revalidation
 * whether or not revalidation is turned on.
 */
export async function noteOnDemandSiteChange(siteId?: string): Promise<void> {
  if (!isOnDemandMode()) return;
  const id = siteId ?? (await getSiteId());
  if (!id) return;
  toolsCache.delete(siteKey(id));
  await onDemandEngine.siteChanged(id);
}

/** Counts for Tools → Static export. */
export async function onDemandStatus(): Promise<(OnDemandStats & { rendering: number }) | null> {
  const siteId = await getSiteId();
  if (!siteId) return null;
  const cfg = getStaticExportConfig();
  const version = await dbOnDemandStore.getVersion(siteId);
  const stats = await dbOnDemandStore.stats(siteId, version, Date.now() - cfg.ttlSeconds * 1000);
  return { ...stats, rendering: onDemandEngine.running(siteId) };
}

/**
 * Refresh every page of the current site: bump its export version and purge
 * its CDN. Nothing renders now; each page is rebuilt on its next visit. Any
 * site's administrator may ask for this; it never touches another site.
 */
export async function refreshOnDemandExport(): Promise<boolean> {
  if (!isOnDemandMode()) return false;
  const siteId = await getSiteId();
  if (!siteId) return false;
  await noteOnDemandSiteChange(siteId);
  const { purgeCdnCache } = await import("../cdn/cdn-purge.js");
  await purgeCdnCache({ siteId }).catch(() => undefined);
  return true;
}

/** Remove every on-demand file and row of the current site. */
export async function clearOnDemandExport(): Promise<boolean> {
  const siteId = await getSiteId();
  if (!siteId) return false;
  const pages = await dbOnDemandStore.stats(siteId, 0, 0);
  await currentFiles().clear(siteId);
  await dbOnDemandStore.clear(siteId);
  return pages.pages > 0;
}
