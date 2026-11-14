// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";

/** `/api/style-presets` (justflows-ce#301): roles, validation, publish and audit. */

let role = "editor";
const audits: unknown[] = [];
type StoredPreset = { id: string; name: string; style: Record<string, unknown> };
const store: { items: StoredPreset[]; published: StoredPreset[]; hasDraft: boolean } = {
  items: [{ id: "card", name: "Card", style: { radius: "md" } }],
  published: [{ id: "card", name: "Card", style: { radius: "md" } }],
  hasDraft: false,
};

vi.mock("../../../../src/middleware/auth.js", () => ({
  requireRole:
    (...roles: string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      req.session = { siteId: "s1", userId: "u1", role } as never;
      if (!roles.includes(role)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
}));
vi.mock("../../../../src/lib/themes/themes-db.js", () => ({ getSiteId: async () => "s1" }));
vi.mock("../../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: async () => {} }));
vi.mock("../../../../src/lib/security/audit-log.js", () => ({ auditLog: async (entry: unknown) => void audits.push(entry) }));
vi.mock("../../../../src/lib/themes/style-presets.js", () => ({
  listStylePresets: async (_s: string, opts?: { draft?: boolean }) => (opts?.draft ? store.items : store.published),
  stylePresetsHaveDraft: async () => store.hasDraft,
  saveStylePreset: async (_s: string, input: { id: string; name: string; style: Record<string, unknown> }) => {
    store.items = [...store.items.filter((p) => p.id !== input.id), input];
    store.hasDraft = true;
    return input;
  },
  deleteStylePreset: async (_s: string, id: string) => {
    store.items = store.items.filter((p) => p.id !== id);
    store.hasDraft = true;
  },
  publishStylePresets: async () => {
    store.published = store.items;
    store.hasDraft = false;
    return store.published;
  },
  discardStylePresetDraft: async () => {
    store.items = store.published;
    store.hasDraft = false;
  },
  stylePresetUsage: async (_s: string, id: string) => ({ content: { page: id === "card" ? 2 : 0 }, templateParts: [], templates: [], reusableBlocks: 0, patterns: 0, total: id === "card" ? 2 : 0 }),
}));

const { default: router } = await import("../../../../src/routes/design/style-presets.js");

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/style-presets", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/style-presets`;
});
afterAll(() => new Promise((r) => server.close(() => r(null))));
beforeEach(() => {
  role = "editor";
  audits.length = 0;
});

const call = (path: string, method = "GET", body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

describe("GET /api/style-presets", () => {
  it("lists the draft and published presets for content roles", async () => {
    role = "contributor";
    const res = await call("");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ id: "card" }], published: [{ id: "card" }], hasDraft: false });
  });
});

describe("PUT /api/style-presets", () => {
  it("refuses authors and invalid ids, and saves a valid preset as a draft", async () => {
    role = "author";
    expect((await call("", "PUT", { id: "hero", name: "Hero", style: {} })).status).toBe(403);
    role = "editor";
    expect((await call("", "PUT", { id: "Hero!", name: "Hero", style: {} })).status).toBe(400);
    const res = await call("", "PUT", { id: "hero", name: "Hero", style: { padTop: "7" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ item: { id: "hero", name: "Hero", style: { padTop: "7" } } });
    expect((await (await call("")).json()).hasDraft).toBe(true);
  });
});

describe("publish, discard, usage", () => {
  it("publishes the draft and writes an audit entry", async () => {
    const res = await call("/publish", "POST");
    expect(res.status).toBe(200);
    expect((await res.json()).hasDraft).toBe(false);
    expect(audits).toEqual([expect.objectContaining({ action: "design.presets_published", actorId: "u1", target: "style-presets" })]);
  });

  it("reports where a preset is used and 404s an invalid id", async () => {
    expect(await (await call("/card/usage")).json()).toMatchObject({ total: 2 });
    expect((await call("/Bad%20id/usage")).status).toBe(404);
  });

  it("discards the draft", async () => {
    await call("", "PUT", { id: "tmp", name: "Tmp", style: {} });
    const res = await call("/discard", "POST");
    expect((await res.json()).items.map((p: { id: string }) => p.id)).not.toContain("tmp");
  });
});
