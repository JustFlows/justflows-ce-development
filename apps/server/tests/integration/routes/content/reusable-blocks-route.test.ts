// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";

/** `/api/reusable-blocks` (justflows-ce#304): drafts, explicit publish, safe delete, usage. */

const settings = new Map<string, unknown>();
const audits: Array<{ action: string }> = [];
const revalidated: string[] = [];
let used = 0;
let role = "editor";

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
vi.mock("../../../../src/lib/themes/themes-db.js", () => ({
  getSiteId: async () => "s1",
  getActiveTheme: async () => null,
  themeInstalledPath: () => null,
}));
vi.mock("../../../../src/lib/settings/site-settings.js", () => ({
  getSiteSetting: async (_s: string, key: string) => settings.get(key) ?? null,
  updateSiteSettingAtomically: async (_s: string, key: string, mutate: (c: unknown) => unknown) => {
    const next = mutate(settings.get(key) ?? null);
    settings.set(key, next);
    return next;
  },
}));
vi.mock("../../../../src/lib/rendering/document-history.js", () => ({ recordDocumentHistory: async () => {} }));
vi.mock("../../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: async (what: string) => void revalidated.push(what) }));
vi.mock("../../../../src/lib/security/audit-log.js", () => ({ auditLog: async (entry: { action: string }) => void audits.push(entry) }));
vi.mock("../../../../src/lib/auth/access-policy.js", () => ({ getEffectiveAccess: async () => ({ capabilities: ["content:read"], policy: { scopes: {} } }) }));
vi.mock("../../../../src/lib/rendering/reusable-usage.js", () => ({
  reusableUsageFor: async () => ({ total: used, contentCount: used, content: [], hiddenContent: 0, templateParts: [], templates: [], menus: [], reusableBlocks: [], patterns: [], truncated: false }),
}));

const { default: router } = await import("../../../../src/routes/content/reusable-blocks.js");

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/reusable-blocks", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reusable-blocks`;
});
afterAll(() => new Promise((r) => server.close(() => r(null))));
beforeEach(() => {
  settings.clear();
  audits.length = 0;
  revalidated.length = 0;
  used = 0;
  role = "editor";
});

const call = (path: string, method = "GET", body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const para = (text: string) => [{ id: "p", type: "core.paragraph", version: 1, props: { text } }];

describe("draft and publish", () => {
  it("only changes what pages render after an explicit publish", async () => {
    await call("", "PUT", { id: "cta", name: "CTA", blocks: para("v1") });
    expect(revalidated).toEqual(["content"]);
    revalidated.length = 0;

    const drafted = await (await call("", "PUT", { id: "cta", blocks: para("v2"), draft: true, expectedRevision: 1 })).json();
    expect(drafted.item.blocks[0].props.text).toBe("v1");
    expect(drafted.item.draft.blocks[0].props.text).toBe("v2");
    expect(revalidated).toEqual([]);

    const published = await (await call("/cta/publish", "POST", { expectedRevision: 1 })).json();
    expect(published.item).toMatchObject({ revision: 2, blocks: [{ props: { text: "v2" } }] });
    expect(revalidated).toEqual(["content"]);
    expect(audits.map((a) => a.action)).toEqual(["design.reusable_published", "design.reusable_published"]);
    expect((await call("/cta/publish", "POST", {})).status).toBe(409);
  });

  it("refuses a stale revision and a cycle with a reason", async () => {
    await call("", "PUT", { id: "a", blocks: para("x") });
    await call("", "PUT", { id: "a", blocks: para("y") });
    const stale = await call("", "PUT", { id: "a", blocks: para("z"), draft: true, expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "revision_conflict" });
    const cycle = await call("", "PUT", { id: "a", blocks: [{ id: "r", type: "core.reusable", version: 1, props: { ref: "a" } }] });
    expect(cycle.status).toBe(400);
    expect(await cycle.json()).toMatchObject({ code: "cycle" });
  });

  it("is limited to the theme roles for writes", async () => {
    role = "author";
    expect((await call("", "PUT", { blocks: para("x") })).status).toBe(403);
    expect((await call("")).status).toBe(200);
  });
});

describe("delete", () => {
  it("refuses deleting a block that is still used unless confirmed", async () => {
    await call("", "PUT", { id: "cta", blocks: para("v1") });
    used = 3;
    const refused = await call("/cta", "DELETE");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "in_use", usage: { total: 3 } });
    expect((await call("/cta?confirm=1", "DELETE")).status).toBe(200);
    expect(audits.at(-1)!.action).toBe("design.reusable_deleted");
    expect((await call("/cta")).status).toBe(404);
  });
});

describe("rename and duplicate", () => {
  it("renames without publishing and duplicates into an independent entry", async () => {
    await call("", "PUT", { id: "cta", name: "CTA", blocks: para("v1") });
    const renamed = await (await call("/cta", "PATCH", { name: "Call to action" })).json();
    expect(renamed.item).toMatchObject({ name: "Call to action", revision: 1 });
    const copy = await (await call("/cta/duplicate", "POST", {})).json();
    expect(copy.item.id).not.toBe("cta");
    expect(copy.item.name).toBe("Call to action (copy)");
  });
});
