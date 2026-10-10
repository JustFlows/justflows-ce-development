// SPDX-License-Identifier: MIT

import { isAccountPath } from "../../middleware/account-cache.js";
import { assetPathsFromHtml, originHost } from "./assets.js";
import { normalizeUrlPath } from "./paths.js";

export interface FetchedResource {
  path: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** Redirect target (normalized path) when the origin answered 3xx, else null. */
  redirectedTo: string | null;
}

export type Fetcher = (path: string) => Promise<FetchedResource>;

export interface CrawledPage {
  path: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** Same-origin sub-resources referenced by this page. */
  assetRefs: string[];
}

export interface CrawlOutcome {
  pages: CrawledPage[];
  /** Every 3xx we saw: from → to. The writer turns these into redirect stubs. */
  redirects: Array<{ from: string; to: string }>;
  errors: string[];
  hitLimit: boolean;
}

const RESERVED_PREFIXES = [
  "/admin",
  "/api",
  "/ext",
  "/login",
  "/account",
  "/platform-account",
  "/register",
  "/install",
  "/uploads",
  "/assets",
  "/css-providers",
  "/js",
];

/** Reserved exact paths (files, not namespaces) — only the literal path is blocked. */
const RESERVED_EXACT = new Set(["/theme.css"]);

function isCrawlablePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("?") || path.includes("#")) return false;
  if (RESERVED_EXACT.has(path)) return false;
  // Match a reserved namespace only on a segment boundary, so a real page at
  // `/extensions` or `/registration` is not mistaken for `/ext` / `/register`.
  return !RESERVED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Resolve an `<a href>` to a same-origin URL path, or null if it is external. */
export function linkToInternalPath(href: string, publicUrl: string): string | null {
  const value = href.trim();
  if (!value || value.startsWith("#")) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(value)) return null;
  if (value.startsWith("//")) return null;
  try {
    if (/^https?:\/\//i.test(value)) {
      if (!publicUrl) return null;
      const url = new URL(value);
      const base = new URL(publicUrl);
      if (url.host !== base.host) return null;
      return normalizeUrlPath(url.pathname);
    }
    if (value.startsWith("/")) return normalizeUrlPath(value);
    return null;
  } catch {
    return null;
  }
}

function internalLinksFromHtml(html: string, publicUrl: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = match[2] ?? match[3] ?? match[4] ?? "";
    const path = linkToInternalPath(href, publicUrl);
    if (path && isCrawlablePath(path)) out.add(path);
  }
  return [...out];
}

/**
 * Breadth-first crawl. Starts from `seeds`, and — when `discoverLinks` is set —
 * follows same-origin `<a href>` links so menu targets and `/slug/page/N`
 * pagination are picked up without the caller enumerating them.
 */
export async function crawlPages(
  seeds: string[],
  fetcher: Fetcher,
  opts: {
    maxPages: number;
    concurrency: number;
    publicUrl: string;
    discoverLinks: boolean;
    /** Paths left to the live app (`staticExport.exclude`): never fetched, even when linked. */
    exclude?: (path: string) => boolean;
  },
): Promise<CrawlOutcome> {
  const publicHost = originHost(opts.publicUrl);
  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (path: string) => {
    const norm = normalizeUrlPath(path);
    if (isAccountPath(norm) || seen.has(norm) || opts.exclude?.(norm)) return;
    seen.add(norm);
    queue.push(norm);
  };
  for (const seed of seeds) enqueue(seed);

  const pages: CrawledPage[] = [];
  const redirects: Array<{ from: string; to: string }> = [];
  const errors: string[] = [];
  let hitLimit = false;
  let cursor = 0;
  let inFlight = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function worker(): Promise<void> {
    for (;;) {
      if (cursor >= queue.length) {
        // Another worker may still be fetching a page that will add links.
        if (inFlight > 0) {
          await sleep(5);
          continue;
        }
        return;
      }
      if (pages.length >= opts.maxPages) {
        hitLimit = true;
        return;
      }
      const path = queue[cursor++]!;
      inFlight++;
      try {
        const res = await fetcher(path);

        if (res.redirectedTo) {
          redirects.push({ from: path, to: res.redirectedTo });
          if (opts.discoverLinks && isCrawlablePath(res.redirectedTo)) enqueue(res.redirectedTo);
          continue;
        }

        const isHtml = res.contentType.includes("text/html");
        const html = isHtml ? res.body.toString("utf8") : "";
        pages.push({
          path,
          status: res.status,
          contentType: res.contentType,
          body: res.body,
          assetRefs: isHtml ? assetPathsFromHtml(html, publicHost) : [],
        });

        if (opts.discoverLinks && isHtml && res.status < 400) {
          for (const link of internalLinksFromHtml(html, opts.publicUrl)) enqueue(link);
        }
      } catch (err) {
        errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inFlight--;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, () => worker());
  await Promise.all(workers);

  return { pages, redirects, errors, hitLimit };
}
