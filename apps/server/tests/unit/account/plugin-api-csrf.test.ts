// SPDX-License-Identifier: MIT
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
const mocks = vi.hoisted(() => ({ public: vi.fn(), match: vi.fn(), csrf: vi.fn() }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ ensurePluginRuntime: async () => undefined, getPluginLoader: () => ({ httpRouter: { isPublicApiPath: mocks.public, match: mocks.match } }) }));
vi.mock("../../../src/middleware/csrf.js", () => ({ csrfProtection: mocks.csrf }));
vi.mock("../../../src/middleware/install-guard.js", () => ({ isInstalled: () => true }));
import { pluginApiCsrf } from "../../../src/middleware/plugin-api-csrf.js";
beforeEach(() => vi.clearAllMocks());
describe("neutral API CSRF delegation", () => {
  it("delegates a registered alias to the plugin policy", async () => {
    mocks.public.mockReturnValue(true); mocks.match.mockReturnValue({ route: { csrf: false } });
    const next = vi.fn();
    await pluginApiCsrf({ originalUrl: "/api/shop/payments/hooks?x=1", method: "POST" } as Request, {} as Response, next);
    expect(next).toHaveBeenCalledOnce(); expect(mocks.csrf).not.toHaveBeenCalled();
    expect(mocks.match).toHaveBeenCalledWith("POST", "/api/shop/payments/hooks");
  });
  it.each([false, true])("keeps the core guard for an unmatched API, namespace=%s", async publicPath => {
    mocks.public.mockReturnValue(publicPath); mocks.match.mockReturnValue(undefined);
    const next = vi.fn(); const req = { originalUrl: "/api/users", method: "POST" } as Request;
    await pluginApiCsrf(req, {} as Response, next); expect(mocks.csrf).toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  });
});
