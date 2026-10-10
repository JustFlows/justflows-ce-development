// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../src/lib/account/pages.js", () => ({ accountPageExclusions: async () => [
  { path: "/members", match: "exact" }, { path: "/members/page", match: "prefix" },
] }));
vi.mock("../../../src/lib/themes/themes-db.js", () => ({ getSiteId: async () => "site-a" }));
vi.mock("../../../src/lib/navigation/permalinks-db.js", () => ({ getPermalinkState: async () => ({ settings: { structure: "/%postname%/" } }), createContentPermalinkResolver: async () => async () => "/about" }));
vi.mock("../../../src/lib/content/content-public.js", () => ({ listPublishedContent: async () => [] }));
vi.mock("../../../src/lib/content/home-page.js", () => ({ getHomeContent: async () => null }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ getDefaultLocale: async () => "en", getActiveLocaleCodes: async () => ["en"] }));
vi.mock("../../../src/lib/pwa/pwa-settings.js", () => ({ getPwaSettings: async () => ({ enabled: false }) }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({ has: () => true, applyFilter: async (_hook: string, paths: string[]) => [...paths, "/members", "/members/page/2"] }) }));
import { discoverRoutes } from "../../../src/lib/static-export/discover.js";
describe("type-based account export exclusions", () => {
  it("removes private URLs even when sitemap data and plugin hooks add them", async () => {
    const result = await discoverRoutes(async () => ({ ok: true, body: '<urlset><url><loc>/members</loc></url><url><loc>/about</loc></url></urlset>' }));
    expect(result.paths).toContain("/about"); expect(result.paths).not.toContain("/members");
    expect(result.paths).not.toContain("/members/page/2");
  });
});
