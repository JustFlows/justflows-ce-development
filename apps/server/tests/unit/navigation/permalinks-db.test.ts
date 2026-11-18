// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMALINK_SETTINGS as defaults, PERMALINK_PRESETS } from "../../../src/lib/navigation/permalinks.js";
import { serializeContentRow } from "../../../src/lib/content/content-api.js";
let state: unknown;
let rows: Record<string, unknown>[];
let termRows: Record<string, unknown>[];
const invalidate = vi.fn();
const set = vi.fn(async (_site: string, _key: string, value: unknown) => {
  state = structuredClone(value);
});
vi.mock("../../../src/lib/settings/site-settings.js", () => ({
  getSiteSetting: async () => state,
  setSiteSetting: (...args: [string, string, unknown]) => set(...args),
}));
/** The category lookup, answered from `termRows` the way the SQL orders it: slug, then id. */
function categoryRows(params: unknown[]): Record<string, unknown>[] {
  const ids = params.slice(1);
  return termRows
    .filter((r) => r.taxonomy === "category" && r.content_id && (ids.length === 0 || ids.includes(r.content_id)))
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)) || String(a.id).localeCompare(String(b.id)))
    .map((r) => ({ content_id: r.content_id, slug: r.slug }));
}
const query = vi.fn(async (sql: string, params: unknown[] = []) =>
  sql.includes("FROM content_terms ct") ? categoryRows(params)
    : sql.includes("FROM content WHERE") ? rows : sql.includes("FROM terms t") ? termRows : [],
);
const home = vi.fn(async (_siteId: string, _locale: string): Promise<ReturnType<typeof serializeContentRow> | null> => null);
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query }) }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({
  getDefaultLocale: async () => "en-US",
  getActiveLocaleCodes: async () => ["en-US", "nl-NL"],
}));
vi.mock("../../../src/lib/admin/admin-path.js", () => ({
  getAdminPathConfig: async () => ({ path: "/control-room" }),
}));
vi.mock("../../../src/lib/content/home-page.js", () => ({ getHomeContent: (...args: [string, string]) => home(...args) }));
vi.mock("../../../src/lib/themes/layout-scopes.js", () => ({
  resolveTypeBases: async (_siteId: string, stored: Record<string, string>) => stored,
  listLayoutScopes: async () => [],
}));
vi.mock("../../../src/lib/cache/jf-cache.js", () => ({
  getJfCache: () => ({
    invalidate,
    remember: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
  }),
}));
const { savePermalinks, getPermalinkState, uniquePermalinkSlug, contentPermalink, contentPermalinks, createContentPermalinkResolver, withTermPermalinkHistory } =
  await import("../../../src/lib/navigation/permalinks-db.js");
const row = {
  id: "p1",
  site_id: "s1",
  type: "post",
  title: "Hello",
  slug: "hello",
  locale: "en-US",
  status: "published",
  created_at: "2026-01-01T00:00:00Z",
  published_at: "2026-09-07T00:00:00Z",
};
beforeEach(() => {
  state = null;
  rows = [{ ...row }];
  termRows = [];
  vi.clearAllMocks();
  home.mockReset().mockResolvedValue(null);
});
describe("permalink persistence and collision protection", () => {
  it("records known prior URLs by ID across repeated changes and clears active redirects", async () => {
    await savePermalinks("s1", { ...defaults, structure: PERMALINK_PRESETS.day });
    await savePermalinks("s1", { ...defaults, structure: PERMALINK_PRESETS.numeric });
    expect((await getPermalinkState("s1")).redirects).toEqual({
      "/hello": "p1",
      "/2026/09/07/hello": "p1",
    });
    await savePermalinks("s1", defaults);
    expect((await getPermalinkState("s1")).redirects).toEqual({
      "/2026/09/07/hello": "p1",
      "/archives/p1": "p1",
    });
    expect(invalidate).toHaveBeenCalledWith("page:");
  });
  it("does not publish draft URLs in redirect history", async () => {
    rows[0]!.status = "draft";
    expect(await savePermalinks("s1", { ...defaults, structure: PERMALINK_PRESETS.day })).toBe(0);
    expect((await getPermalinkState("s1")).redirects).toEqual({});
  });
  it("rejects cross-type collisions without persisting settings", async () => {
    rows.push({ ...row, id: "page1", type: "page" });
    await expect(savePermalinks("s1", defaults)).rejects.toThrow("collision");
    expect(set).not.toHaveBeenCalled();
    await expect(savePermalinks("s1", { ...defaults, typeBases: { page: "pages" } })).resolves.toBe(
      0,
    );
  });
  it.each(["/control-room/%postname%/", "/nl-NL/%postname%/"])(
    "rejects reserved or locale prefix structure %s even with no content",
    async (structure) => {
      rows = [];
      await expect(savePermalinks("s1", { ...defaults, structure })).rejects.toThrow("platform");
      expect(set).not.toHaveBeenCalled();
    },
  );
  it("resolves slugs across types and protects reserved paths", async () => {
    const candidate = serializeContentRow({ ...row, id: "new", type: "page" });
    expect(await uniquePermalinkSlug(candidate)).toBe("hello-2");
    await expect(uniquePermalinkSlug({ ...candidate, slug: "api" })).rejects.toThrow("reserved");
    await expect(uniquePermalinkSlug({ ...candidate, slug: "control-room" })).rejects.toThrow(
      "reserved",
    );
  });
  it("uses actual category relationships in URLs and redirects taxonomy bases", async () => {
    termRows = [
      { id: "term1", slug: "news", name: "News", taxonomy: "category", content_id: "p1" },
    ];
    await savePermalinks("s1", {
      ...defaults,
      structure: "/%category%/%postname%/",
      categoryBase: "topics",
    });
    expect(await contentPermalink(serializeContentRow(row))).toBe("/news/hello");
    expect((await getPermalinkState("s1")).archiveRedirects).toEqual({
      "/category/news": "en-US:term1",
      "/nl-NL/category/news": "nl-NL:term1",
    });
  });
  it("refuses to steal historical URLs from another content item", async () => {
    state = { settings: defaults, redirects: { "/hello": "deleted-id" } };
    await expect(savePermalinks("s1", defaults)).rejects.toThrow("historical");
    expect(set).not.toHaveBeenCalled();
  });
});


describe("batch permalink resolution", () => {
  it("shares relationships and locale homes across a large list, preserving category priority", async () => {
    state = { settings: { ...defaults, structure: "/%category%/%postname%/" } };
    termRows = [
      { id: "a", slug: "first", name: "First", taxonomy: "category", content_id: "p1" },
      { id: "b", slug: "second", name: "Second", taxonomy: "category", content_id: "p1" },
    ];
    const items = Array.from({ length: 100 }, (_, i) => serializeContentRow({ ...row, id: i === 0 ? "p1" : `p${i + 1}`, slug: `post-${i}`, locale: i % 2 ? "nl-NL" : "en-US" }));
    home.mockImplementation(async (_site, locale) => locale === "nl-NL" ? items[1]! : null);
    const urls = await contentPermalinks(items);
    expect(urls[0]).toBe("/first/post-0");
    expect(urls[1]).toBe("/nl-NL");
    expect(urls[2]).toBe("/uncategorized/post-2");
    expect(query).toHaveBeenCalledOnce();
    expect(home).toHaveBeenCalledTimes(2);
  });

  it("keeps sites separate and preserves input ordering", async () => {
    const items = [serializeContentRow(row), serializeContentRow({ ...row, site_id: "s2", slug: "other" }), serializeContentRow({ ...row, slug: "last" })];
    expect(await contentPermalinks(items)).toEqual(["/hello", "/other", "/last"]);
    /** The default structure has no `%category%`, so no term reads at all. */
    expect(query).not.toHaveBeenCalled();
    expect(home.mock.calls).toEqual([["s1", "en-US", false], ["s2", "en-US", false]]);
    const resolver = await createContentPermalinkResolver("s1");
    await expect(resolver(items[1]!)).rejects.toThrow("another site");
  });

  it("reads categories only for the listed entries, in one query, however many terms the site has", async () => {
    state = { settings: { ...defaults, structure: "/%category%/%postname%/" } };
    termRows = Array.from({ length: 5000 }, (_, i) => ({
      id: `t${i % 50}`, slug: `cat-${String(i % 50).padStart(2, "0")}`, name: "Cat", taxonomy: "category", content_id: `c${i}`,
    }));
    const items = Array.from({ length: 20 }, (_, i) => serializeContentRow({ ...row, id: `c${i}`, slug: `post-${i}` }));
    const urls = await contentPermalinks(items);
    expect(urls[0]).toBe("/cat-00/post-0");
    expect(urls[19]).toBe("/cat-19/post-19");
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("IN (");
    expect(params).toEqual(["s1", ...items.map((item) => item.id)]);
  });

  it("builds a single link without reading terms when the structure has no category", async () => {
    termRows = [{ id: "a", slug: "first", name: "First", taxonomy: "category", content_id: "p1" }];
    expect(await contentPermalink(serializeContentRow(row))).toBe("/hello");
    expect(query).not.toHaveBeenCalled();
  });

  it("loads site categories once for a resolver used without a preload", async () => {
    state = { settings: { ...defaults, structure: "/%category%/%postname%/" } };
    termRows = [
      { id: "b", slug: "beta", name: "Beta", taxonomy: "category", content_id: "p1" },
      { id: "a", slug: "alpha", name: "Alpha", taxonomy: "category", content_id: "p1" },
      { id: "x", slug: "news", name: "News", taxonomy: "tag", content_id: "p2" },
    ];
    const resolve = await createContentPermalinkResolver("s1");
    expect(await resolve(serializeContentRow(row))).toBe("/alpha/hello");
    expect(await resolve(serializeContentRow({ ...row, id: "p2", slug: "two" }))).toBe("/uncategorized/two");
    expect(query).toHaveBeenCalledOnce();
  });

  it("does not perform reads for an empty content list", async () => {
    expect(await contentPermalinks([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(home).not.toHaveBeenCalled();
  });
});

describe("term changes keep old URLs alive", () => {
  it("redirects content moved by a category change and renamed term archives", async () => {
    state = { settings: { ...defaults, structure: "/%category%/%postname%/" }, redirects: { "/sports/hello": "p1" } };
    termRows = [{ id: "t1", slug: "news", name: "News", taxonomy: "category", content_id: "p1" }];
    await withTermPermalinkHistory("s1", async () => {
      termRows = [{ id: "t1", slug: "sports", name: "Sports", taxonomy: "category", content_id: "p1" }];
    });
    const saved = await getPermalinkState("s1");
    expect(saved.redirects).toEqual({ "/news/hello": "p1" });
    expect(saved.archiveRedirects).toEqual({
      "/category/news": "en-US:t1",
      "/nl-NL/category/news": "nl-NL:t1",
    });
    expect(invalidate).toHaveBeenCalledWith("content:");
  });

  it("leaves redirect history alone when no public URL moves", async () => {
    state = { settings: defaults };
    await withTermPermalinkHistory("s1", async () => {
      termRows = [{ id: "t1", slug: "news", name: "News", taxonomy: "category", content_id: "p1" }];
    });
    expect(set).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith("page:");
  });
});
