// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let role: string | null = "administrator";
let scope: Record<string, unknown> = {};
let publicSite = true;
const search = vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 20 }));
const rebuild = vi.fn(async () => 4);
vi.mock("../../lib/auth-session.js", () => ({
  resolveSession: async () => (role ? { siteId: "site-1", userId: "user-1", role } : null),
}));
vi.mock("../../lib/session.js", async (original) => ({
  ...(await original<typeof import("../../lib/session.js")>()),
  syncCsrfCookie: vi.fn(),
}));
vi.mock("../../lib/access-policy.js", () => ({
  getEffectiveAccess: async () => ({
    capabilities: role === "blocked" ? [] : ["content:read"],
    policy: { scopes: { "content:read": scope } },
  }),
  userCan: async (_session: unknown, cap: string) =>
    role === "administrator" || cap === "content:read",
}));
vi.mock("../../lib/search-db.js", async (original) => ({
  ...(await original<typeof import("../../lib/search-db.js")>()),
  searchContent: (...args: unknown[]) => search(...(args as [])),
  rebuildSearchIndex: (...args: unknown[]) => rebuild(...(args as [])),
  getSearchSettings: async () => ({ publicTypes: ["post"], queryLogging: false }),
  saveSearchSettings: async (_id: string, data: unknown) => data,
}));
vi.mock("../../lib/site-settings.js", () => ({
  getSiteId: async () => "site-1",
  getSiteSetting: async () => null,
  setSiteSetting: vi.fn(),
}));
vi.mock("../../lib/site-visibility.js", () => ({
  isSitePublic: async () => publicSite,
  canViewUnpublishedSite: async () => false,
}));
vi.mock("../../lib/i18n/languages-db.js", () => ({
  getDefaultLocale: async () => "en-US",
  resolveContentLocale: async (value: string) => value,
  getActiveLocaleCodes: async () => ["en-US", "nl-NL"],
}));
vi.mock("../../lib/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({ has: () => false }) }));
const { default: adminRouter } = await import("../search.js");
const { default: publicRouter } = await import("../public-api.js");
let server: Server;
let endpoint: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/search", adminRouter);
  app.use("/api/v1", publicRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  role = "administrator";
  scope = {};
  publicSite = true;
  search.mockClear();
  rebuild.mockClear();
});
describe("search HTTP boundaries", () => {
  it("requires an authenticated and authorized admin", async () => {
    role = null;
    expect((await fetch(`${endpoint}/api/search?q=test`)).status).toBe(401);
    role = "blocked";
    expect((await fetch(`${endpoint}/api/search?q=test`)).status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });
  it("passes ownership, type and locale scopes, rejects another site", async () => {
    scope = { ownership: "self", contentTypes: ["post"], locales: ["nl-NL"] };
    expect((await fetch(`${endpoint}/api/search?q=test`)).status).toBe(200);
    expect(search).toHaveBeenCalledWith("site-1", expect.objectContaining({ q: "test" }), {
      admin: { ownerId: "user-1", types: ["post"], locales: ["nl-NL"] },
    });
    scope = { siteIds: ["other-site"] };
    expect((await fetch(`${endpoint}/api/search?q=test`)).status).toBe(403);
  });
  it("validates parameters before any expensive search", async () => {
    for (const query of ["q=x&page=NaN", "q=x&q=y", "q=x&limit=999", "q=x&after=bad"]) {
      expect((await fetch(`${endpoint}/api/v1/search?${query}`)).status).toBe(400);
    }
    expect((await fetch(`${endpoint}/api/v1/search?q=x&locale=unknown`)).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });
  it("keeps public search public even with preview or admin flags", async () => {
    const response = await fetch(`${endpoint}/api/v1/search?q=test&preview=1&admin=true`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(search).toHaveBeenCalledWith("site-1", expect.objectContaining({ locale: "en-US" }));
    publicSite = false;
    expect((await fetch(`${endpoint}/api/v1/search?q=test`)).status).toBe(404);
  });
  it("restricts settings and rebuild to settings managers", async () => {
    role = "editor";
    expect((await fetch(`${endpoint}/api/search/rebuild`, { method: "POST" })).status).toBe(403);
    expect(rebuild).not.toHaveBeenCalled();
    role = "administrator";
    expect((await fetch(`${endpoint}/api/search/rebuild`, { method: "POST" })).status).toBe(200);
    const response = await fetch(`${endpoint}/api/search/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicTypes: ["invalid/type"] }),
    });
    expect(response.status).toBe(400);
  });
  it("rate limits anonymous search", async () => {
    const responses = await Promise.all(
      Array.from({ length: 65 }, () => fetch(`${endpoint}/api/v1/search?q=example`)),
    );
    expect(responses.some((response) => response.status === 429)).toBe(true);
  });
});
