// SPDX-License-Identifier: MIT

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { STATIC_EXPORT_HEADER } from "./config.js";

/**
 * Response header the public renderer sets on an on-demand export render. It
 * lists what the page shows (`c:<content id>`, `g:<translation group id>`), so
 * a later publish or unpublish can mark the file stale.
 */
export const EXPORT_DEPS_HEADER = "x-justflows-export-deps";

const PREFIX = "on-demand.";

let processToken: string | null = null;

/**
 * Secret the on-demand renderer sends in `x-jf-static-export`. Only a request
 * carrying it skips the page cache and gets the deps header, so a visitor who
 * sends the header cannot use it to bypass the page cache.
 *
 * It is derived from `APP_SECRET`, so every app process accepts a render
 * request from any other process. Without `APP_SECRET` it is random per process.
 */
export function onDemandRenderToken(): string {
  const secret = process.env.APP_SECRET;
  if (secret && secret.length >= 32) {
    return createHmac("sha256", secret).update("justflows-static-export-render").digest("hex");
  }
  processToken ??= randomBytes(32).toString("hex");
  return processToken;
}

/** Header value for an on-demand render request. */
export function onDemandRenderHeaderValue(): string {
  return `${PREFIX}${onDemandRenderToken()}`;
}

/** True when `req` is an on-demand export render from this installation. */
export function isOnDemandRenderRequest(req: { get(name: string): string | undefined }): boolean {
  const value = req.get(STATIC_EXPORT_HEADER);
  if (!value || !value.startsWith(PREFIX)) return false;
  const given = Buffer.from(value.slice(PREFIX.length));
  const expected = Buffer.from(onDemandRenderToken());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const DEP_RE = /^[cg]:[A-Za-z0-9_-]{1,64}$/;

/** The deps header value for a rendered entry. */
export function exportDepsFor(content: { id: string; translationGroupId?: string | null }): string {
  const deps = [`c:${content.id}`];
  if (content.translationGroupId) deps.push(`g:${content.translationGroupId}`);
  return deps.filter((dep) => DEP_RE.test(dep)).join(",");
}

/** Parse the deps header. Invalid entries are dropped. */
export function parseExportDeps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(",").slice(0, 20)) {
    const dep = part.trim();
    if (DEP_RE.test(dep)) out.add(dep);
  }
  return [...out];
}
