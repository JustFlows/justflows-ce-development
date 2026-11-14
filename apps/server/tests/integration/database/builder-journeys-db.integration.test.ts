// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Builder 2.0 journeys on a real database (justflows-ce#310).
 *
 * The real content, reusable block and template part routes run against
 * PostgreSQL, MySQL or MariaDB, with the real document limits and the
 * read-time block upgrade in front of them. Only sign-in, permission checks
 * and plugin hooks are stubbed; those have their own tests
 * (tests/integration/security). Each journey is what an author does in the
 * builder, checked down to what the published page renders.
 *
 *   BUILDER_TEST_DATABASE=1 DB_NAME=builder_test DB_DRIVER=postgres|mysql|mariadb \
 *   pnpm vitest run tests/integration/database/builder-journeys-db.integration.test.ts
 */
const enabled = process.env.BUILDER_TEST_DATABASE === "1" && process.env.DB_NAME === "builder_test";

const ids = vi.hoisted(() => ({ siteId: "", userId: "" }));

vi.mock("../../../src/middleware/auth.js", () => {
  const sign = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.session = { siteId: ids.siteId, userId: ids.userId, role: "administrator", email: "author@example.test", iat: 0 } as never;
    next();
  };
  return { requireSession: sign, requireRole: () => sign, requireCapability: () => sign };
});
/** Every permission except managing locks, so the lock rules apply to this author. */
vi.mock("../../../src/lib/auth/access-policy.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/auth/access-policy.js")>()),
  userCan: async (_session: unknown, capability: string) => capability !== "content:locks:manage",
}));
vi.mock("../../../src/lib/settings/site-settings.js", async (original) => ({
  ...(await original<typeof import("../../../src/lib/settings/site-settings.js")>()),
  getSiteId: async () => ids.siteId,
}));
vi.mock("../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: async () => {} }));

const { getDb } = await import("../../../src/lib/database/db.js");
const { runAllMigrations } = await import("../../../src/lib/database/run-migrations.js");
const { ensureContentTypesTable } = await import("../../../src/lib/content/content-types-db.js");
const { rejectOversizedDocuments } = await import("../../../src/lib/rendering/block-document-limits.js");
const { upgradeBlocksOnRead } = await import("../../../src/lib/rendering/editor-block-upgrade.js");
const { getRuntimeBlockRegistry, pluginBlockAdapter } = await import("../../../src/lib/rendering/runtime-blocks.js");
const { listReusableBlocks, resolveReusableBlocks } = await import("../../../src/lib/rendering/reusable-blocks.js");
const { escapeHtml } = await import("@justflows/sdk");

type Json = Record<string, unknown>;

let server: Server;
let base = "";

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
};

/** What the published page renders for stored blocks, with reusable blocks resolved as on the site. */
async function publicHtml(blocks: unknown[]): Promise<string> {
  const library = new Map((await listReusableBlocks(ids.siteId)).map((item) => [item.id, item]));
  const resolved = resolveReusableBlocks(blocks as never, library as never, 0, { preview: false });
  return getRuntimeBlockRegistry().renderDocument({ blocks: resolved } as never);
}

const page = () => ({
  version: 1,
  blocks: [
    {
      id: "hero",
      type: "core.section",
      version: 1,
      props: {
        containerLayout: { display: "grid", columns: 3, gap: "4" },
        breakpoints: { mobile: { containerLayout: { columns: 1 } } },
        style: { padTop: "6" },
      },
      children: [
        { id: "title", type: "core.heading", version: 1, props: { level: 2, text: "Plans" }, editor: { label: "Main title" } },
        { id: "intro", type: "core.paragraph", version: 1, props: { text: "Pick a <strong>plan</strong>." } },
        { id: "cta", type: "core.button", version: 1, props: { label: "Start", url: "/start" }, editor: { lock: { remove: true } } },
      ],
    },
    { id: "shared", type: "core.reusable", version: 1, props: { ref: "promo" } },
  ],
});

describe.skipIf(!enabled)("builder journeys on a real database", () => {
  beforeAll(async () => {
    const db = await getDb();
    await runAllMigrations(db, process.env.DB_DRIVER as never);
    await ensureContentTypesTable();
    const tenantId = randomUUID();
    ids.siteId = randomUUID();
    ids.userId = randomUUID();
    await db.run("INSERT INTO tenants (id, slug, name, status) VALUES (?, ?, ?, 'active')", [tenantId, `t-${tenantId}`, "Journeys"]);
    await db.run("INSERT INTO sites (id, tenant_id, name, url) VALUES (?, ?, ?, ?)", [ids.siteId, tenantId, "Journeys", `https://${ids.siteId}.example`]);
    await db.run("INSERT INTO users (id, site_id, email, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, 'administrator')", [
      ids.userId, ids.siteId, "author@example.test", `author-${ids.userId.slice(0, 6)}`, "Author", "x",
    ]);

    const content = (await import("../../../src/routes/content/content.js")).default;
    const reusable = await import("../../../src/routes/content/reusable-blocks.js");
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api/content", rejectOversizedDocuments, upgradeBlocksOnRead, content);
    app.use("/api/reusable-blocks", rejectOversizedDocuments, upgradeBlocksOnRead, reusable.default);
    app.use("/api/template-parts", rejectOversizedDocuments, upgradeBlocksOnRead, reusable.templatePartsRouter);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await (await getDb()).close();
  });

  let pageId = "";

  it("builds a page with layout, responsive values, labels, locks and a linked reusable block, keeping every id", async () => {
    expect((await call("PUT", "/api/reusable-blocks", { id: "promo", name: "Promo", blocks: [{ id: "p1", type: "core.paragraph", version: 1, props: { text: "Spring sale" } }] })).status).toBe(200);
    const created = await call("POST", "/api/content", { type: "page", title: "Pricing", blocks: page() });
    expect(created.status).toBe(201);
    pageId = String(created.body.id);
    const loaded = await call("GET", `/api/content/${pageId}`);
    expect(loaded.status).toBe(200);
    const doc = loaded.body.blocks as { blocks: Array<Json & { children?: Json[] }> };
    expect(doc.blocks.map((b) => b.id)).toEqual(["hero", "shared"]);
    expect(doc.blocks[0]!.children!.map((b) => b.id)).toEqual(["title", "intro", "cta"]);
    expect(doc.blocks[0]!.children![0]).toMatchObject({ editor: { label: "Main title" } });
    expect(doc.blocks[0]!.props).toMatchObject({ containerLayout: { display: "grid", columns: 3 } });
  });

  it("saves drafts with version checks and refuses a stale save without writing", async () => {
    const before = await call("GET", `/api/content/${pageId}`);
    const version = Number(before.body.version);
    const edited = page();
    edited.blocks[0]!.children![1]!.props = { text: "Pick the right plan." };
    const saved = await call("PATCH", `/api/content/${pageId}`, { blocks: edited, expectedVersion: version, source: "autosave" });
    expect(saved.status).toBe(200);
    const stale = await call("PATCH", `/api/content/${pageId}`, { blocks: page(), expectedVersion: version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("version_conflict");
    const after = await call("GET", `/api/content/${pageId}`);
    expect(JSON.stringify(after.body.blocks)).toContain("Pick the right plan.");
  });

  it("refuses to delete a locked block through a save", async () => {
    const current = await call("GET", `/api/content/${pageId}`);
    const doc = current.body.blocks as ReturnType<typeof page>;
    doc.blocks[0]!.children = doc.blocks[0]!.children!.filter((b) => b.id !== "cta");
    const res = await call("PATCH", `/api/content/${pageId}`, { blocks: doc, expectedVersion: Number(current.body.version) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("block_locked");
    expect(JSON.stringify((await call("GET", `/api/content/${pageId}`)).body.blocks)).toContain('"cta"');
  });

  it("publishes, and renders the layout, responsive rules, styles and the reusable block on the page", async () => {
    const current = await call("GET", `/api/content/${pageId}`);
    const published = await call("POST", `/api/content/${pageId}/publish`, { expectedVersion: Number(current.body.version) });
    expect(published.status).toBe(200);
    const live = (await call("GET", `/api/content/${pageId}`)).body;
    expect(live.status).toBe("published");
    const html = await publicHtml((live.blocks as { blocks: unknown[] }).blocks);
    expect(html).toContain("jf-cl-grid");
    expect(html).toMatch(/@media \(max-width: 600px\)\{\.jf-b-hero/);
    expect(html).toContain("padding-top:var(--space-6)");
    expect(html).toContain("Pick the right plan.");
    expect(html).toContain("Spring sale");
    expect(html).not.toContain("Main title");
  });

  it("keeps edits to a published page in a draft until they are published", async () => {
    const current = await call("GET", `/api/content/${pageId}`);
    const doc = current.body.blocks as ReturnType<typeof page>;
    doc.blocks[0]!.children![0]!.props = { level: 2, text: "New plans" };
    const saved = await call("PATCH", `/api/content/${pageId}`, {
      blocks: doc,
      expectedVersion: Number(current.body.version),
      expectedWorkingVersion: Number((current.body.workingRevision as Json | null)?.version ?? 0),
    });
    expect(saved.status).toBe(200);
    const reloaded = (await call("GET", `/api/content/${pageId}`)).body;
    expect(reloaded.hasWorkingRevision).toBe(true);
    expect(JSON.stringify(reloaded.blocks)).toContain("New plans");
    expect(JSON.stringify((reloaded.live as Json).blocks)).not.toContain("New plans");
  });

  it("lists revisions and restores an earlier one as the draft", async () => {
    const list = await call("GET", `/api/content/${pageId}/revisions`);
    expect(list.status).toBe(200);
    const items = (list.body.items ?? list.body.revisions) as Array<Json>;
    expect(items.length).toBeGreaterThan(0);
    const oldest = items[items.length - 1]!;
    const current = (await call("GET", `/api/content/${pageId}`)).body;
    const restored = await call("POST", `/api/content/${pageId}/revisions/${oldest.id}/restore`, {
      expectedVersion: Number(current.version),
      expectedWorkingVersion: Number((current.workingRevision as Json | null)?.version ?? 0),
    });
    expect(restored.status).toBe(200);
    const after = (await call("GET", `/api/content/${pageId}`)).body;
    expect(JSON.stringify(after.blocks)).not.toContain("New plans");
    expect(after.status).toBe("published");
  });

  it("keeps reusable block drafts off the page until published, and asks before deleting one in use", async () => {
    await call("PUT", "/api/reusable-blocks", { id: "promo", blocks: [{ id: "p1", type: "core.paragraph", version: 1, props: { text: "Summer sale" } }], draft: true, expectedRevision: 1 });
    const live = (await call("GET", `/api/content/${pageId}`)).body;
    expect(await publicHtml(((live.live ?? live) as { blocks: { blocks: unknown[] } }).blocks.blocks)).toContain("Spring sale");
    expect((await call("POST", "/api/reusable-blocks/promo/publish", { expectedRevision: 1 })).status).toBe(200);
    expect(await publicHtml(((live.live ?? live) as { blocks: { blocks: unknown[] } }).blocks.blocks)).toContain("Summer sale");
    const refused = await call("DELETE", "/api/reusable-blocks/promo");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("in_use");
  });

  it("edits the footer as a draft, publishes it, and refuses a stale save", async () => {
    const footer = { version: 1, blocks: [{ id: "f1", type: "core.paragraph", version: 1, props: { text: "© Journeys" } }] };
    const draft = await call("PUT", "/api/template-parts/footer", { blocks: footer.blocks, draft: true, expectedRevision: 0 });
    expect(draft.status).toBe(200);
    const revision = Number(draft.body.revision);
    const published = await call("PUT", "/api/template-parts/footer", { blocks: footer.blocks, expectedRevision: revision });
    expect(published.status).toBe(200);
    expect((await call("PUT", "/api/template-parts/footer", { blocks: footer.blocks, expectedRevision: revision })).status).toBe(409);
  });

  it("keeps a plugin block whose plugin is off, and upgrades it when the plugin is back", async () => {
    const stored = { version: 1, blocks: [{ id: "card", type: "acme.card", version: 1, props: { heading: "Old card" } }] };
    const created = await call("POST", "/api/content", { type: "page", title: "Cards", blocks: stored });
    const id = String(created.body.id);
    const off = (await call("GET", `/api/content/${id}`)).body;
    expect((off.blocks as { blocks: unknown[] }).blocks).toEqual(stored.blocks);
    await call("PATCH", `/api/content/${id}`, { title: "Cards (edited)", blocks: off.blocks, expectedVersion: Number(off.version) });
    expect(((await call("GET", `/api/content/${id}`)).body.blocks as { blocks: unknown[] }).blocks).toEqual(stored.blocks);

    pluginBlockAdapter().register({
      type: "acme.card",
      version: 2,
      title: "Card",
      schema: { title: { type: "text" } },
      migrations: [{ from: 1, to: 2, migrate: (p) => ({ title: p.heading }) }],
      validateProps: (raw) => ({ title: String((raw as Json)?.title ?? "") }),
      render: (p) => `<article class="acme-card">${escapeHtml(String(p.title))}</article>`,
    });
    try {
      const on = (await call("GET", `/api/content/${id}`)).body;
      expect((on.blocks as { blocks: Json[] }).blocks[0]).toMatchObject({ id: "card", version: 2, props: { title: "Old card" } });
      expect(await publicHtml(stored.blocks)).toContain('<article class="acme-card">Old card</article>');
    } finally {
      pluginBlockAdapter().unregister("acme.card");
    }
  });

  it("refuses an oversized document without storing it", async () => {
    let node: Json = { id: "leaf", type: "core.paragraph", version: 1, props: {} };
    for (let i = 0; i < 200; i++) node = { id: `g${i}`, type: "core.group", version: 1, props: {}, children: [node] };
    const res = await call("POST", "/api/content", { type: "page", title: "Too deep", blocks: { version: 1, blocks: [node] } });
    expect(res.status).toBe(413);
    const db = await getDb();
    expect(await db.query("SELECT id FROM content WHERE site_id = ? AND title = ?", [ids.siteId, "Too deep"])).toEqual([]);
  });
});
