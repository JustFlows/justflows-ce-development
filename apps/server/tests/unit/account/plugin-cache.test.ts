// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ ensurePluginRuntime: async () => undefined, getPluginLoader: () => ({ httpRouter: { match: () => ({ route: { pluginId: "example", handler: mocks.handler }, params: {} }) } }) }));
vi.mock("../../../src/lib/auth/auth-session.js", () => ({ resolveSession: async () => null }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ getActiveLocaleCodes: async () => ["en"], getDefaultLocale: async () => "en" }));
import { dispatchPluginHttp } from "../../../src/lib/plugins/plugin-http.js";
import { accountCacheMiddleware } from "../../../src/middleware/account-cache.js";
let server: Server; let base: string;
beforeAll(async () => {
  const app = express(); app.use(accountCacheMiddleware); app.use(dispatchPluginHttp);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
describe("plugin account response cache policy", () => {
  it.each([200, 401])("overrides a plugin's public headers on status %s", async (status) => {
    mocks.handler.mockResolvedValue({ status, body: { private: true }, headers: { "Cache-Control": "public, max-age=86400", "CDN-Cache-Control": "public", "Surrogate-Control": "max-age=86400" } });
    const res = await fetch(`${base}/api/example/account`);
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("surrogate-control")).toBe("no-store");
  });
});
