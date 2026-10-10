// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
vi.mock("../../../src/lib/cache/performance-settings.js", () => ({ getPerformanceConfig: () => ({ browserCache: { enabled: true, htmlMaxAge: 86400 } }) }));
import { isAccountPath } from "../../../src/middleware/account-cache.js";
import { browserCacheMiddleware } from "../../../src/middleware/browser-cache.js";

describe("account caching", () => {
  it.each(["/account", "/account/", "/account/details", "/ACCOUNT", "/%61ccount", "/api/account", "/api/account/workspaces/id/limits", "/platform-account", "/api/platform-account", "/api/shop/account", "/api/shop/account/orders/1", "/ext/justflows.shop/account", "/ext/example/account/orders/1"])("always bypasses caching for %s, including mutations", (path) => {
    expect(isAccountPath(path)).toBe(true);
    const headers = new Map<string, string>(); const next = vi.fn();
    const res = { set: (values: Record<string, string>) => Object.entries(values).forEach(([key, value]) => headers.set(key, value)), vary: vi.fn() } as unknown as Response;
    browserCacheMiddleware({ path, method: "POST" } as Request, res, next);
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(headers.get("Surrogate-Control")).toBe("no-store");
    expect(next).toHaveBeenCalledOnce();
  });
  it.each(["/accounting", "/account.css", "/ext/example/accounting", "/catalog"])("preserves public path %s", (path) => expect(isAccountPath(path)).toBe(false));
});
