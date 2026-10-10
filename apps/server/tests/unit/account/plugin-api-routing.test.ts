// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PluginHttpRouter } from "@justflows/plugin-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ router: null as PluginHttpRouter | null, loaded: false, protected: vi.fn() }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  ensurePluginRuntime: async () => { mocks.loaded = true; },
  getPluginLoader: () => mocks.loaded ? { httpRouter: mocks.router } : null,
}));
vi.mock("../../../src/lib/auth/auth-session.js", () => ({ resolveSession: async () => null }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ getActiveLocaleCodes: async () => ["en"], getDefaultLocale: async () => "en" }));
vi.mock("../../../src/middleware/install-guard.js", () => ({ isInstalled: () => true }));
import { pluginApiCsrf } from "../../../src/middleware/plugin-api-csrf.js";
import { dispatchPluginHttp } from "../../../src/lib/plugins/plugin-http.js";
let server: Server; let base: string;
beforeAll(async () => {
  const router = new PluginHttpRouter(); router.setApiNamespace("justflows.shop", "shop"); mocks.router = router;
  router.register("justflows.shop", "POST", "payments/hooks/:token", async req => ({ body: { token: req.params.token, raw: req.rawBody } }), { csrf: false, rawBody: true });
  router.register("justflows.shop", "POST", "checkout", mocks.protected);
  const app = express();
  app.use(express.json({ verify: (req, _res, bytes) => { Object.assign(req, { rawBody: bytes.toString("utf8") }); } }));
  app.use("/api", pluginApiCsrf); app.use(dispatchPluginHttp);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
const post = (path: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: '{ "signed": true }' });
describe("neutral API dispatch", () => {
  it("accepts signed-webhook aliases on the first request and preserves raw JSON bytes", async () => {
    mocks.loaded = false;
    const alias = await post("/api/shop/payments/hooks/token"); expect(alias.status).toBe(200);
    const legacy = await post("/ext/justflows.shop/payments/hooks/token"); expect(legacy.status).toBe(200);
    expect(await alias.json()).toEqual(await legacy.json());
  });
  it("keeps ordinary plugin mutations and core APIs CSRF protected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await post("/api/shop/checkout")).status).toBe(403);
      expect((await post("/ext/justflows.shop/checkout")).status).toBe(403);
      expect((await post("/api/users")).status).toBe(403);
      expect(mocks.protected).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
