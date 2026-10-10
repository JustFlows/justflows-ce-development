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
const query = vi.fn(async (sql: string) =>
  sql.includes("FROM content WHERE") ? rows : sql.includes("FROM terms t") ? termRows : [],
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
const { savePermalinks, getPermalinkState, uniquePermalinkSlug, contentPermalink, contentPermalinks, createContentPermalinkResolver } =
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
    expect(query).toHaveBeenCalledTimes(2);
    expect(home.mock.calls).toEqual([["s1", "en-US", false], ["s2", "en-US", false]]);
    const resolver = await createContentPermalinkResolver("s1");
    await expect(resolver(items[1]!)).rejects.toThrow("another site");
  });

  it("does not perform reads for an empty content list", async () => {
    expect(await contentPermalinks([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(home).not.toHaveBeenCalled();
  });
});
