// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authenticated: false, status: "published", render: vi.fn() }));
vi.mock("@justflows/core", async original => ({ ...await original<typeof import("@justflows/core")>(), loadConfig: () => ({ cache: { driver: "memory", enabled: true } }) }));
vi.mock("../../../src/lib/account/pages.js", () => ({ accountPages: async () => [{ url: "/members/", aliases: ["/old-account"], content: { id: "page-a", siteId: "site-a", type: "account", slug: "members", locale: "en", status: mocks.status } }] }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => "site-a" }));
vi.mock("../../../src/lib/admin/admin-path.js", () => ({ getAdminPathConfig: async () => ({ path: "/control-room" }) }));
vi.mock("../../../src/middleware/auth.js", () => ({ optionalSession: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  if (mocks.authenticated) req.session = { userId: "user-a", siteId: "site-a", email: "a@example.com", role: "subscriber", iat: 0 }; next();
} }));
vi.mock("../../../src/lib/auth/auth-session.js", () => ({ isPreviewAllowed: async () => false }));
vi.mock("../../../src/middleware/security-headers.js", () => ({ securityHeaders: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../../src/routes/public/public-site.js", () => ({ renderSinglePageHtml: mocks.render }));
import { accountPagesRouter } from "../../../src/routes/public/account-pages.js";
import { getJfCache } from "../../../src/lib/cache/jf-cache.js";
let server: Server; let base: string;
beforeAll(async () => {
  const app = express(); app.use(accountPagesRouter); app.use((_req, res) => res.send("public static fallback"));
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => {
  vi.clearAllMocks(); mocks.authenticated = false; mocks.status = "published";
  mocks.render.mockImplementation(async () => {
    expect(getJfCache().enabled).toBe(false);
    return '<html><head></head><body>Customized page</body></html>';
  });
});
describe("private pages by content type", () => {
  it("protects renamed URLs before any static/cache fallback", async () => {
    const res = await fetch(base + "/members", { redirect: "manual" });
    expect(res.status).toBe(302); expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.render).not.toHaveBeenCalled();
  });
  it("renders the editable content with an authenticated user and cache bypass", async () => {
    mocks.authenticated = true; const res = await fetch(base + "/members/");
    expect(res.status).toBe(200); expect(await res.text()).toContain("Customized page");
    expect(res.headers.get("surrogate-control")).toBe("no-store");
    expect(mocks.render.mock.calls[0]?.[9]).toMatchObject({ type: "account", id: "page-a" });
    expect(getJfCache().enabled).toBe(true);
  });
  it("does not expose drafts to ordinary account users", async () => {
    mocks.authenticated = true; mocks.status = "draft";
    const res = await fetch(base + "/members"); expect(res.status).toBe(404); expect(mocks.render).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("keeps paginated account URLs private and passes their page number to rendering", async () => {
    mocks.authenticated = true;
    const res = await fetch(base + "/members/page/2"); expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.render.mock.calls[0]?.[7]).toBe(2);
  });
  it("redirects prior account URLs without caching the redirect", async () => {
    mocks.authenticated = true;
    const res = await fetch(base + "/old-account", { redirect: "manual" });
    expect(res.status).toBe(302); expect(res.headers.get("location")).toBe("/members/");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("preserves public pages and the configured admin path", async () => {
    expect(await (await fetch(base + "/about")).text()).toBe("public static fallback");
    expect(await (await fetch(base + "/control-room")).text()).toBe("public static fallback");
  });
});
