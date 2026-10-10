// SPDX-License-Identifier: MIT
import type { Request, Response, NextFunction } from "express";
import { contentCacheRules, matchContentCacheRule } from "../lib/cache/content-type-cache.js";
import { getSiteId } from "../lib/settings/site-settings.js";
import { withoutSharedCache } from "../lib/cache/jf-cache.js";
import { getSession } from "../lib/auth/session.js";
import { getAdminPathConfig } from "../lib/admin/admin-path.js";

/** Runs before local files and exported objects, including old deployed snapshots. */
export async function contentTypeCacheMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!["GET", "HEAD"].includes(req.method) || /^\/(api|ext|uploads|assets|css|js|css-providers|install|login|admin)(\/|$)/.test(req.path)) { next(); return; }
  try {
    const admin = (await getAdminPathConfig()).path;
    if (req.path === admin || req.path.startsWith(`${admin}/`)) { next(); return; }
    const siteId = await getSiteId();
    const rule = siteId ? matchContentCacheRule(await contentCacheRules(siteId), req.path,
      typeof req.query.p === "string" ? req.query.p : undefined) : undefined;
    const privateRequest = Boolean(getSession(req)) || req.query.preview !== undefined;
    if (!rule && !privateRequest) { next(); return; }
    const header = privateRequest ? "private, no-store" : rule!.header;
    const shared = !privateRequest && rule!.shared;
    res.locals.jfContentCacheControl = header;
    res.locals.jfContentCacheTtl = shared ? rule!.ttl : 0;
    // Render overrides live: files deployed before a policy change cannot win.
    res.locals.jfBypassStatic = true;
    res.setHeader("Cache-Control", header);
    res.setHeader("CDN-Cache-Control", shared ? header : "no-store");
    res.setHeader("Surrogate-Control", shared ? header : "no-store");
    if (!shared) {
      res.locals.jfContentCacheBypass = true;
      res.vary("Cookie"); res.vary("Authorization");
      withoutSharedCache(() => next());
    } else next();
  } catch (error) { next(error); }
}
