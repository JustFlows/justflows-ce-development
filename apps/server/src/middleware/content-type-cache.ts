// SPDX-License-Identifier: MIT
import type { Request, Response, NextFunction } from "express";
import { contentCacheRuleForRequest } from "../lib/cache/content-type-cache.js";
import { getSiteId } from "../lib/settings/site-settings.js";
import { withoutSharedCache } from "../lib/cache/jf-cache.js";
import { getSession } from "../lib/auth/session.js";
import { getAdminPathConfig } from "../lib/admin/admin-path.js";

/** A request for a file (`/vendor/katex/katex.min.css`, `/placeholders/featured.svg`), not a page. */
const STATIC_FILE = /\.(?!html?$)[a-z0-9]{1,12}$/i;

/** Runs before local files and exported objects, including old deployed snapshots. */
export async function contentTypeCacheMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!["GET", "HEAD"].includes(req.method) || /^\/(api|ext|uploads|assets|css|js|css-providers|install|login|admin)(\/|$)/.test(req.path)) { next(); return; }
  // Only pages carry a content cache policy. A file must keep reaching the
  // static handler for signed-in visitors too, or they get the HTML 404 page.
  if (STATIC_FILE.test(req.path)) { next(); return; }
  try {
    const admin = (await getAdminPathConfig()).path;
    if (req.path === admin || req.path.startsWith(`${admin}/`)) { next(); return; }
    const siteId = await getSiteId();
    /** Only this request's candidates: building every page's rule here made each request scan the whole site. */
    const rule = siteId ? await contentCacheRuleForRequest(siteId, req.path,
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
