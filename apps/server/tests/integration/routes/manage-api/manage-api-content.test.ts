// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";
process.env.DB_DRIVER = "postgres";

let allow = true;
let canManageLocks = false;
const createContentEntry = vi.fn(async () => ({ status: 201, body: { id: "c-new" } }));
const lockViolationsForWrite = vi.fn(async () => [{ id: "hero", type: "core.heading", rule: "remove" }]);
const applyDraftUpdate = vi.fn(async (_row: unknown, _patch: unknown, _actor: unknown, res: { json: (b: unknown) => void }) =>
  res.json({ ok: true }),
);

vi.mock("../../../../src/lib/auth/api-keys.js", () => ({
  keyCan: async (_key: unknown, _owner: unknown, capability: string) =>
    capability === "content:locks:manage" ? canManageLocks : allow,
}));
vi.mock("../../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    query: async () => [
      { id: "c1", type: "post", title: "One", slug: "one", locale: "en", status: "published", version: 1 },
      { id: "c2", type: "post", title: "Two", slug: "two", locale: "en", status: "draft", version: 1 },
    ],
    run: async () => undefined,
  }),
}));
vi.mock("../../../../src/lib/auth/access-policy.js", () => ({
  getEffectiveAccess: async () => ({ roleId: "administrator", capabilities: [], policy: { scopes: {} } }),
}));
vi.mock("../../../../src/lib/i18n/languages-db.js", () => ({
  resolveContentLocale: async (l: string) => l,
}));
vi.mock("../../../../src/lib/content/content-write.js", async (orig) => ({
  ...(await orig<typeof import("../../../../src/lib/content/content-write.js")>()),
  createContentEntry: (...args: unknown[]) => createContentEntry(...(args as [])),
  lockViolationsForWrite: (...args: unknown[]) => lockViolationsForWrite(...(args as [])),
  applyDraftUpdate: (...args: unknown[]) => applyDraftUpdate(...(args as [never, never, never, never])),
  saveWorkingRow: (...args: unknown[]) => applyDraftUpdate(...(args as [never, never, never, never])),
}));

const { default: router } = await import("../../../../src/routes/manage-api/content.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/manage/v1/content",
    (req, _res, next) => {
      req.apiKey = {
        id: "key-1",
        scope: {},
        allowedIps: [],
        allowedOrigins: [],
      } as never;
      req.apiKeyOwner = { userId: "u1", siteId: "s1", role: "administrator" };
      next();
    },
    router,
  );
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/manage/v1/content`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  allow = true;
  canManageLocks = false;
  createContentEntry.mockClear();
  lockViolationsForWrite.mockClear();
  applyDraftUpdate.mockClear();
});

describe("GET /api/manage/v1/content", () => {
  it("returns a cursor-paginated envelope within the key's scope", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; page: { total: number; nextCursor: unknown } };
    expect(body.data).toHaveLength(2);
    expect(body.page.total).toBe(2);
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("answers 304 when If-None-Match matches", async () => {
    const first = await fetch(base);
    const etag = first.headers.get("etag")!;
    const second = await fetch(base, { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
  });

  it("is 403 Forbidden when the key is out of scope", async () => {
    allow = false;
    const res = await fetch(base);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});

describe("POST /api/manage/v1/content", () => {
  it("relays the shared service result", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "post", title: "Hello" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "c-new" });
    expect(createContentEntry).toHaveBeenCalledOnce();
  });

  it("is 403 when the key lacks content:create", async () => {
    allow = false;
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "post", title: "Hello" }),
    });
    expect(res.status).toBe(403);
    expect(createContentEntry).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/manage/v1/content/:id block locks", () => {
  const patch = (body: Record<string, unknown>) =>
    fetch(`${base}/c2`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("refuses a key without content:locks:manage that breaks a lock", async () => {
    const res = await patch({ blocks: { version: 1, blocks: [] } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "block_locked", violations: [{ id: "hero", rule: "remove" }] });
    expect(applyDraftUpdate).not.toHaveBeenCalled();
  });

  it("skips the lock check for a key that can manage locks", async () => {
    canManageLocks = true;
    const res = await patch({ blocks: { version: 1, blocks: [] } });
    expect(res.status).toBe(200);
    expect(lockViolationsForWrite).not.toHaveBeenCalled();
  });

  it("skips the lock check when blocks are not written", async () => {
    const res = await patch({ title: "Renamed" });
    expect(res.status).toBe(200);
    expect(lockViolationsForWrite).not.toHaveBeenCalled();
  });
});
