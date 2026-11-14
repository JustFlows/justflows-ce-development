// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Builder 2.0 boundaries beyond roles (justflows-ce#309): oversized
 * documents, CSRF on the new write routes, safe errors, and redacted audit
 * events for site-wide design changes.
 */

const state = vi.hoisted(() => ({
  audits: [] as Array<{ action: string; extra: Record<string, unknown> }>,
  writes: 0,
  menuFails: false,
}));

vi.mock("../../../src/lib/auth/auth-session.js", () => ({
  resolveSession: async () => ({ siteId: "s1", userId: "u1", role: "administrator", email: "u@example.test" }),
  isPreviewAllowed: async () => false,
}));
vi.mock("../../../src/lib/auth/session.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/auth/session.js")>()),
  syncCsrfCookie: vi.fn(),
}));
vi.mock("../../../src/lib/tenancy/access.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/tenancy/access.js")>()),
  sessionMatchesRequestSite: () => true,
}));
vi.mock("../../../src/lib/security/audit-log.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/security/audit-log.js")>()),
  auditFromRequest: (_req: unknown, action: string, extra: Record<string, unknown> = {}) => state.audits.push({ action, extra }),
}));
vi.mock("../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: async () => {} }));
vi.mock("../../../src/lib/themes/themes-db.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/themes/themes-db.js")>()),
  getSiteId: async () => "s1",
}));
vi.mock("../../../src/lib/rendering/site-patterns.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/rendering/site-patterns.js")>()),
  saveSitePattern: async (_site: string, body: { id: string }) => {
    state.writes++;
    return { id: body.id, blocks: [{ secret: "page body" }] };
  },
  deleteSitePattern: async () => {
    state.writes++;
  },
  importPatternSet: async () => {
    state.writes++;
    return [{ id: "a" }, { id: "b" }];
  },
}));
vi.mock("../../../src/lib/rendering/widget-areas.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/rendering/widget-areas.js")>()),
  widgetAreaExists: async () => true,
  saveWidgetAreaDoc: async (_s: string, _k: string, doc: unknown) => {
    state.writes++;
    return doc;
  },
  saveWidgetLayout: async (_s: string, layout: unknown) => {
    state.writes++;
    return layout;
  },
}));
vi.mock("../../../src/lib/navigation/menus-db.js", async (original) => {
  const actual = await original<typeof import("../../../src/lib/navigation/menus-db.js")>();
  return {
  ...actual,
  getMenuBySlug: async () => ({ id: "m1", slug: "main", name: "Main", items: [], design: actual.parseMenuDesign(null), draftDesign: null }),
  updateMenu: async () => {
    if (state.menuFails) throw new Error("ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; host db-internal-7:3306");
    state.writes++;
    return { id: "m1", slug: "main", name: "Main", items: [] };
  },
  };
});

const { rejectOversizedDocuments } = await import("../../../src/lib/rendering/block-document-limits.js");
const { csrfProtection } = await import("../../../src/middleware/csrf.js");

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  /** The CSRF check guards the same paths the app does. */
  app.use("/csrf", csrfProtection, (_req, res) => res.json({ ok: true }));
  app.use("/api/patterns", rejectOversizedDocuments, (await import("../../../src/routes/design/patterns.js")).default);
  app.use("/api/widgets", rejectOversizedDocuments, (await import("../../../src/routes/design/widgets.js")).default);
  app.use("/api/menus", rejectOversizedDocuments, (await import("../../../src/routes/design/menus.js")).default);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  state.audits = [];
  state.writes = 0;
  state.menuFails = false;
});

const send = (method: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function nested(depth: number) {
  let node: Record<string, unknown> = { id: "leaf", type: "core.paragraph", version: 1, props: { text: "x" } };
  for (let i = 0; i < depth; i++) node = { id: `g${i}`, type: "core.group", version: 1, props: {}, children: [node] };
  return node;
}

describe("oversized documents", () => {
  it("are refused with 413 before anything is stored, wherever the blocks sit in the request", async () => {
    const deep = { version: 1, blocks: [nested(5000)] };
    const res = await send("PUT", "/api/widgets/areas/sidebar", { blocks: deep.blocks, draft: false });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "document_too_large" });
    const wide = Array.from({ length: 20_001 }, (_, i) => ({ id: `p${i}`, type: "core.paragraph", version: 1, props: {} }));
    expect((await send("PUT", "/api/patterns", { id: "big", title: "Big", blocks: wide })).status).toBe(413);
    expect(state.writes).toBe(0);
  });

  it("let normal documents through", async () => {
    const res = await send("PUT", "/api/widgets/areas/sidebar", { blocks: [nested(10)], draft: true });
    expect(res.status).not.toBe(413);
    expect(state.writes).toBe(1);
  });
});

describe("CSRF", () => {
  it("refuses a cookie-style write without the token header", async () => {
    expect((await send("POST", "/csrf/api/blocks/preview/batch", { items: [] })).status).toBe(403);
    expect((await send("PUT", "/csrf/api/style-presets", {})).status).toBe(403);
  });
});

describe("safe errors", () => {
  it("never sends database details to the browser", async () => {
    state.menuFails = true;
    const res = await send("PUT", "/api/menus/main", { items: [] });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/ER_LOCK|db-internal|Deadlock/);
  });

  it("names the problem for an invalid menu link", async () => {
    const res = await send("PUT", "/api/menus/main", { items: [{ id: "i1", type: "custom", label: "x", url: "javascript:alert(1)" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("javascript:");
  });
});

describe("audit events for site-wide design changes", () => {
  it("record publishing widgets, saving patterns and menus, without the content", async () => {
    await send("PUT", "/api/widgets/layout", { layout: {} });
    await send("PUT", "/api/widgets/areas/sidebar", { blocks: [], draft: false });
    await send("PUT", "/api/widgets/areas/sidebar", { blocks: [], draft: true });
    await send("PUT", "/api/patterns", { id: "hero", title: "Hero", blocks: [{ id: "a", type: "core.paragraph", version: 1, props: { text: "page body" } }] });
    const imported = await send("POST", "/api/patterns/import", { schemaVersion: 1, patterns: [{ id: "intro", title: "Intro", blocks: [{ id: "b1", type: "core.paragraph", version: 1, props: { text: "page body" } }] }] });
    await fetch(`${base}/api/patterns/hero`, { method: "DELETE" });
    await send("PUT", "/api/menus/main", { items: [] });
    await send("PUT", "/api/menus/main", { items: [], draft: true });
    const actions = state.audits.map((a) => `${a.action}:${a.extra.target ?? ""}`);
    expect(imported.status).toBe(200);
    expect(actions).toEqual(expect.arrayContaining([
      "design.widgets_published:layout",
      "design.widgets_published:sidebar",
      "design.patterns_changed:hero",
      "design.patterns_changed:import",
      "design.menu_saved:main",
    ]));
    /** Drafts are not site-wide changes yet, so they are not recorded. */
    expect(actions.filter((a) => a === "design.widgets_published:sidebar")).toHaveLength(1);
    expect(actions.filter((a) => a === "design.menu_saved:main")).toHaveLength(1);
    expect(JSON.stringify(state.audits)).not.toContain("page body");
  });
});
