// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { getDb } from "../database/db.js";
import { getSiteSetting, setSiteSetting } from "../settings/site-settings.js";

/** One page file built on a visit (`static_export_pages`). Times are ms since the epoch. */
export interface OnDemandPage {
  siteId: string;
  path: string;
  /** Storage key relative to the site's on-demand root. */
  file: string;
  sha256: string;
  contentType: string;
  cacheControl: string;
  bytes: number;
  /** The site's export version when the render started. */
  exportVersion: number;
  /** When the render started. */
  renderedAt: number;
  /** Last time a change made this page stale. */
  markedAt: number;
  /** Lists, archives, feeds and the sitemap: stale after any publish or unpublish. */
  dynamicList: boolean;
}

/**
 * Freshness state shared by every app process. The database store below is
 * the real one; tests pass an in-memory store with the same contract.
 */
export interface OnDemandStore {
  get(siteId: string, path: string): Promise<OnDemandPage | null>;
  /** Insert or replace a page and its deps. Keeps `markedAt` so a mark during the render still counts. */
  put(page: OnDemandPage, deps: string[]): Promise<void>;
  remove(siteId: string, path: string): Promise<void>;
  /** Claim the refresh of a stale page for `ms`. False when another process holds it. */
  claim(siteId: string, path: string, now: number, ms: number): Promise<boolean>;
  release(siteId: string, path: string): Promise<void>;
  /** Mark every list page, and every page showing one of `deps`, as stale at `at`. */
  markStale(siteId: string, deps: string[], at: number): Promise<void>;
  /** Single pages (not lists) that show one of `deps`. */
  pagesShowing(siteId: string, deps: string[]): Promise<OnDemandPage[]>;
  getVersion(siteId: string): Promise<number>;
  /** Make every page of the site stale in one write. */
  bumpVersion(siteId: string, version: number): Promise<void>;
  all(siteId: string): Promise<OnDemandPage[]>;
  /** Counts for the Tools screen. A page is stale as in `freshness()`. */
  stats(siteId: string, version: number, expiredBefore: number): Promise<OnDemandStats>;
  clear(siteId: string): Promise<void>;
}

export interface OnDemandStats {
  pages: number;
  stale: number;
  bytes: number;
}

/** Site setting holding the export version. A new value makes every file stale. */
export const EXPORT_VERSION_KEY = "static_export_version";

export function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

type Row = Record<string, unknown>;

function toPage(row: Row): OnDemandPage {
  return {
    siteId: String(row.site_id),
    path: String(row.path),
    file: String(row.file),
    sha256: String(row.sha256),
    contentType: String(row.content_type),
    cacheControl: String(row.cache_control),
    bytes: Number(row.bytes),
    exportVersion: Number(row.export_version),
    renderedAt: Number(row.rendered_at),
    markedAt: Number(row.marked_at),
    dynamicList: Number(row.dynamic_list) === 1,
  };
}

const COLUMNS =
  "site_id, path, file, sha256, content_type, cache_control, bytes, export_version, rendered_at, marked_at, dynamic_list";

function isPostgres(): boolean {
  return process.env.DB_DRIVER === "postgres";
}

/** In-list placeholders, bounded so one statement never grows without limit. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export const dbOnDemandStore: OnDemandStore = {
  async get(siteId, path) {
    const db = await getDb();
    const rows = await db.query<Row>(
      `SELECT ${COLUMNS} FROM static_export_pages WHERE site_id = ? AND path_hash = ? LIMIT 1`,
      [siteId, pathHash(path)],
    );
    return rows[0] ? toPage(rows[0]) : null;
  },

  async put(page, deps) {
    const db = await getDb();
    const hash = pathHash(page.path);
    const values = [
      page.siteId,
      hash,
      page.path,
      page.file,
      page.sha256,
      page.contentType,
      page.cacheControl,
      page.bytes,
      page.exportVersion,
      page.renderedAt,
      page.dynamicList ? 1 : 0,
    ];
    const insert =
      "INSERT INTO static_export_pages (site_id, path_hash, path, file, sha256, content_type, cache_control, bytes, export_version, rendered_at, dynamic_list) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ";
    if (isPostgres()) {
      await db.run(
        insert +
          "ON CONFLICT (site_id, path_hash) DO UPDATE SET path = EXCLUDED.path, file = EXCLUDED.file, sha256 = EXCLUDED.sha256, " +
          "content_type = EXCLUDED.content_type, cache_control = EXCLUDED.cache_control, bytes = EXCLUDED.bytes, " +
          "export_version = EXCLUDED.export_version, rendered_at = EXCLUDED.rendered_at, dynamic_list = EXCLUDED.dynamic_list, claimed_until = 0",
        values,
      );
    } else {
      await db.run(
        insert +
          "ON DUPLICATE KEY UPDATE path = VALUES(path), file = VALUES(file), sha256 = VALUES(sha256), " +
          "content_type = VALUES(content_type), cache_control = VALUES(cache_control), bytes = VALUES(bytes), " +
          "export_version = VALUES(export_version), rendered_at = VALUES(rendered_at), dynamic_list = VALUES(dynamic_list), claimed_until = 0",
        values,
      );
    }
    await db.run("DELETE FROM static_export_page_deps WHERE site_id = ? AND path_hash = ?", [page.siteId, hash]);
    const unique = [...new Set(deps)].slice(0, 20);
    if (unique.length > 0) {
      await db.run(
        `INSERT INTO static_export_page_deps (site_id, path_hash, dep) VALUES ${unique.map(() => "(?, ?, ?)").join(", ")}`,
        unique.flatMap((dep) => [page.siteId, hash, dep]),
      );
    }
  },

  async remove(siteId, path) {
    const db = await getDb();
    const hash = pathHash(path);
    await db.run("DELETE FROM static_export_page_deps WHERE site_id = ? AND path_hash = ?", [siteId, hash]);
    await db.run("DELETE FROM static_export_pages WHERE site_id = ? AND path_hash = ?", [siteId, hash]);
  },

  async claim(siteId, path, now, ms) {
    const db = await getDb();
    const hash = pathHash(path);
    await db.run(
      "UPDATE static_export_pages SET claimed_until = ? WHERE site_id = ? AND path_hash = ? AND claimed_until < ?",
      [now + ms, siteId, hash, now],
    );
    const rows = await db.query<{ claimed_until: unknown }>(
      "SELECT claimed_until FROM static_export_pages WHERE site_id = ? AND path_hash = ? LIMIT 1",
      [siteId, hash],
    );
    /** Only the process that wrote this exact value owns the claim. A missing row is free. */
    return !rows[0] || Number(rows[0].claimed_until) === now + ms;
  },

  async release(siteId, path) {
    const db = await getDb();
    await db.run("UPDATE static_export_pages SET claimed_until = 0 WHERE site_id = ? AND path_hash = ?", [
      siteId,
      pathHash(path),
    ]);
  },

  async markStale(siteId, deps, at) {
    const db = await getDb();
    await db.run("UPDATE static_export_pages SET marked_at = ? WHERE site_id = ? AND dynamic_list = 1", [at, siteId]);
    const unique = [...new Set(deps)];
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      await db.run(
        `UPDATE static_export_pages SET marked_at = ? WHERE site_id = ? AND path_hash IN (` +
          `SELECT path_hash FROM (SELECT path_hash FROM static_export_page_deps WHERE site_id = ? AND dep IN (${placeholders(batch.length)})) AS shown)`,
        [at, siteId, siteId, ...batch],
      );
    }
  },

  async pagesShowing(siteId, deps) {
    const unique = [...new Set(deps)];
    if (unique.length === 0) return [];
    const db = await getDb();
    const rows = await db.query<Row>(
      `SELECT ${COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")} FROM static_export_pages p ` +
        `JOIN static_export_page_deps d ON d.site_id = p.site_id AND d.path_hash = p.path_hash ` +
        `WHERE p.site_id = ? AND p.dynamic_list = 0 AND d.dep IN (${placeholders(Math.min(unique.length, 100))})`,
      [siteId, ...unique.slice(0, 100)],
    );
    const seen = new Set<string>();
    return rows.map(toPage).filter((page) => !seen.has(page.path) && seen.add(page.path));
  },

  async getVersion(siteId) {
    const value = Number(await getSiteSetting<unknown>(siteId, EXPORT_VERSION_KEY));
    return Number.isFinite(value) ? value : 0;
  },

  async bumpVersion(siteId, version) {
    await setSiteSetting(siteId, EXPORT_VERSION_KEY, version);
  },

  async all(siteId) {
    const db = await getDb();
    const rows = await db.query<Row>(`SELECT ${COLUMNS} FROM static_export_pages WHERE site_id = ?`, [siteId]);
    return rows.map(toPage);
  },

  async stats(siteId, version, expiredBefore) {
    const db = await getDb();
    const rows = await db.query<Row>(
      "SELECT COUNT(*) AS pages, COALESCE(SUM(bytes), 0) AS bytes, " +
        "COALESCE(SUM(CASE WHEN export_version <> ? OR marked_at >= rendered_at OR rendered_at <= ? THEN 1 ELSE 0 END), 0) AS stale " +
        "FROM static_export_pages WHERE site_id = ?",
      [version, expiredBefore, siteId],
    );
    return {
      pages: Number(rows[0]?.pages ?? 0),
      stale: Number(rows[0]?.stale ?? 0),
      bytes: Number(rows[0]?.bytes ?? 0),
    };
  },

  async clear(siteId) {
    const db = await getDb();
    await db.run("DELETE FROM static_export_page_deps WHERE site_id = ?", [siteId]);
    await db.run("DELETE FROM static_export_pages WHERE site_id = ?", [siteId]);
  },
};
