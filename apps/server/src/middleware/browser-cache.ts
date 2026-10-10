import { accountCacheMiddleware, isAccountPath } from "./account-cache.js";
import type { NextFunction, Request, Response } from "express";
import { getPerformanceConfig } from "../lib/cache/performance-settings.js";

const NO_BROWSER_CACHE = /^\/(admin|api|install|login)(\/|$)/;

const STATIC_PATHS = /^\/(uploads|assets|css-providers|public)(\/|$)/;

function cacheControlForPath(pathname: string): string | null {
  const config = getPerformanceConfig().browserCache;
  if (!config.enabled) return null;

  if (NO_BROWSER_CACHE.test(pathname)) {
    return "no-store";
  }

  if (pathname === "/theme.css") {
    return `public, max-age=${config.htmlMaxAge}, stale-while-revalidate=${config.staleWhileRevalidate}`;
  }

  if (STATIC_PATHS.test(pathname)) {
    return `public, max-age=${config.staticMaxAge}, immutable`;
  }

  if (pathname === "/robots.txt") {
    return `public, max-age=${config.htmlMaxAge}`;
  }

  // Public HTML pages (everything else that isn't an API path)
  if (!pathname.includes(".")) {
    return `public, max-age=${config.htmlMaxAge}, stale-while-revalidate=${config.staleWhileRevalidate}`;
  }

  return null;
}

/**
 * Public HTML with no browser-cache setting was left without a cache header.
 * The CDN then kept that page for its own default (30 days), so a new favicon
 * stayed on the admin tab and never reached the public site.
 */
function edgeCacheForUncachedHtml(pathname: string): boolean {
  if (getPerformanceConfig().browserCache.enabled) return false;
  if (STATIC_PATHS.test(pathname) || pathname === "/theme.css") return false;
  return !pathname.includes(".") || pathname === "/favicon.ico";
}

/** Set Cache-Control early — must not patch res.end (breaks GZIP compression). */
export function browserCacheMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isAccountPath(req.path)) { accountCacheMiddleware(req, res, next); return; }
  if (req.method === "GET") {
    const value = cacheControlForPath(req.path);
    if (value) {
      res.setHeader("Cache-Control", value);
    } else if (edgeCacheForUncachedHtml(req.path)) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("CDN-Cache-Control", "no-store");
    }
  }
  next();
}

export function staticMaxAgeMs(): number {
  const seconds = getPerformanceConfig().browserCache.staticMaxAge;
  return getPerformanceConfig().browserCache.enabled ? seconds * 1000 : 0;
}
