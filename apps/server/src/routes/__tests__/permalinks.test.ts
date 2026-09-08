// SPDX-License-Identifier: MIT

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMALINK_SETTINGS as defaults, PERMALINK_PRESETS } from "../../lib/permalinks.js";
import { serializeContentRow } from "../../lib/content-api.js";
import type { PermalinkState, PermalinkTerm } from "../../lib/permalinks-db.js";
let state: PermalinkState;
let items: ReturnType<typeof serializeContentRow>[];
let terms: PermalinkTerm[];
let publicSite = true;
vi.mock("../../lib/permalinks-db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/permalinks-db.js")>()),
  getPermalinkState: async () => state,
  permalinkContent: async () => items,
  listPermalinkTerms: async () => terms,
}));
vi.mock("../../lib/site-settings.js", () => ({ getSiteId: async () => "s1" }));
vi.mock("../../lib/i18n/languages-db.js", () => ({
  getDefaultLocale: async () => "en-US",
  getActiveLocaleCodes: async () => ["en-US", "nl-NL"],
}));
vi.mock("../../lib/admin-path.js", () => ({
  getAdminPathConfig: async () => ({ path: "/control-room" }),
}));
vi.mock("../../lib/home-page.js", () => ({ getHomeContent: async () => null }));
const { createPermalinkRouter } = await import("../permalinks.js");
let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use(
    createPermalinkRouter({
      async canView(_req, res) {
        if (!publicSite) res.sendStatus(403);
        return publicSite;
      },
      async renderContent(_req, res, data) {
        res.json(data);
      },
      async renderArchive(_req, res, data) {
        res.json(data);
      },
    }),
  );
  app.use((_req, res) => {
    res.sendStatus(404);
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  state = {
    settings: { ...defaults, structure: PERMALINK_PRESETS.day, trailingSlash: "always" },
    redirects: { "/old": "p1" },
  };
  items = [
    serializeContentRow({
      id: "p1",
      site_id: "s1",
      title: "Hello",
      slug: "hello",
      type: "post",
      locale: "en-US",
      status: "published",
      published_at: "2026-09-07T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
    }),
  ];
  terms = [];
  publicSite = true;
});
const get = (path: string) => fetch(`${origin}${path}`, { redirect: "manual" });
describe("public permalink routing", () => {
  it("applies slash policy to locale roots", async () => {
    const response = await get("/nl-NL");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/nl-NL/");
  });
  it("does not serve disabled locales", async () => {
    items[0]!.locale = "de-DE";
    expect((await get("/de-DE/2026/09/07/hello/")).status).toBe(404);
  });
  it("resolves numeric slugs in literal page segments before pagination", async () => {
    state.settings.structure = "/blog/page/%postname%/";
    items[0]!.slug = "2";
    const response = await get("/blog/page/2/");
    expect(response.status).toBe(200);
    expect((await response.json()).pageNumber).toBe(1);
  });

  it("renders the active structure and redirects old URLs directly with query parameters", async () => {
    expect((await get("/2026/09/07/hello/")).status).toBe(200);
    const response = await get("/old?utm_source=newsletter");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/2026/09/07/hello/?utm_source=newsletter");
  });
  it("canonicalizes slashes and explicit default locale prefixes", async () => {
    for (const path of ["/2026/09/07/hello", "/en-us/2026/09/07/hello/"]) {
      const response = await get(path);
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/2026/09/07/hello/");
    }
  });
  it("serves plain IDs separately from the homepage", async () => {
    state.settings.structure = PERMALINK_PRESETS.plain;
    const response = await get("/?p=p1");
    expect(response.status).toBe(200);
    expect((await response.json()).content.id).toBe("p1");
    const old = await get("/old");
    expect(old.headers.get("location")).toBe("/?p=p1");
    expect((await get("/?p=missing")).status).toBe(404);
  });
  it("keeps pagination distinct and canonicalizes page one", async () => {
    const response = await get("/2026/09/07/hello/page/2/");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.path).toBe("/2026/09/07/hello/page/2/");
    expect(data.pageNumber).toBe(2);
    expect((await get("/2026/09/07/hello/page/1/")).headers.get("location")).toBe(
      "/2026/09/07/hello/",
    );
  });
  it("never exposes unpublished targets or bypasses site visibility", async () => {
    items = [];
    expect((await get("/old")).status).toBe(404);
    items = [
      serializeContentRow({
        id: "p1",
        site_id: "s1",
        status: "published",
        type: "post",
        slug: "hello",
        locale: "en-US",
        published_at: "2026-09-07T00:00:00Z",
      }),
    ];
    publicSite = false;
    expect((await get("/old")).status).toBe(403);
  });
  it.each(["/api", "/control-room", "/nl-NL/control-room", "/assets", "/sitemap.xml"])(
    "leaves platform URL %s alone",
    async (path) => {
      state.redirects[path] = "p1";
      expect((await get(path)).status).toBe(404);
    },
  );
  it("renders taxonomy membership at the configured base and redirects its old base", async () => {
    terms = [{ id: "t1", slug: "news", name: "News", taxonomy: "category", contentIds: ["p1"] }];
    state.settings.categoryBase = "topics";
    state.archiveRedirects = { "/category/news": "en-US:t1" };
    const response = await get("/topics/news/");
    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([{ title: "Hello", path: "/2026/09/07/hello/" }]);
    expect((await get("/category/news")).headers.get("location")).toBe("/topics/news/");
  });
});
