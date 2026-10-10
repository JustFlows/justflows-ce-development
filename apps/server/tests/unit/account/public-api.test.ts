// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query: mocks.query }) }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => "site-a" }));
vi.mock("../../../src/lib/settings/site-visibility.js", () => ({ isSitePublic: async () => true, canViewUnpublishedSite: async () => true }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ resolveContentLocale: async () => "en", getDefaultLocale: async () => "en", getActiveLocaleCodes: async () => ["en"] }));
vi.mock("../../../src/lib/content/content-types-db.js", () => ({ listContentTypes: async () => [{ slug: "account", label: "Account" }, { slug: "page", label: "Page" }] }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({ has: () => false }) }));
import router from "../../../src/routes/public/public-api.js";
let server: Server; let base: string;
beforeAll(async () => {
  const app = express(); app.use(router);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mocks.query.mockImplementation(async sql => sql.includes("COUNT(") ? [{ total: 0 }] : []);
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
it("never exposes account content types or layouts through public APIs, including preview", async () => {
  const types = await (await fetch(base + "/content-types")).json() as { types: Array<{ slug: string }> };
  expect(types.types.map(type => type.slug)).toEqual(["page"]);
  expect((await fetch(base + "/content/account?preview=1")).status).toBe(404);
  await fetch(base + "/content?type=account&preview=1");
  const contentQueries = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("FROM content"));
  expect(contentQueries.length).toBeGreaterThan(0);
  for (const [sql] of contentQueries) expect(sql).toContain("type <> 'account'");
});
