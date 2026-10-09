// SPDX-License-Identifier: MIT

import path from "node:path";
import { Readable } from "node:stream";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { encodeKeyPath } from "@justflows/media";
import { uploadsDir } from "../runtime/jf-root.js";
import { STATIC_EXPORT_HEADER } from "../static-export/config.js";
import {
  getUploadStore,
  isS3UploadStore,
  isSafeUploadKey,
  type S3UploadStore,
} from "./upload-store.js";
import { PRIVATE_UPLOADS_FOLDER } from "../files/private-storage.js";

/** Request headers forwarded to S3 so range and conditional requests work. */
const PASSTHROUGH = [
  "range",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
];
/** Response headers relayed from S3. */
const RELAY = [
  "content-type",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
  "accept-ranges",
];

/**
 * A PDF rendered inline runs in this origin's context, where its own scripting
 * and form actions apply. Uploads are user content, so hand them to the viewer
 * as a download instead.
 */
function forceDownload(res: Response, file: string): void {
  if (file.toLowerCase().endsWith(".pdf")) res.setHeader("Content-Disposition", "attachment");
}

async function serveFromS3(
  store: S3UploadStore,
  maxAgeMs: number,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let key: string;
  try {
    key = decodeURIComponent(req.path.replace(/^\/+/, ""));
  } catch {
    next();
    return;
  }
  // Dot segments (`.trash`, probes) are never public — same as express.static.
  if (!isSafeUploadKey(key) || key.endsWith("/") || key.split("/").some((s) => s.startsWith("."))) {
    next();
    return;
  }
  const cacheControl = `public, max-age=${Math.floor(maxAgeMs / 1000)}`;

  // A public bucket / CDN serves the bytes itself. The static exporter still
  // gets the file inline, so an export never contains a redirect for an asset.
  if (store.config.publicUrl && !req.get(STATIC_EXPORT_HEADER)) {
    res.setHeader("Cache-Control", cacheControl);
    res.redirect(302, `${store.config.publicUrl}/${encodeKeyPath(store.bucketKey(key))}`);
    return;
  }

  const passthrough: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = req.get(name);
    if (value) passthrough[name] = value;
  }
  const upstream = await store.open(key, passthrough);
  if (upstream.status === 404 || upstream.status === 403) {
    await upstream.body?.cancel().catch(() => undefined);
    next();
    return;
  }
  if (upstream.status >= 400) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new Error(`Upload storage answered ${upstream.status} for ${key}`);
  }

  res.status(upstream.status);
  for (const name of RELAY) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!upstream.headers.get("content-type"))
    res.type(path.extname(key) || "application/octet-stream");
  res.setHeader("Cache-Control", cacheControl);
  forceDownload(res, key);

  if (req.method === "HEAD" || !upstream.body || upstream.status === 304) {
    await upstream.body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  const body = Readable.fromWeb(
    upstream.body as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  body.on("error", (err) => res.destroy(err));
  body.pipe(res);
}

/**
 * `/uploads` handler for the configured driver. The local folder is served by
 * express.static; S3 is proxied (or redirected to its public URL). The driver
 * is checked per request, so it follows the environment without a restart.
 */
/** True for a request path inside the private-files folder of the uploads bucket. */
export function isPrivateUploadPath(requestPath: string): boolean {
  let decoded = requestPath;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return true;
  }
  const first = decoded.split(/[\\/]+/).filter(Boolean)[0] ?? "";
  return first.toLowerCase() === PRIVATE_UPLOADS_FOLDER || first.toLowerCase() === "static-export";
}

export function uploadsHandler(maxAgeMs: number): RequestHandler {
  const local = express.static(uploadsDir(), {
    maxAge: maxAgeMs,
    setHeaders: (res, filePath) => forceDownload(res, filePath),
  });
  return (req, res, next) => {
    // Private files and static-export metadata share the bucket, but cannot be read through /uploads.
    if (isPrivateUploadPath(req.path)) {
      res.status(404).end();
      return;
    }
    let store;
    try {
      store = getUploadStore();
    } catch (err) {
      next(err);
      return;
    }
    if (!isS3UploadStore(store)) {
      local(req, res, next);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    serveFromS3(store, maxAgeMs, req, res, next).catch(next);
  };
}
