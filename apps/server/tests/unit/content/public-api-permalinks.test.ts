// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

/**
 * `/api/v1/content` used to resolve each item's link on its own, and every
 * resolver loaded the site's whole term table: 100 items on a 100k-post site
 * ran the server out of memory from one anonymous request.
 */
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createResolver: vi.fn(),
  contentPermalink: vi.fn(),
}));
vi.mock("../../../src/lib/content/visibility-scope.js", () => {
  const open = { restricted: false, allows: () => true, sql: () => ({ sql: "1 = 1", params: [] }) };
  return { getVisibilityScope: async () => open, getAnonymousVisibilityScope: async () => open, isOpenToEveryone: async () => true };
});
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query: mocks.query }) }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => "site-a" }));
vi.mock("../../../src/lib/settings/site-visibility.js", () => ({ isSitePublic: async () => true, isSiteClosed: async () => false, canViewUnpublishedSite: async () => false }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ resolveContentLocale: async () => "en", getDefaultLocale: async () => "en", getActiveLocaleCodes: async () => ["en"] }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({ has: () => false }) }));
vi.mock("../../../src/lib/navigation/permalinks-db.js", () => ({
  createContentPermalinkResolver: mocks.createResolver,
  contentPermalink: mocks.contentPermalink,
}));
import router from "../../../src/routes/public/public-api.js";

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createResolver.mockImplementation(async () => async (content: { slug: string }) => `/${content.slug}`);
});

it("resolves a 100-item listing with one resolver preloaded with those items", async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({
    id: `id-${String(i).padStart(3, "0")}`, site_id: "site-a", type: "post", title: `Post ${i}`,
    slug: `post-${i}`, locale: "en", status: "published",
  }));
  mocks.query.mockResolvedValue(rows);
  const res = await fetch(`${base}/content?type=post&limit=100`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ links: { self: string } }>; nextCursor: string | null };
  expect(body.items).toHaveLength(100);
  expect(body.items[0]!.links.self).toBe("/post-0");
  expect(body.items[99]!.links.self).toBe("/post-99");
  expect(mocks.createResolver).toHaveBeenCalledOnce();
  expect(mocks.createResolver).toHaveBeenCalledWith("site-a", { preloadIds: rows.slice(0, 100).map((row) => row.id) });
  expect(mocks.contentPermalink).not.toHaveBeenCalled();
});
