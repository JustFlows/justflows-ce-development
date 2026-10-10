// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ rules: vi.fn(), session: vi.fn(), bypass: vi.fn(fn => fn()) }));
vi.mock("../../../src/lib/cache/content-type-cache.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/lib/cache/content-type-cache.js")>(), contentCacheRules: mocks.rules }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => "site-a" }));
vi.mock("../../../src/lib/admin/admin-path.js", () => ({ getAdminPathConfig: async () => ({ path: "/manage" }) }));
vi.mock("../../../src/lib/auth/session.js", () => ({ getSession: mocks.session }));
vi.mock("../../../src/lib/cache/jf-cache.js", () => ({ withoutSharedCache: mocks.bypass }));
import { contentTypeCacheMiddleware } from "../../../src/middleware/content-type-cache.js";

describe("content type cache middleware", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.session.mockReturnValue(null); mocks.rules.mockResolvedValue([{ id: "1", paths: ["/profile"], header: "public, max-age=60", shared: true, ttl: 60 }]); });
  async function run(query = {}, session = false) {
    if (session) mocks.session.mockReturnValue({ userId: "owner" });
    const req = { path: "/profile", method: "GET", query } as unknown as Request;
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
});
