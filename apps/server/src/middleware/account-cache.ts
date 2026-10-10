// SPDX-License-Identifier: MIT

import { withoutSharedCache } from "../lib/cache/jf-cache.js";
import type { NextFunction, Request, Response } from "express";

/** Includes legacy URLs and the account namespace of every plugin. */
export function isAccountPath(pathname: string): boolean {
  let path: string;
  try { path = decodeURIComponent(pathname.split(/[?#]/, 1)[0] ?? ""); } catch { return false; }
  return /^\/(?:account|platform-account|api\/(?:account|platform-account))(?:\/|$)/i.test(path)
    || /^\/api\/[^/]+\/account(?:\/|$)/i.test(path)
    || /^\/ext\/[^/]+\/account(?:\/|$)/i.test(path);
}

/** Apply before caching and authentication so redirects and failures are private too. */
export function accountCacheMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isAccountPath(req.path)) {
    privateAccountResponse(res);
    withoutSharedCache(() => next());
    return;
  }
  next();
}

export function privateAccountResponse(res: Response): void {
    res.set({ "Cache-Control": "private, no-store", "CDN-Cache-Control": "no-store",
      "Surrogate-Control": "no-store", "Pragma": "no-cache", "Expires": "0", "X-Robots-Tag": "noindex, nofollow" });
    res.vary("Cookie"); res.vary("Authorization");
}
