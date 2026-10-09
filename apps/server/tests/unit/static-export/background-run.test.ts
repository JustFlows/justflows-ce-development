// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTenant } from "../../../src/lib/tenancy/context.js";
import router from "../../../src/routes/system/static-export.js";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../src/middleware/auth.js", () => ({
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireInstallationRoot: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../src/lib/tenancy/access.js", () => ({ isInstallationRootRequest: () => true }));
vi.mock("../../../src/lib/static-export/index.js", () => ({
  runStaticExport: mocks.run,
  getStaticExportStatus: async () => ({ hasExport: false }),
  clearStaticExport: vi.fn(),
}));
vi.mock("../../../src/lib/static-export/config.js", () => ({
  assertExportOrigin: (value: string) => {
    if (!value.startsWith("http://localhost")) throw Error("bad origin");
  },
  noteListenerPort: vi.fn(),
  siteLoopbackOrigin: () => "http://localhost:3000",
}));
let server: Server;
let origin: string;
let complete: (value: unknown) => void;
const summary = { ok: true, pages: 1, assets: 0, errors: [] };
beforeEach(async () => {
  mocks.run.mockImplementation(({ log }) => {
    log("Crawling");
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) =>
    runWithTenant(
      {
        tenantId: "t",
        siteId: req.get("x-test-site") ?? "site-a",
        hostname: "demo.localhost",
        userMode: "isolated",
        databaseMode: "current",
        activePluginIds: null,
      },
      next,
    ),
  );
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  complete?.(summary);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.clearAllMocks();
});
async function start() {
  return fetch(`${origin}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ async: true }),
  });
}
describe("background admin export", () => {
  it("returns 202 before export finishes, exposes progress only to its site, then reports completion", async () => {
    const response = await start();
    expect(response.status).toBe(202);
    const { jobId } = await response.json();
    const status = await (await fetch(`${origin}/status`)).json();
    expect(status.job).toMatchObject({ id: jobId, state: "running", log: ["Crawling"] });
    const foreign = await (
      await fetch(`${origin}/status`, { headers: { "x-test-site": "site-b" } })
    ).json();
    expect(foreign.job).toBeNull();
    expect((await start()).status).toBe(409);
    complete(summary);
    const done = await (await fetch(`${origin}/status`)).json();
    expect(done.job).toMatchObject({ id: jobId, state: "completed", summary });
  });
  it("preserves synchronous clients", async () => {
    mocks.run.mockResolvedValueOnce(summary);
    const response = await fetch(`${origin}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, summary });
  });
  it("rejects invalid crawl origins before starting a job", async () => {
    const response = await fetch(`${origin}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ async: true, baseUrl: "https://evil.example" }),
    });
    expect(response.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
