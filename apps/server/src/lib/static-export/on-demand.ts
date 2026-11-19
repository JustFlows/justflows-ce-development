// SPDX-License-Identifier: MIT

import type { OnDemandFiles } from "./on-demand-files.js";
import { onDemandFileKey } from "./on-demand-files.js";
import { pathHash, type OnDemandPage, type OnDemandStore } from "./on-demand-store.js";
import { sha256 } from "./manifest.js";

/**
 * On-demand static export (justflows-ce#344).
 *
 * A page's file is built the first time someone visits it. Changes do not
 * rebuild anything: they mark files stale, and the next visit gets the old
 * file while a fresh copy renders in the background. This module holds that
 * logic without Express or the database, so it can be tested on its own;
 * `serve-on-demand.ts` wires it to the app.
 */

/** What the app answered when the exporter rendered one page. */
export interface RenderedPage {
  status: number;
  contentType: string;
  body: Buffer;
  /** Redirect target when the app answered 3xx. */
  redirectedTo: string | null;
  /** The app's own `Cache-Control` for the page. */
  cacheControl: string;
  /** What the page shows (`c:<id>`, `g:<group>`), from the deps header. */
  deps: string[];
}

export interface OnDemandLimits {
  /** Files expire this long after their render started. */
  ttlMs: number;
  /** Renders this process runs at once, across all sites. */
  renderCap: number;
  /** Renders this process runs at once for one site. */
  siteRenderCap: number;
}

export interface OnDemandEnv {
  store: OnDemandStore;
  files: OnDemandFiles;
  limits: OnDemandLimits;
  /** Render one path through the app. */
  render(path: string): Promise<RenderedPage>;
  /** The bytes and `Cache-Control` to store for a rendered page. */
  prepare(path: string, page: RenderedPage): Promise<{ body: Buffer; cacheControl: string }>;
  /** Throw when the site may not grow by `bytes`. */
  enforceGrowth(siteId: string, bytes: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export type Freshness = "fresh" | "stale" | "missing";

export type RenderOutcome =
  | { kind: "stored"; page: OnDemandPage }
  /** The app answered 404 or 410: the file was removed. */
  | { kind: "gone" }
  /** A redirect or a private page: not stored, and any old file was removed. */
  | { kind: "uncacheable" }
  /** A server error or a refused write: the old file, if any, stays. */
  | { kind: "failed"; reason: string }
  /** Another process is already refreshing this page. */
  | { kind: "skipped" };

/** How long a cross-process refresh claim holds. A crashed process frees it after this. */
const CLAIM_MS = 60_000;

/**
 * Decide whether a stored file can be served as it is.
 * A mark at the same millisecond as the render start counts as later, because
 * the render may have read the content just before the change.
 */
export function freshness(
  page: OnDemandPage | null,
  version: number,
  now: number,
  ttlMs: number,
): Freshness {
  if (!page) return "missing";
  if (page.exportVersion !== version) return "stale";
  if (page.markedAt >= page.renderedAt) return "stale";
  if (now - page.renderedAt >= ttlMs) return "stale";
  return "fresh";
}

/** A page shows a list (home, archives, feeds, sitemap) when it is not a single entry. */
export function isListPage(path: string, page: RenderedPage): boolean {
  if (page.deps.length === 0) return true;
  if (path === "/" || /^\/[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(path)) return true;
  if (!page.contentType.includes("text/html")) return false;
  /** A single page with a paginated block (a posts list) changes with every publish. */
  return /\/page\/\d+["/\s]/.test(page.body.toString("utf8"));
}

/** A response that must not become a shared file. */
function isPrivate(cacheControl: string): boolean {
  return /\b(private|no-store)\b/i.test(cacheControl);
}

export interface OnDemandEngine {
  /**
   * Render `path` now, sharing an in-flight render of the same page.
   * Returns null when the render caps are full, so the caller can fall back to
   * the live app. With `claim`, another process refreshing the page wins.
   */
  render(siteId: string, path: string, opts?: { claim?: boolean }): Promise<RenderOutcome> | null;
  /** Start a background refresh of a stale page. Over the caps it does nothing. */
  refresh(siteId: string, path: string): void;
  /** Publish or update: mark the pages that show these deps, and every list page, stale. */
  contentChanged(siteId: string, deps: string[]): Promise<void>;
  /** Unpublish or delete: remove the entry's own files now, then mark the rest stale. */
  contentRemoved(siteId: string, deps: string[]): Promise<number>;
  /** Menu, theme, Customizer, CSS provider or settings change: every file is stale. */
  siteChanged(siteId: string): Promise<void>;
  /** Remove one page's file and row. */
  forget(siteId: string, page: OnDemandPage): Promise<void>;
  /** Renders running in this process. */
  running(siteId?: string): number;
}

export function createOnDemandEngine(env: () => OnDemandEnv): OnDemandEngine {
  const inflight = new Map<string, Promise<RenderOutcome>>();
  const perSite = new Map<string, number>();
  let total = 0;

  const acquire = (siteId: string, limits: OnDemandLimits): boolean => {
    const site = perSite.get(siteId) ?? 0;
    if (total >= limits.renderCap || site >= limits.siteRenderCap) return false;
    total++;
    perSite.set(siteId, site + 1);
    return true;
  };
  const releaseSlot = (siteId: string): void => {
    total--;
    const site = (perSite.get(siteId) ?? 1) - 1;
    if (site <= 0) perSite.delete(siteId);
    else perSite.set(siteId, site);
  };

  async function forget(siteId: string, page: OnDemandPage): Promise<void> {
    const e = env();
    await e.store.remove(siteId, page.path);
    await e.files.remove(siteId, page.file).catch(() => undefined);
  }

  async function renderNow(siteId: string, path: string, claim: boolean): Promise<RenderOutcome> {
    const e = env();
    const startedAt = e.now();
    if (claim && !(await e.store.claim(siteId, path, startedAt, CLAIM_MS))) return { kind: "skipped" };
    let claimed = claim;
    try {
      /** Read the version before rendering, so a change during the render leaves the file stale. */
      const version = await e.store.getVersion(siteId);
      const previous = await e.store.get(siteId, path);
      const rendered = await e.render(path);

      const dropPrevious = async () => {
        if (previous) await forget(siteId, previous);
        claimed = false;
      };
      if (rendered.status === 404 || rendered.status === 410) {
        await dropPrevious();
        return { kind: "gone" };
      }
      if (rendered.redirectedTo || isPrivate(rendered.cacheControl)) {
        await dropPrevious();
        return { kind: "uncacheable" };
      }
      if (rendered.status !== 200) return { kind: "failed", reason: `the app answered ${rendered.status}` };

      const { body, cacheControl } = await e.prepare(path, rendered);
      const hash = sha256(body);
      const file = onDemandFileKey(pathHash(path), hash, rendered.contentType);
      if (previous?.file !== file) {
        await e.enforceGrowth(siteId, Math.max(0, body.length - (previous?.bytes ?? 0)));
        await e.files.save(siteId, file, body, rendered.contentType, cacheControl);
      }
      const page: OnDemandPage = {
        siteId,
        path,
        file,
        sha256: hash,
        contentType: rendered.contentType,
        cacheControl,
        bytes: body.length,
        exportVersion: version,
        renderedAt: startedAt,
        markedAt: previous?.markedAt ?? 0,
        dynamicList: isListPage(path, rendered),
      };
      await e.store.put(page, rendered.deps);
      claimed = false;
      /** The old version is no longer addressable; readers already streaming it keep their handle. */
      if (previous && previous.file !== file) await e.files.remove(siteId, previous.file).catch(() => undefined);
      return { kind: "stored", page };
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      if (claimed) await e.store.release(siteId, path).catch(() => undefined);
    }
  }

  function render(siteId: string, path: string, opts: { claim?: boolean } = {}): Promise<RenderOutcome> | null {
    const key = `${siteId}\n${path}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    if (!acquire(siteId, env().limits)) return null;
    const run = renderNow(siteId, path, opts.claim === true).finally(() => {
      releaseSlot(siteId);
      inflight.delete(key);
    });
    inflight.set(key, run);
    return run;
  }

  return {
    render,

    refresh(siteId, path) {
      const run = render(siteId, path, { claim: true });
      void run?.then((outcome) => {
        if (outcome.kind === "failed") env().log(`refresh of ${path} failed: ${outcome.reason}`);
      });
    },

    async contentChanged(siteId, deps) {
      const e = env();
      await e.store.markStale(siteId, deps, e.now());
    },

    async contentRemoved(siteId, deps) {
      const e = env();
      const own = await e.store.pagesShowing(
        siteId,
        deps.filter((dep) => dep.startsWith("c:")),
      );
      for (const page of own) await forget(siteId, page);
      await e.store.markStale(siteId, deps, e.now());
      return own.length;
    },

    async siteChanged(siteId) {
      const e = env();
      const current = await e.store.getVersion(siteId);
      /** Strictly increasing, even when two changes land in the same millisecond. */
      await e.store.bumpVersion(siteId, Math.max(e.now(), current + 1));
    },

    forget,

    running(siteId) {
      return siteId === undefined ? total : (perSite.get(siteId) ?? 0);
    },
  };
}
