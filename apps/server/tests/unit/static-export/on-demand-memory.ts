// SPDX-License-Identifier: MIT
import { Readable } from "node:stream";
import type { OnDemandFiles } from "../../../src/lib/static-export/on-demand-files.js";
import type { OnDemandPage, OnDemandStore } from "../../../src/lib/static-export/on-demand-store.js";

/** In-memory twin of the database store, with the same contract. */
export function memoryStore() {
  const pages = new Map<string, OnDemandPage>();
  const deps = new Map<string, string[]>();
  const claims = new Map<string, number>();
  const versions = new Map<string, number>();
  const key = (siteId: string, path: string) => `${siteId}\n${path}`;
  const store: OnDemandStore = {
    async get(siteId, path) {
      const page = pages.get(key(siteId, path));
      return page ? { ...page } : null;
    },
    async put(page, pageDeps) {
      const k = key(page.siteId, page.path);
      /** Like the SQL upsert: `marked_at` is kept. */
      const markedAt = pages.get(k)?.markedAt ?? 0;
      pages.set(k, { ...page, markedAt });
      deps.set(k, [...pageDeps]);
      claims.delete(k);
    },
    async remove(siteId, path) {
      pages.delete(key(siteId, path));
      deps.delete(key(siteId, path));
    },
    async claim(siteId, path, now, ms) {
      const k = key(siteId, path);
      if (!pages.has(k)) return true;
      if ((claims.get(k) ?? 0) >= now) return false;
      claims.set(k, now + ms);
      return true;
    },
    async release(siteId, path) {
      claims.delete(key(siteId, path));
    },
    async markStale(siteId, changed, at, lists = true) {
      for (const [k, page] of pages) {
        if (page.siteId !== siteId) continue;
        if ((lists && page.dynamicList) || (deps.get(k) ?? []).some((dep) => changed.includes(dep))) {
          page.markedAt = at;
        }
      }
    },
    async pagesShowing(siteId, wanted) {
      return [...pages.entries()]
        .filter(([k, page]) => page.siteId === siteId && !page.dynamicList && (deps.get(k) ?? []).some((d) => wanted.includes(d)))
        .map(([, page]) => ({ ...page }));
    },
    async count(siteId) {
      return [...pages.values()].filter((page) => page.siteId === siteId).length;
    },
    async getVersion(siteId) {
      return versions.get(siteId) ?? 0;
    },
    async bumpVersion(siteId, version) {
      versions.set(siteId, version);
    },
    async all(siteId) {
      return [...pages.values()].filter((page) => page.siteId === siteId);
    },
    async stats() {
      return { pages: pages.size, stale: 0, bytes: 0 };
    },
    async clear(siteId) {
      for (const [k, page] of pages) if (page.siteId === siteId) pages.delete(k);
    },
  };
  return { store, pages, versions };
}

export function memoryFiles() {
  const files = new Map<string, Buffer>();
  const api: OnDemandFiles = {
    async save(_siteId, file, body) {
      files.set(file, body);
    },
    async open(_siteId, file) {
      const body = files.get(file);
      return body ? { status: 200, body: Readable.from([body]) } : null;
    },
    async remove(_siteId, file) {
      files.delete(file);
    },
    async clear() {
      files.clear();
    },
  };
  return { api, files };
}

