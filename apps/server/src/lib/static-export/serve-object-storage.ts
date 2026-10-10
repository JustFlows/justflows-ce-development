// SPDX-License-Identifier: MIT

import { isAccountPath } from "../../middleware/account-cache.js";
import { Readable } from "node:stream";
import type { Request, Response, NextFunction } from "express";
import { getSession } from "../auth/session.js";
import { getAdminPathConfig } from "../admin/admin-path.js";
import { getStaticExportConfig, STATIC_EXPORT_HEADER } from "./config.js";
import { CORE_DYNAMIC_PREFIXES } from "./exclusions.js";
import { isCurrentSiteStaticExportEnabled } from "./site-enabled.js";
import {
  staticExportDriver,
  staticExportObjectStore,
  readDeployedEntries,
  deployedObjectKey,
} from "./object-storage.js";

/** The private bucket stays private; Bunny uses the existing app origin.
 * Only exported public routes are eligible. Crawlers always read the live app.
 */
export async function serveStaticExportFromObjectStorage(
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
    staticExportDriver() !== "s3" ||
    !getStaticExportConfig().enabled
  ) {
    next();
    return;
  }
  try {
    const admin = (await getAdminPathConfig()).path;
    const pathname = req.path.replace(/\/$/, "") || "/";
    if (
      [admin, "/admin", ...CORE_DYNAMIC_PREFIXES.map((p) => `/${p}`)].some(
        (p) => pathname === p || pathname.startsWith(`${p}/`),
      ) ||
      !(await isCurrentSiteStaticExportEnabled())
    ) {
      next();
      return;
    }
    const { adapter, prefix } = staticExportObjectStore();
    const entries = await readDeployedEntries(adapter, prefix);
    const entry = entries?.find((row) => row.path === pathname);
    if (!entry) {
      next();
      return;
    }
    const passthrough: Record<string, string> = {};
    for (const name of ["if-none-match", "if-modified-since", "range", "if-range"]) {
      const value = req.get(name);
      if (value) passthrough[name] = value;
    }
    const upstream = await adapter.open(deployedObjectKey(prefix, entry), passthrough);
    if (![200, 206, 304, 416].includes(upstream.status)) {
      await upstream.body?.cancel();
      next();
      return;
    }
    res.status(upstream.status);
    for (const name of ["etag", "last-modified", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("X-Justflows-Render", "static-export");
    res.setHeader("Content-Type", entry.contentType);
    res.setHeader("Cache-Control", entry.cacheControl);
    if (req.method === "HEAD" || !upstream.body || upstream.status === 304) {
      await upstream.body?.cancel();
      res.end();
      return;
    }
    const stream = Readable.fromWeb(
      upstream.body as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    stream.on("error", (err) => res.destroy(err));
    stream.pipe(res);
  } catch {
    // A storage outage falls back to the live renderer; no bucket paths/errors
    // are exposed to visitors.
    if (!res.headersSent) next();
    else res.destroy();
  }
}
