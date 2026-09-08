// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMALINK_SETTINGS as defaults, PERMALINK_PRESETS } from "../permalinks.js";
import { serializeContentRow } from "../content-api.js";
let state: unknown;
let rows: Record<string, unknown>[];
let termRows: Record<string, unknown>[];
const invalidate = vi.fn();
const set = vi.fn(async (_site: string, _key: string, value: unknown) => {
  state = structuredClone(value);
});
vi.mock("../site-settings.js", () => ({
  getSiteSetting: async () => state,
  setSiteSetting: (...args: [string, string, unknown]) => set(...args),
}));
vi.mock("../db.js", () => ({
  getDb: async () => ({
    query: async (sql: string) =>
      sql.includes("FROM content WHERE") ? rows : sql.includes("FROM terms t") ? termRows : [],
  }),
}));
vi.mock("../i18n/languages-db.js", () => ({
  getDefaultLocale: async () => "en-US",
  getActiveLocaleCodes: async () => ["en-US", "nl-NL"],
}));
vi.mock("../admin-path.js", () => ({
  getAdminPathConfig: async () => ({ path: "/control-room" }),
}));
vi.mock("../home-page.js", () => ({ getHomeContent: async () => null }));
vi.mock("../jf-cache.js", () => ({
  getJfCache: () => ({
    invalidate,
    remember: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
  }),
}));
const { savePermalinks, getPermalinkState, uniquePermalinkSlug, contentPermalink } =
  await import("../permalinks-db.js");
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
