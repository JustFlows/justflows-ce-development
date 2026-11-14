import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";
process.env.STATE = "INSTALLED";

/**
 * Block locks are policy (justflows-ce#298): an author without
 * `content:locks:manage` cannot move, remove, or edit a locked block, or change
 * its locks, through any write path. Managers can.
 */

const SITE = "site-1";
const lockedHero = {
  id: "hero",
  type: "core.heading",
  version: 1,
  props: { text: "Welcome", level: 1 },
  editor: { lock: { move: true, remove: true, edit: true } },
};
const intro = { id: "intro", type: "core.paragraph", version: 1, props: { text: "Intro" } };
const LOCKED_DOC = [lockedHero, intro];
let contentRow: Record<string, unknown>;
let workingRows: Record<string, unknown>[];
let role = "author";
let oldRevisionBlocks: unknown[] | null = null;
const revisionWrites: string[] = [];

const fakeDb = {
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (/FROM content WHERE id = \? AND site_id = \?/i.test(sql)) return [contentRow] as unknown as T[];
    if (/FROM revisions/i.test(sql) && /working/i.test(sql)) return workingRows as unknown as T[];
    if (/FROM revisions/i.test(sql) && params.includes("rev-old")) {
      const blocks = oldRevisionBlocks ? JSON.stringify({ version: 1, blocks: oldRevisionBlocks }) : workingRows[0]?.blocks;
      return [{ ...workingRows[0], id: "rev-old", kind: "historical", version: 1, blocks }] as unknown as T[];
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
    (req as unknown as { session: unknown }).session = { siteId: SITE, userId: "user-1", role };
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
      blocks: JSON.stringify({ version: 1, blocks: LOCKED_DOC }),
      fields: "{}",
      version: 3,
      base_version: 4,
      created_at: now,
      updated_at: now,
    },
  ];
  revisionWrites.length = 0;
  role = "author";
  oldRevisionBlocks = null;
});

async function patch(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/content/page-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("block locks on content writes", () => {
  const doc = (blocks: unknown[]) => ({ version: 1, blocks });

  it("lets an author edit unlocked blocks around a locked one", async () => {
    const r = await patch({ blocks: doc([lockedHero, { ...intro, props: { text: "Changed" } }]) });
    expect(r.status).toBe(200);
  });

  it.each([
    ["remove", [intro]],
    ["move", [{ id: "wrap", type: "core.group", version: 1, props: {}, children: [lockedHero] }, intro]],
    ["edit", [{ ...lockedHero, props: { text: "Hacked", level: 1 } }, intro]],
    ["lock", [{ ...lockedHero, editor: {} }, intro]],
  ])("refuses an author's %s of a locked block and writes nothing", async (rule, blocks) => {
    const r = await patch({ blocks: doc(blocks), source: "autosave" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "block_locked", violations: [{ id: "hero", rule }] });
    expect(revisionWrites).toEqual([]);
  });

  it("lets an editor, who can manage locks, unlock and remove it", async () => {
    role = "editor";
    const r = await patch({ blocks: doc([intro]) });
    expect(r.status).toBe(200);
  });

  it("does not check locks when the blocks are not part of the write", async () => {
    const r = await patch({ title: "New title" });
    expect(r.status).toBe(200);
  });

  it("refuses restoring a revision that would drop a locked block", async () => {
    const res = await fetch(`${base}/api/content/page-1/revisions/rev-old/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    workingRows = [{ ...workingRows[0], blocks: JSON.stringify({ version: 1, blocks: [lockedHero] }) }];
    oldRevisionBlocks = [intro];
    const refused = await fetch(`${base}/api/content/page-1/revisions/rev-old/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "block_locked" });
  });
});
