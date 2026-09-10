// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchBackend } from "@justflows/sdk";
import { SearchQuerySchema } from "@justflows/content";

let engine: SearchBackend | null = null;
vi.mock("../plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({ applyFilter: async () => engine }),
}));
vi.mock("../permalinks-db.js", () => ({
  contentPermalink: async (row: { slug: string }) => `/${row.slug}`,
}));
import { getDb } from "../db.js";
import { runAllMigrations, type DbDriver } from "../run-migrations.js";
import {
  indexSearchContent,
  rebuildSearchIndex,
  searchContent,
  saveSearchSettings,
} from "../search-db.js";

// Opt in only with a disposable database; never uses the developer's installed site.
const enabled = process.env.SEARCH_TEST_DATABASE === "1" && process.env.DB_NAME === "search_test";
describe.skipIf(!enabled)("native search index", () => {
  const siteId = randomUUID();
  const otherSite = randomUUID();
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    const db = await getDb();
    // Minimal source fixture: search has no dependency on audit/security schema.
    const pg = process.env.DB_DRIVER === "postgres";
    const uuid = pg ? "UUID" : "CHAR(36)";
    const json = pg ? "JSONB" : "JSON";
    const stamp = pg ? "TIMESTAMPTZ" : "DATETIME";
    const suffix = pg ? "" : " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    await db.run(
      `CREATE TABLE IF NOT EXISTS sites (id ${uuid} PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL)${suffix}`,
    );
    await db.run(`CREATE TABLE IF NOT EXISTS content (
      id ${uuid} PRIMARY KEY, site_id ${uuid} NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      type VARCHAR(60) NOT NULL, title VARCHAR(1024) NOT NULL, slug VARCHAR(1024) NOT NULL,
      locale VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL, blocks ${json} NOT NULL,
      fields ${json} NOT NULL, excerpt TEXT, author_id ${uuid}, published_at ${stamp}, trashed_at ${stamp},
      created_at ${stamp} DEFAULT CURRENT_TIMESTAMP, updated_at ${stamp} DEFAULT CURRENT_TIMESTAMP,
      version INTEGER DEFAULT 1
    )${suffix}`);
    await db.run(`CREATE TABLE IF NOT EXISTS site_settings (
      id ${uuid} PRIMARY KEY, site_id ${uuid} NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      ${pg ? "key" : "`key`"} VARCHAR(255) NOT NULL, value ${json} NOT NULL,
      updated_at ${stamp} DEFAULT CURRENT_TIMESTAMP, UNIQUE (site_id, ${pg ? "key" : "`key`"})
    )${suffix}`);
    await db.run(
      `CREATE TABLE IF NOT EXISTS taxonomies (id ${uuid} PRIMARY KEY, site_id ${uuid} NOT NULL, slug VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL)${suffix}`,
    );
    await db.run(
      `CREATE TABLE IF NOT EXISTS terms (id ${uuid} PRIMARY KEY, site_id ${uuid} NOT NULL, taxonomy_id ${uuid} NOT NULL, slug VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL)${suffix}`,
    );
    await db.run(
      `CREATE TABLE IF NOT EXISTS content_terms (content_id ${uuid} NOT NULL, term_id ${uuid} NOT NULL, PRIMARY KEY (content_id, term_id))${suffix}`,
    );
    await runAllMigrations(db, process.env.DB_DRIVER as DbDriver, [
      "0028_site_search",
      "0029_search_metrics",
    ]);
    expect(
      (
        await runAllMigrations(db, process.env.DB_DRIVER as DbDriver, [
          "0028_site_search",
          "0029_search_metrics",
        ])
      ).applied,
    ).toHaveLength(0);
    for (const id of [siteId, otherSite])
      await db.run("INSERT INTO sites (id, name, url) VALUES (?, ?, ?)", [
        id,
        "Search test",
        `https://${id}.test`,
      ]);
    const rows = [
      ["title", "Astronomy guide", "post", "published", "en-US", siteId, "2026-01-02 12:00:00"],
      ["body", "Other science", "post", "published", "en-US", siteId, null],
      ["draft", "Astronomy draft", "post", "draft", "en-US", siteId, null],
      ["future", "Astronomy future", "post", "published", "en-US", siteId, "2099-01-01 00:00:00"],
      ["locale", "Astronomy vertaling", "post", "published", "nl-NL", siteId, null],
      ["hidden", "Astronomy internal", "secret", "published", "en-US", siteId, null],
      ["site", "Astronomy other site", "post", "published", "en-US", otherSite, null],
    ];
    for (const [key, title, type, status, locale, sid, published] of rows) {
      const id = randomUUID();
      ids[key!] = id;
      await db.run(
        "INSERT INTO content (id, site_id, type, title, slug, locale, status, blocks, fields, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          sid!,
          type!,
          title!,
          key!,
          locale!,
          status!,
          JSON.stringify({
            version: 1,
            blocks: [
              {
                type: "core.paragraph",
                props: { content: "Astronomy telescopes discover planets" },
              },
            ],
          }),
          "{}",
          published ?? null,
        ],
      );
    }
    ids.taxonomy = randomUUID();
    ids.term = randomUUID();
    await db.run(
      "INSERT INTO taxonomies (id, site_id, slug, name) VALUES (?, ?, 'category', 'Categories')",
      [ids.taxonomy, siteId],
    );
    await db.run(
      "INSERT INTO terms (id, site_id, taxonomy_id, slug, name) VALUES (?, ?, ?, 'science', 'Science')",
      [ids.term, siteId, ids.taxonomy],
    );
    await db.run("INSERT INTO content_terms (content_id, term_id) VALUES (?, ?)", [
      ids.title!,
      ids.term,
    ]);
    await rebuildSearchIndex(siteId);
    await rebuildSearchIndex(otherSite);
  }, 60_000);
  afterAll(async () => {
    const db = await getDb();
    await db.run("DELETE FROM content_terms WHERE term_id = ?", [
      ids.term ?? "00000000-0000-0000-0000-000000000000",
    ]);
    await db.run("DELETE FROM terms WHERE site_id IN (?, ?)", [siteId, otherSite]);
    await db.run("DELETE FROM taxonomies WHERE site_id IN (?, ?)", [siteId, otherSite]);
    await db.run("DELETE FROM content WHERE site_id IN (?, ?)", [siteId, otherSite]);
    await db.run("DELETE FROM site_settings WHERE site_id IN (?, ?)", [siteId, otherSite]);
    await db.run("DELETE FROM sites WHERE id IN (?, ?)", [siteId, otherSite]);
    await db.close();
  });
  const query = (value = {}) =>
    SearchQuerySchema.parse({ q: "astronomy", locale: "en-US", ...value });
  it("indexes body text, weights title, and excludes drafts, future, other sites/locales/types", async () => {
    const result = await searchContent(siteId, query());
    expect(result.total).toBe(2);
    expect(result.items.map((v) => v.id)).toEqual([ids.title, ids.body]);
    const body = await searchContent(siteId, query({ q: "telescopes" }));
    expect(body.total).toBe(2);
    expect(body.items[0]?.highlights.excerpt.some((p) => p.match)).toBe(true);
    const nl = await searchContent(siteId, query({ locale: "nl-NL" }));
    expect(nl.items.map((v) => v.id)).toEqual([ids.locale]);
  });
  it("paginates with a stable rank/id order and a full total", async () => {
    const a = await searchContent(siteId, query({ limit: 1 }));
    const b = await searchContent(siteId, query({ limit: 1, page: 2 }));
    expect(a.total).toBe(2);
    expect(a.hasMore).toBe(true);
    expect(b.hasMore).toBe(false);
    expect(b.items[0]?.id).not.toBe(a.items[0]?.id);
  });
  it("applies admin scopes in the query before counting", async () => {
    const result = await searchContent(siteId, query(), {
      admin: { status: "draft", types: ["post"], locales: ["en-US"] },
    });
    expect(result.items.map((v) => v.id)).toEqual([ids.draft]);
    expect((await searchContent(siteId, query(), { admin: { types: ["absent"] } })).total).toBe(0);
  });
  it("filters current taxonomy relations and inclusive dates", async () => {
    const result = await searchContent(
      siteId,
      query({ taxonomy: "category", term: "science", after: "2026-01-02", before: "2026-01-02" }),
    );
    expect(result.items.map((v) => v.id)).toEqual([ids.title]);
    expect((await searchContent(siteId, query({ after: "2026-01-03" }))).total).toBe(0);
    const db = await getDb();
    await db.run("DELETE FROM content_terms WHERE term_id = ?", [ids.term!]);
    expect((await searchContent(siteId, query({ term: "science" }))).total).toBe(0);
    expect((await searchContent(siteId, query(), { admin: { ownerId: randomUUID() } })).total).toBe(
      0,
    );
  });
  it("excludes trash immediately even before reindexing", async () => {
    const db = await getDb();
    await db.run("UPDATE content SET trashed_at = CURRENT_TIMESTAMP WHERE id = ?", [ids.body!]);
    expect((await searchContent(siteId, query())).items.map((v) => v.id)).toEqual([ids.title]);
    await db.run("UPDATE content SET trashed_at = NULL WHERE id = ?", [ids.body!]);
  });
  it("updates incrementally, denies stale unpublished results, and cascades deletes", async () => {
    const db = await getDb();
    await db.run("UPDATE content SET title = ? WHERE id = ?", ["Galactic history", ids.title!]);
    await indexSearchContent(siteId, ids.title!);
    expect((await searchContent(siteId, query({ q: "galactic" }))).items[0]?.id).toBe(ids.title);
    await db.run("UPDATE content SET status = 'draft' WHERE id = ?", [ids.title!]);
    expect((await searchContent(siteId, query({ q: "galactic" }))).total).toBe(0);
    await db.run("DELETE FROM content WHERE id = ?", [ids.title!]);
    expect(
      await db.query("SELECT * FROM search_documents WHERE content_id = ?", [ids.title!]),
    ).toHaveLength(0);
  });
  it("rechecks external IDs and ignores plugin snippets/unauthorized counts", async () => {
    engine = {
      id: "test",
      typoTolerance: true,
      search: async () => [ids.draft!, ids.site!, ids.body!, ids.hidden!],
      upsert: vi.fn(),
      remove: vi.fn(),
    };
    try {
      const result = await searchContent(siteId, query({ q: "astronmy" }));
      expect(result.items.map((v) => v.id)).toEqual([ids.body]);
      expect(result.total).toBe(1);
      expect(result.typoTolerance).toBe(true);
      await indexSearchContent(siteId, ids.draft!);
      expect(engine.remove).toHaveBeenCalledWith(ids.draft, siteId);
      expect(engine.upsert).not.toHaveBeenCalled();
    } finally {
      engine = null;
    }
  });
  it("keeps the local document current when an external engine fails", async () => {
    const db = await getDb();
    engine = {
      id: "offline",
      search: async () => [],
      upsert: async () => {
        throw new Error("offline");
      },
      remove: async () => {},
    };
    try {
      await db.run("UPDATE content SET title = 'Observatory science' WHERE id = ?", [ids.body!]);
      await expect(indexSearchContent(siteId, ids.body!)).rejects.toThrow(
        "External search indexing failed",
      );
      expect(
        (await searchContent(siteId, query({ q: "observatory" }), { admin: {} })).items[0]?.id,
      ).toBe(ids.body);
      const [doc] = await db.query<{ pending: number }>(
        "SELECT COUNT(*) AS pending FROM search_documents d JOIN content c ON c.id = d.content_id WHERE d.content_id = ? AND d.indexed_at < c.updated_at",
        [ids.body!],
      );
      expect(Number(doc?.pending)).toBe(1);
    } finally {
      engine = null;
    }
  });
  it("repairs a missing document and persists only opt-in anonymous metrics without logging", async () => {
    const db = await getDb();
    await db.run("DELETE FROM search_documents WHERE content_id = ?", [ids.body!]);
    await rebuildSearchIndex(siteId, true);
    expect((await searchContent(siteId, query())).items[0]?.id).toBe(ids.body);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await searchContent(siteId, query());
      expect(log).not.toHaveBeenCalled();
      await saveSearchSettings(siteId, { publicTypes: ["post"], queryLogging: true });
      await searchContent(siteId, query({ q: "private-search-phrase" }));
      const metrics = await db.query("SELECT * FROM search_metrics WHERE site_id = ?", [siteId]);
      expect(metrics).toHaveLength(1);
      expect(Object.keys(metrics[0]!).sort()).toEqual([
        "created_at",
        "duration_ms",
        "id",
        "result_count",
        "site_id",
        "token_count",
      ]);
      expect(Number(metrics[0]!.token_count)).toBe(3);
      expect(Number(metrics[0]!.result_count)).toBe(0);
      expect(JSON.stringify(metrics)).not.toContain("private-search-phrase");
      await searchContent(siteId, query(), { admin: {} });
      await saveSearchSettings(siteId, { publicTypes: ["post"], queryLogging: false });
      await searchContent(siteId, query());
      expect(
        await db.query("SELECT id FROM search_metrics WHERE site_id = ?", [siteId]),
      ).toHaveLength(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it("fails closed when no public content types are selected", async () => {
    await saveSearchSettings(siteId, { publicTypes: [], queryLogging: false });
    expect((await searchContent(siteId, query())).total).toBe(0);
  });
});
