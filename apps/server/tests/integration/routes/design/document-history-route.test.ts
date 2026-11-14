import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const listed: unknown[][] = [];

vi.mock("../../../../src/middleware/auth.js", () => ({
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../../../../src/lib/themes/themes-db.js", () => ({
  getSiteId: async () => "site-1",
  getActiveTheme: async () => ({ theme_id: "acme.theme" }),
}));
vi.mock("../../../../src/lib/rendering/document-history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/lib/rendering/document-history.js")>();
  return {
    ...actual,
    listDocumentHistory: async (...args: unknown[]) => {
      listed.push(args);
      return [{ id: "h1", revision: 2, state: "draft", createdAt: "2026-11-13T10:00:00Z", createdBy: null, createdByName: null }];
    },
    getDocumentHistoryDoc: async (_site: string, _kind: string, _key: string, id: string) =>
      id === "h1" ? { version: 1, blocks: [] } : null,
  };
});

const { default: historyRoutes } = await import("../../../../src/routes/design/document-history.js");

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/api/document-history", historyRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(() => r(null))));

describe("GET /api/document-history", () => {
  it("lists a template part's versions for the current site", async () => {
    const res = await fetch(`${base}/api/document-history?kind=template_part&key=footer`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(listed.at(-1)).toEqual(["site-1", "template_part", "footer"]);
  });

  it("scopes a template slug to the active theme", async () => {
    await fetch(`${base}/api/document-history?kind=theme_template&key=single`);
    expect(listed.at(-1)).toEqual(["site-1", "theme_template", "acme.theme/single"]);
  });

  it("rejects unknown kinds and malformed keys", async () => {
    expect((await fetch(`${base}/api/document-history?kind=users&key=footer`)).status).toBe(400);
    expect((await fetch(`${base}/api/document-history?kind=template_part&key=../x`)).status).toBe(400);
    expect((await fetch(`${base}/api/document-history?kind=theme_template&key=Bad%20Slug`)).status).toBe(400);
  });

  it("returns one version's document, or 404", async () => {
    const ok = await fetch(`${base}/api/document-history/h1?kind=template_part&key=footer`);
    expect(await ok.json()).toEqual({ doc: { version: 1, blocks: [] } });
    expect((await fetch(`${base}/api/document-history/nope?kind=template_part&key=footer`)).status).toBe(404);
  });
});
