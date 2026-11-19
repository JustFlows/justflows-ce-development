// SPDX-License-Identifier: MIT

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { resolvePathUnderBase } from "../security/safe-path.js";
import { staticExportDriver, staticExportObjectStore } from "./object-storage.js";

/**
 * Folder inside the export directory that holds on-demand files. A full export
 * leaves it alone when it prunes, and Clear removes it with the rest.
 */
export const ON_DEMAND_DIR = "_on-demand";

/** A stored file, ready to stream. */
export interface OpenedFile {
  status: 200 | 304;
  body: Readable | null;
  etag?: string;
  lastModified?: string;
}

/**
 * Where on-demand files live. The local driver writes under the export
 * directory; S3 writes under the site's export prefix, which storage usage
 * already counts.
 */
export interface OnDemandFiles {
  save(siteId: string, file: string, body: Buffer, contentType: string, cacheControl: string): Promise<void>;
  /** Null when the file is gone. */
  open(siteId: string, file: string, conditional: Record<string, string>): Promise<OpenedFile | null>;
  remove(siteId: string, file: string): Promise<void>;
  /** Remove every on-demand file of the current site. */
  clear(siteId: string): Promise<void>;
}

const EXTENSIONS: Record<string, string> = {
  "text/html": ".html",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "application/rss+xml": ".xml",
  "application/atom+xml": ".xml",
  "application/json": ".json",
  "application/feed+json": ".json",
  "text/plain": ".txt",
};

/**
 * Storage key for a page: one folder per path, one file per content hash.
 * A new version gets a new name, so a reader streaming the old file is never
 * handed a half-written one.
 */
export function onDemandFileKey(pathHashHex: string, sha: string, contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return `${pathHashHex.slice(0, 2)}/${pathHashHex}/${sha}${EXTENSIONS[type] ?? ".bin"}`;
}

const KEY_RE = /^[a-f0-9]{2}\/[a-f0-9]{64}\/[a-f0-9]{64}\.[a-z]{3,4}$/;

function assertKey(file: string): void {
  if (!KEY_RE.test(file)) throw new Error("Unsafe on-demand export file");
}

/** Local driver: `<outDir>/_on-demand/<key>`. */
export function localOnDemandFiles(outDir: () => string): OnDemandFiles {
  /**
   * Resolve links in the export directory first (macOS `/var` is `/private/var`),
   * so the under-base check also works for files that do not exist yet.
   */
  const root = (): string => {
    const dir = outDir();
    try {
      return path.join(fs.realpathSync(dir), ON_DEMAND_DIR);
    } catch {
      return path.join(dir, ON_DEMAND_DIR);
    }
  };
  const resolve = (file: string): string => {
    assertKey(file);
    const abs = resolvePathUnderBase(root(), file);
    if (!abs) throw new Error("Unsafe on-demand export file");
    return abs;
  };
  return {
    async save(_siteId, file, body) {
      const abs = resolve(file);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, abs);
    },
    async open(_siteId, file, conditional) {
      const abs = resolve(file);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch {
        return null;
      }
      if (!stat.isFile()) return null;
      const etag = `"${path.basename(file).split(".")[0]}"`;
      const lastModified = stat.mtime.toUTCString();
      if (conditional["if-none-match"] === etag) return { status: 304, body: null, etag, lastModified };
      return { status: 200, body: fs.createReadStream(abs), etag, lastModified };
    },
    async remove(_siteId, file) {
      await fsp.rm(resolve(file), { force: true });
      /** Drop the path's folder once it is empty. */
      await fsp.rmdir(path.dirname(resolve(file))).catch(() => undefined);
    },
    async clear() {
      await fsp.rm(root(), { recursive: true, force: true });
    },
  };
}

/** S3 driver: `<site prefix>on-demand/<key>`, private; the app streams it. */
export function s3OnDemandFiles(): OnDemandFiles {
  const keyFor = (file: string) => {
    assertKey(file);
    const { adapter, prefix } = staticExportObjectStore();
    return { adapter, key: `${prefix}on-demand/${file}`, prefix: `${prefix}on-demand/` };
  };
  return {
    async save(_siteId, file, body, contentType, cacheControl) {
      const { adapter, key } = keyFor(file);
      await adapter.save(key, body, contentType, cacheControl);
    },
    async open(_siteId, file, conditional) {
      const { adapter, key } = keyFor(file);
      const upstream = await adapter.open(key, conditional);
      if (upstream.status !== 200 && upstream.status !== 304) {
        await upstream.body?.cancel();
        return null;
      }
      const etag = upstream.headers.get("etag") ?? undefined;
      const lastModified = upstream.headers.get("last-modified") ?? undefined;
      if (upstream.status === 304 || !upstream.body) {
        await upstream.body?.cancel();
        return { status: 304, body: null, etag, lastModified };
      }
      return {
        status: 200,
        body: Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>),
        etag,
        lastModified,
      };
    },
    async remove(_siteId, file) {
      const { adapter, key } = keyFor(file);
      await adapter.delete(key);
    },
    async clear() {
      const { adapter, prefix } = staticExportObjectStore();
      await adapter.deletePrefix(`${prefix}on-demand/`);
    },
  };
}

/** The files for the configured driver. */
export function onDemandFiles(outDir: () => string): OnDemandFiles {
  return staticExportDriver() === "s3" ? s3OnDemandFiles() : localOnDemandFiles(outDir);
}
