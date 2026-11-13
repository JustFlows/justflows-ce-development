import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";
process.env.STATE = "INSTALLED";

/**
 * Two editors on one published page share its single draft revision. A save
 * or publish carrying a stale `expectedWorkingVersion` must be refused rather
 * than overwrite the other editor's draft (justflows-ce#302).
 */

const SITE = "site-1";
let contentRow: Record<string, unknown>;
let workingRows: Record<string, unknown>[];
const revisionWrites: string[] = [];

const fakeDb = {
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (/FROM content WHERE id = \? AND site_id = \?/i.test(sql)) return [contentRow] as unknown as T[];
    if (/FROM revisions/i.test(sql) && /working/i.test(sql)) return workingRows as unknown as T[];
    if (/FROM revisions/i.test(sql) && params.includes("rev-old")) {
      return [{ ...workingRows[0], id: "rev-old", kind: "historical", version: 1 }] as unknown as T[];
    }
    return [] as T[];
  },
  async run(sql: string): Promise<void> {
    if (/revisions/i.test(sql)) revisionWrites.push(sql);
  },
  async execute(sql: string): Promise<number> {
    if (/revisions/i.test(sql)) revisionWrites.push(sql);
    return 1;
  },
  async close() {},
};

vi.mock("../../../../src/lib/database/db.js", () => ({ getDb: async () => fakeDb, resetDb: () => {} }));
vi.mock("../../../../src/middleware/auth.js", () => ({
  requireCapability: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireSession: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../../../../src/lib/content/content-public.js", () => ({
  invalidateContentCache: async () => {},
  invalidateContentCacheForSlug: async () => {},
  overlayWorkingOnRow: (r: unknown) => r,
}));
vi.mock("../../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: async () => {} }));
vi.mock("../../../../src/lib/plugins/plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({
    dispatchAction: async () => {},
    dispatchGate: async () => {},
    applyFilter: async (_n: string, v: unknown) => v,
    has: () => false,
  }),
  ensurePluginRuntime: async () => {},
  getPluginLoader: () => null,
}));

const { default: contentRoutes } = await import("../../../../src/routes/content/content.js");

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { siteId: SITE, userId: "user-1", role: "administrator" };
    next();
  });
  app.use("/api/content", contentRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(() => r(null))));

const now = new Date().toISOString();

beforeEach(() => {
  contentRow = {
    id: "page-1",
    site_id: SITE,
    type: "page",
    locale: "en-US",
    title: "About",
    slug: "about",
    status: "published",
    version: 4,
    author_id: "user-1",
    blocks: JSON.stringify({ version: 1, blocks: [] }),
    fields: "{}",
    created_at: now,
    updated_at: now,
    published_at: now,
  };
  workingRows = [
    {
      id: "rev-1",
      content_id: "page-1",
      site_id: SITE,
      kind: "working",
      source: "manual",
      title: "About (draft by someone else)",
      slug: "about",
      blocks: JSON.stringify({ version: 1, blocks: [] }),
      fields: "{}",
      version: 3,
      base_version: 4,
      created_at: now,
      updated_at: now,
    },
  ];
  revisionWrites.length = 0;
});

async function patch(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/content/page-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("PATCH /api/content/:id draft concurrency", () => {
  it("refuses a draft save based on an older draft version and writes nothing", async () => {
    const r = await patch({ title: "Mine", expectedVersion: 4, expectedWorkingVersion: 2, source: "autosave" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "draft_conflict", expectedWorkingVersion: 2, actualWorkingVersion: 3 });
    expect(revisionWrites).toEqual([]);
  });

  it("refuses when the client saw no draft but another editor has started one", async () => {
    const r = await patch({ title: "Mine", expectedVersion: 4, expectedWorkingVersion: 0 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "draft_conflict", actualWorkingVersion: 3 });
  });

  it("refuses when the client saw a draft that has since been published or discarded", async () => {
    workingRows = [];
    const r = await patch({ title: "Mine", expectedVersion: 4, expectedWorkingVersion: 3 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "draft_conflict", actualWorkingVersion: 0 });
  });

  it("refuses to publish a stale draft", async () => {
    const r = await patch({ status: "published", expectedVersion: 4, expectedWorkingVersion: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("draft_conflict");
    expect(revisionWrites).toEqual([]);
  });

  it("labels a live version mismatch as a version conflict", async () => {
    const r = await patch({ title: "Mine", expectedVersion: 3 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "version_conflict", expectedVersion: 3, actualVersion: 4 });
  });

  it("saves when the client's draft version is current", async () => {
    const r = await patch({ title: "Mine", expectedVersion: 4, expectedWorkingVersion: 3, source: "autosave" });
    expect(r.status).toBe(200);
    expect(revisionWrites.some((sql) => /UPDATE revisions/i.test(sql))).toBe(true);
  });

  it("keeps working for clients that do not send a draft version", async () => {
    const r = await patch({ title: "Mine", expectedVersion: 4 });
    expect(r.status).toBe(200);
  });
});

describe("POST /api/content/:id/publish draft concurrency", () => {
  it("refuses to publish a draft that changed since the client loaded it", async () => {
    const res = await fetch(`${base}/api/content/page-1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 4, expectedWorkingVersion: 2 }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("draft_conflict");
    expect(revisionWrites).toEqual([]);
  });
});

describe("POST /api/content/:id/revisions/:revisionId/restore draft concurrency", () => {
  it("refuses to restore over a draft the client has not seen", async () => {
    const res = await fetch(`${base}/api/content/page-1/revisions/rev-old/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 4, expectedWorkingVersion: 1 }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("draft_conflict");
    expect(revisionWrites).toEqual([]);
  });

  it("refuses to restore when the live version moved on", async () => {
    const res = await fetch(`${base}/api/content/page-1/revisions/rev-old/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("version_conflict");
  });
});
