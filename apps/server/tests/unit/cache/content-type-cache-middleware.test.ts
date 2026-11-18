// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ rules: vi.fn(), session: vi.fn(), bypass: vi.fn(fn => fn()) }));
/** The per-request lookup answers from `mocks.rules` through the real matcher. */
vi.mock("../../../src/lib/cache/content-type-cache.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../../src/lib/cache/content-type-cache.js")>();
  return {
    ...original,
    contentCacheRuleForRequest: async (_siteId: string, path: string, id?: string) => original.matchContentCacheRule(await mocks.rules(), path, id),
  };
});
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => "site-a" }));
vi.mock("../../../src/lib/admin/admin-path.js", () => ({ getAdminPathConfig: async () => ({ path: "/manage" }) }));
vi.mock("../../../src/lib/auth/session.js", () => ({ getSession: mocks.session }));
vi.mock("../../../src/lib/cache/jf-cache.js", () => ({ withoutSharedCache: mocks.bypass }));
import { contentTypeCacheMiddleware } from "../../../src/middleware/content-type-cache.js";

describe("content type cache middleware", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.session.mockReturnValue(null); mocks.rules.mockResolvedValue([{ id: "1", paths: ["/profile"], header: "public, max-age=60", shared: true, ttl: 60 }]); });
  async function run(query = {}, session = false, path = "/profile") {
    if (session) mocks.session.mockReturnValue({ userId: "owner" });
    const req = { path, method: "GET", query } as unknown as Request;
    const res = { locals: {}, setHeader: vi.fn(), vary: vi.fn() };
    const next = vi.fn();
    await contentTypeCacheMiddleware(req, res as unknown as Response, next);
    return { res, next };
  }
  it("overrides defaults and stale static files for public custom headers", async () => {
    const { res, next } = await run();
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=60");
    expect(res.locals).toMatchObject({ jfBypassStatic: true, jfContentCacheTtl: 60 });
    expect(next).toHaveBeenCalledWith();
    expect(mocks.bypass).not.toHaveBeenCalled();
  });
  it.each(["auth", "preview", "type"])("enforces private cache bypass for %s", async kind => {
    if (kind === "type") mocks.rules.mockResolvedValue([{ id: "1", paths: ["/profile"], header: "private, no-store", shared: false, ttl: 0 }]);
    const { res } = await run(kind === "preview" ? { preview: "1" } : {}, kind === "auth");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(res.setHeader).toHaveBeenCalledWith("CDN-Cache-Control", "no-store");
    expect(res.locals).toMatchObject({ jfBypassStatic: true, jfContentCacheBypass: true });
    expect(mocks.bypass).toHaveBeenCalledOnce();
  });
  it.each(["/vendor/katex/katex.min.css", "/placeholders/featured.svg", "/manifest.webmanifest"])(
    "leaves file %s to static serving for signed-in visitors",
    async path => {
      const { res, next } = await run({}, true, path);
      expect(res.locals).not.toHaveProperty("jfBypassStatic");
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith();
    },
  );
  it("still treats .html pages as pages", async () => {
    const { res } = await run({}, true, "/profile.html");
    expect(res.locals).toMatchObject({ jfBypassStatic: true });
  });
});
