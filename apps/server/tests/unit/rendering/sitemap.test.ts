// SPDX-License-Identifier: MIT
import { resolveContentTypeSettings } from "@justflows/content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeContentRow, type ContentResponse } from "../../../src/lib/content/content-api.js";
import { DEFAULT_PERMALINK_SETTINGS } from "../../../src/lib/navigation/permalinks.js";

vi.mock("../../../src/lib/content/visibility-scope.js", () => {
  const open = { restricted: false, allows: () => true, sql: () => ({ sql: "1 = 1", params: [] }) };
  return { getVisibilityScope: async () => open, getAnonymousVisibilityScope: async () => open, isOpenToEveryone: async () => true };
});
vi.mock("../../../src/lib/account/pages.js", () => ({ accountPageExclusions: async () => [{ path: "/members", match: "exact" }] }));
const published = vi.fn();
const home = vi.fn();
const state = vi.fn();
const terms = vi.fn();
const typeSettings = vi.fn();
vi.mock("../../../src/lib/content/content-types-db.js", () => ({ getContentTypeSettingsMap: (...args: unknown[]) => typeSettings(...args) }));
vi.mock("../../../src/lib/content/content-public.js", () => ({ listPublishedContent: () => published() }));
vi.mock("../../../src/lib/content/home-page.js", () => ({ getHomeContent: (...args: unknown[]) => home(...args) }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ getDefaultLocale: async () => "en-US" }));
/** An SEO plugin adds its extra paths through `seo.sitemapPaths`; private ones are still dropped. */
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({
    has: (name: string) => name === "seo.sitemapPaths",
    applyFilter: async (_name: string, paths: string[]) => [...paths, "/extra", "/members"],
  }),
}));
vi.mock("../../../src/lib/navigation/permalinks-db.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/navigation/permalinks-db.js")>(),
  getPermalinkState: () => state(),
  listPermalinkTerms: () => terms(),
}));
import { buildSitemapXml } from "../../../src/lib/rendering/sitemap.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DB_DRIVER", "");
  vi.stubEnv("APP_URL", "https://example.test");
  state.mockResolvedValue({ settings: { ...DEFAULT_PERMALINK_SETTINGS, structure: "/%category%/%postname%/" }, layoutScopes: [] });
  home.mockResolvedValue(null);
  typeSettings.mockResolvedValue(new Map());
});
afterEach(() => vi.unstubAllEnvs());

describe("sitemap link batching", () => {
  it("reuses relationships and home pages across 100 multilingual entries", async () => {
    const items: ContentResponse[] = Array.from({ length: 100 }, (_, i) => serializeContentRow({
      id: `p${i}`, site_id: "site-a", type: "post", title: `Post ${i}`, slug: `post-${i}`,
      locale: i % 2 ? "nl-NL" : "en-US", status: "published",
    }));
    published.mockResolvedValue(items);
    // Relationships arrive in a different locale order from published content.
    terms.mockResolvedValue([{ id: "news", slug: "news", name: "News", taxonomy: "category", contentIds: ["p1", "p0"] }]);
    const xml = await buildSitemapXml("site-a");
    expect(xml).toContain("https://example.test/news/post-0");
    expect(xml).toContain("https://example.test/nl-NL/news/post-1");
    expect(xml).toContain("https://example.test/extra");
    expect(xml).not.toContain("https://example.test/members");
    expect(xml).toContain("https://example.test/category/news");
    expect(xml.indexOf("https://example.test/category/news")).toBeLessThan(xml.indexOf("https://example.test/nl-NL/category/news"));
    expect(typeSettings.mock.calls).toEqual([["site-a"]]);
    expect(state).toHaveBeenCalledOnce();
    expect(terms).toHaveBeenCalledOnce();
    expect(home.mock.calls).toEqual([["site-a", "en-US", false], ["site-a", "nl-NL", false]]);
  });

  it("excludes SEO-disabled entries and the home page using one settings read", async () => {
    const page = serializeContentRow({
      id: "home", site_id: "site-a", type: "page", title: "Home", slug: "home",
      locale: "en-US", status: "published",
    });
    const post = serializeContentRow({
      id: "post", site_id: "site-a", type: "post", title: "Post", slug: "visible-post",
      locale: "en-US", status: "published",
    });
    published.mockResolvedValue([page, post]);
    home.mockResolvedValue(page);
    terms.mockResolvedValue([]);
    typeSettings.mockResolvedValue(new Map([
      ["page", resolveContentTypeSettings("page", { seo: false })],
      ["post", resolveContentTypeSettings("post")],
    ]));

    const xml = await buildSitemapXml("site-a");

    expect(xml).toContain("<loc>https://example.test/uncategorized/visible-post</loc>");
    expect(xml).not.toContain("<loc>https://example.test/</loc>");
    expect(xml).not.toContain("<loc>https://example.test/home</loc>");
    expect(typeSettings.mock.calls).toEqual([["site-a"]]);
  });
});
