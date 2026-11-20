import type { NextFunction, Request, Response } from "express";

/**
 * Answers a request under `/api` or `/ext` that matched no route with a JSON
 * 404, instead of letting it fall through to the public site's HTML 404
 * (callers doing `res.json()` would fail on "<!DOCTYPE"). `/ext` is the plugin
 * HTTP surface, so this is typically a plugin that is not active.
 *
 * The answer is never cached, by the browser or a CDN: a plugin is missing
 * only for a moment while it is updated or reinstalled, and a cached 404 for
 * its scripts would keep breaking pages long after it is back.
 */
export function apiNotFound(req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next();
    return;
  }
  if (req.path === "/api" || req.path.startsWith("/api/") || req.path.startsWith("/ext/")) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("CDN-Cache-Control", "no-store");
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}
