// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeContentRow, type ContentResponse } from "../../../src/lib/content/content-api.js";
import { DEFAULT_PERMALINK_SETTINGS } from "../../../src/lib/navigation/permalinks.js";

vi.mock("../../../src/lib/account/pages.js", () => ({ accountPageExclusions: async () => [{ path: "/members", match: "exact" }] }));
const published = vi.fn();
const home = vi.fn();
const state = vi.fn();
const terms = vi.fn();
const settings = vi.fn();
vi.mock("../../../src/lib/content/content-public.js", () => ({ listPublishedContent: () => published() }));
vi.mock("../../../src/lib/content/home-page.js", () => ({ getHomeContent: (...args: unknown[]) => home(...args) }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ getDefaultLocale: async () => "en-US" }));
vi.mock("../../../src/lib/plugins/plugin-kv.js", () => ({ getPluginSettings: (...args: unknown[]) => settings(...args) }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({ has: () => false }) }));
vi.mock("../../../src/lib/navigation/permalinks-db.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/navigation/permalinks-db.js")>(),
  getPermalinkState: () => state(),
  listPermalinkTerms: () => terms(),
}));
import { buildSitemapXml } from "../../../src/lib/rendering/seo-public.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", "https://example.test");
  state.mockResolvedValue({ settings: { ...DEFAULT_PERMALINK_SETTINGS, structure: "/%category%/%postname%/" }, layoutScopes: [] });
  settings.mockResolvedValue({ extraSitemapPaths: "/extra\n/members" });
  home.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("sitemap link batching", () => {
  it("reuses settings, relationships and home pages across 100 multilingual entries", async () => {
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
    expect(state).toHaveBeenCalledOnce();
    expect(terms).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledOnce();
    expect(home.mock.calls).toEqual([["site-a", "en-US", false], ["site-a", "nl-NL", false]]);
  });
});
