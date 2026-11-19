// SPDX-License-Identifier: MIT

import type { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { isOnDemandRenderRequest } from "../lib/static-export/render-request.js";

const REQUEST_PROPERTY = "publicPageRateLimit";

/**
 * One 600/minute budget for managed redirects, static export, and public pages.
 *
 * Each of those chains mounts this same middleware so a filesystem route stays
 * rate-limited on its own chain. The first mount counts the request and writes
 * the `public` policy. Later mounts see that and move on, so the header is not
 * repeated and the request is not counted again.
 */
export const publicPageRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  identifier: "public",
  requestPropertyName: REQUEST_PROPERTY,
  skip(req: Request) {
    const info = (req as Request & Record<string, unknown>)[REQUEST_PROPERTY];
    /**
     * An on-demand export render comes from the app itself over loopback. It is
     * already limited by the render caps and must not use up loopback's budget.
     */
    return info != null || isOnDemandRenderRequest(req);
  },
  handler(req: Request, res: Response, next: NextFunction) {
    void import("../routes/public/public-site.js")
      .then(({ sendPublicRateLimited }) => sendPublicRateLimited(req, res))
      .catch(next);
  },
});
