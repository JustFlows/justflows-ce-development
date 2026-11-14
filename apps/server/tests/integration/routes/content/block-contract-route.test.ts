// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { escapeHtml as esc, type PluginBlockDefinition } from "@justflows/sdk";
import {
  BlockContractError,
  canNestBlock,
  parseBlockClipboard,
  sanitizeBlockDocument,
  serializeBlockClipboard,
} from "@justflows/blocks";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";

/**
 * The Builder 2.0 block contract end to end (justflows-ce#305): a sample
 * third-party block written against `@justflows/sdk` types only, registered
 * through the host's plugin adapter, then used the way the builder and the
 * public renderer use it. Nothing here reaches into host internals.
 */

vi.mock("../../../../src/middleware/auth.js", () => ({
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const { pluginBlockAdapter, getRuntimeBlockRegistry } = await import("../../../../src/lib/rendering/runtime-blocks.js");
const { default: router } = await import("../../../../src/routes/content/blocks.js");
const { upgradeBlocksOnRead } = await import("../../../../src/lib/rendering/editor-block-upgrade.js");

/** Version 2 renamed `heading` to `title`; stored version-1 blocks are upgraded on render. */
const pricing: PluginBlockDefinition = {
  apiVersion: 1,
  type: "acme.pricing",
  version: 2,
  title: "Pricing card",
  description: "A plan with a price",
  icon: "€",
  category: "content",
  keywords: ["Plan", "price", "plan"],
  parents: ["$root", "core.section", "acme.grid"],
  schema: {
    title: { type: "text", default: "Plan" },
    price: { type: "text" },
    featured: { type: "boolean" },
  },
  defaults: { title: "Starter", price: "€9", injected: "<script>x</script>" },
  inline: { title: { mode: "rich", maxLength: 80 } },
  actions: [
    { id: "feature", label: "Mark as featured", props: { featured: true }, toolbar: true },
    { id: "Bad Id", label: "dropped", props: {} },
  ],
  preview: { sampleProps: { title: "Sample plan", price: "€0" }, minHeight: 120 },
  migrations: [{ from: 1, to: 2, migrate: (props) => ({ title: props.heading, price: props.price }) }],
  validateProps: (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      title: typeof r.title === "string" ? r.title.slice(0, 80) : "Plan",
      price: typeof r.price === "string" ? r.price.slice(0, 20) : "",
      featured: r.featured === true,
    };
  },
  render: (props) =>
    `<article class="acme-pricing${props.featured ? " acme-pricing--featured" : ""}"><h3 data-jf-inline="title">${esc(String(props.title))}</h3><p>${esc(String(props.price))}</p></article>`,
};

const grid: PluginBlockDefinition = {
  type: "acme.grid",
  version: 1,
  title: "Acme grid",
  schema: {},
  supportsChildren: true,
  supports: { containerLayout: { target: "acme-grid__items" } },
  validateProps: () => ({}),
  render: (_props, children = "") => `<div class="acme-grid"><div class="acme-grid__items">${children}</div></div>`,
};

const live: PluginBlockDefinition = {
  type: "acme.live",
  version: 1,
  title: "Live stock",
  schema: {},
  preview: { mode: "placeholder" },
  deprecated: { since: "2.0.0", replacedBy: "acme.pricing" },
  validateProps: () => ({}),
  render: () => "<p>live</p>",
};

let server: Server;
let base = "";
beforeAll(async () => {
  const adapter = pluginBlockAdapter();
  for (const def of [pricing, grid, live]) adapter.register(def);
  const app = express();
  app.use(express.json());
  app.use("/api/blocks", router);
  /** Stands in for a builder document route, such as GET /api/content/:id. */
  app.use("/api/doc", upgradeBlocksOnRead, (req, res) => {
    const doc = {
      id: "page-1",
      blocks: [{ id: "s", type: "core.section", version: 1, props: {}, children: [{ id: "p1", type: "acme.pricing", version: 1, props: { heading: "Old plan", price: "€1" } }] }],
      live: { blocks: [{ id: "p2", type: "acme.pricing", version: 2, props: { title: "Current", price: "€2" } }] },
      draft: [{ id: "p3", type: "acme.pricing", version: 1, props: { heading: "Draft plan" } }],
    };
    if (req.method === "GET") res.json(doc);
    else res.json(req.body);
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/blocks`;
});
afterAll(async () => {
  const adapter = pluginBlockAdapter();
  for (const def of [pricing, grid, live]) adapter.unregister(def.type);
  await new Promise((r) => server.close(() => r(null)));
});

const preview = (body: unknown) =>
  fetch(`${base}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("catalog", () => {
  it("serves the normalized contract, with defaults the block itself accepts", async () => {
    const { blocks } = (await (await fetch(base)).json()) as { blocks: Array<Record<string, unknown>> };
    const entry = blocks.find((b) => b.type === "acme.pricing")!;
    expect(entry).toMatchObject({
      apiVersion: 1,
      version: 2,
      keywords: ["plan", "price"],
      parents: ["$root", "core.section", "acme.grid"],
      defaults: { title: "Starter", price: "€9", featured: false },
      actions: [{ id: "feature", label: "Mark as featured", props: { featured: true }, toolbar: true }],
      preview: { mode: "server", minHeight: 120 },
      supports: { containerLayout: false },
      /** A plugin can only ever get plain inline fields. */
      inline: { title: { mode: "plain", maxLength: 80 } },
    });
    expect(JSON.stringify(entry)).not.toContain("<script");
    expect(blocks.find((b) => b.type === "acme.grid")).toMatchObject({ supports: { containerLayout: true } });
    expect(blocks.find((b) => b.type === "acme.live")).toMatchObject({ deprecated: { since: "2.0.0", replacedBy: "acme.pricing" }, preview: { mode: "placeholder" } });
  });
});

describe("preview", () => {
  it("fills unset props from sample props and upgrades an old stored version first", async () => {
    const fresh = (await (await preview({ type: "acme.pricing", props: {} })).json()) as { html: string };
    expect(fresh.html).toContain("Sample plan");
    const old = (await (await preview({ type: "acme.pricing", version: 1, props: { heading: "Legacy", price: "€5" } })).json()) as { html: string };
    expect(old.html).toContain(">Legacy<");
    expect(old.html).toContain("€5");
  });

  it("does not call render for a placeholder block, and 404s an unknown type", async () => {
    expect(await (await preview({ type: "acme.live", props: {} })).json()).toEqual({ html: "", placeholder: true });
    expect((await preview({ type: "acme.missing", props: {} })).status).toBe(404);
  });

  it("isolates a block whose render throws", async () => {
    const adapter = pluginBlockAdapter();
    adapter.register({ type: "acme.broken", version: 1, title: "Broken", schema: {}, validateProps: () => ({}), render: () => { throw new Error("boom"); } });
    expect((await preview({ type: "acme.broken", props: {} })).status).toBe(422);
    adapter.unregister("acme.broken");
  });
});

describe("documents", () => {
  const registry = getRuntimeBlockRegistry();
  const lookup = (type: string) => {
    const def = registry.get(type);
    return def ? { supportsChildren: def.supportsChildren, allowedChildTypes: def.allowedChildTypes, parents: registry.contractOf(type)?.parents } : undefined;
  };

  it("lets the block sit only where it says, with the shared nesting rule", () => {
    expect(canNestBlock(null, "acme.pricing", lookup)).toBe(true);
    expect(canNestBlock("acme.grid", "acme.pricing", lookup)).toBe(true);
    expect(canNestBlock("core.group", "acme.pricing", lookup)).toBe(false);
  });

  it("renders layout, responsive overrides, a preset and the inline marker on the public page", () => {
    const stored = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "g1",
          type: "acme.grid",
          version: 1,
          props: {
            containerLayout: { display: "grid", columns: 3, gap: "4" },
            breakpoints: { mobile: { containerLayout: { columns: 1 } } },
            styleRef: "card",
          },
          children: [
            { id: "p1", type: "acme.pricing", version: 1, props: { heading: "Old plan", price: "€1" } },
            { id: "p2", type: "acme.pricing", version: 2, props: { title: "New plan", price: "€2", style: { padTop: "4" } } },
          ],
        },
      ],
    });
    const html = registry.renderNode(stored.blocks[0] as never);
    expect(html).toContain('class="acme-grid__items jf-cl jf-cl-grid jf-cl-stack"');
    expect(html).toContain("@media (max-width: 600px){.jf-b-g1 > .acme-grid__items{grid-template-columns:repeat(1,minmax(0,1fr))");
    expect(html).toContain("jf-sp-card");
    expect(html).toContain(">Old plan<");
    expect(html).toContain('data-jf-inline="title"');
    expect(html).toContain("padding-top:var(--space-4)");
  });

  it("copies and pastes the block with a new id and its props intact", () => {
    const text = serializeBlockClipboard([{ id: "p1", type: "acme.pricing", version: 2, props: { title: "Pro", price: "€29" } }]);
    let n = 0;
    const parsed = parseBlockClipboard(text, () => `new-${++n}`);
    expect(parsed).toMatchObject({ ok: true, blocks: [{ id: "new-1", type: "acme.pricing", version: 2, props: { title: "Pro", price: "€29" } }] });
  });

  it("keeps escaping in the block's render even for values an action or default supplied", () => {
    const html = registry.renderNode({ type: "acme.pricing", props: { title: "<img src=x onerror=1>", price: "x" } } as never);
    expect(html).not.toContain("<img");
  });
});

describe("documents opened in the builder", () => {
  it("arrive with old plugin blocks upgraded, so edits are saved at the current version", async () => {
    const res = (await (await fetch(base.replace("/api/blocks", "/api/doc"))).json()) as {
      blocks: Array<{ children: Array<Record<string, unknown>> }>;
      live: { blocks: Array<Record<string, unknown>> };
      draft: Array<Record<string, unknown>>;
    };
    expect(res.blocks[0]!.children[0]).toEqual({ id: "p1", type: "acme.pricing", version: 2, props: { title: "Old plan", price: "€1" } });
    expect(res.live.blocks[0]).toMatchObject({ version: 2, props: { title: "Current" } });
    expect(res.draft[0]).toMatchObject({ version: 2, props: { title: "Draft plan" } });
  });

  it("leaves writes alone", async () => {
    const body = { blocks: [{ id: "p1", type: "acme.pricing", version: 1, props: { heading: "Old" } }] };
    const res = await fetch(base.replace("/api/blocks", "/api/doc"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(await res.json()).toEqual(body);
  });
});

describe("refused contracts", () => {
  it("refuses an unsupported apiVersion and an incomplete migration chain at registration", () => {
    const adapter = pluginBlockAdapter();
    const base = { schema: {}, title: "x", validateProps: () => ({}), render: () => "" };
    expect(() => adapter.register({ ...base, type: "acme.future", version: 1, apiVersion: 99 })).toThrow(BlockContractError);
    expect(() =>
      adapter.register({ ...base, type: "acme.gap", version: 3, migrations: [{ from: 2, to: 3, migrate: (p) => ({ ...p }) }] }),
    ).toThrow(/no migration from version 1/);
    expect(getRuntimeBlockRegistry().get("acme.future")).toBeUndefined();
  });

  it("ignores an unsafe layout target and forgets everything on unregister", () => {
    const adapter = pluginBlockAdapter();
    adapter.register({
      type: "acme.box",
      version: 1,
      title: "Box",
      schema: {},
      supportsChildren: true,
      supports: { containerLayout: { target: '"><script>' } },
      validateProps: () => ({}),
      render: (_p, children = "") => `<div class="acme-box">${children}</div>`,
    });
    const html = getRuntimeBlockRegistry().renderNode({ type: "acme.box", props: { containerLayout: { display: "flex" } }, children: [] } as never);
    expect(html).toMatch(/^<div class="acme-box jf-cl jf-cl-flex/);
    adapter.unregister("acme.box");
    expect(getRuntimeBlockRegistry().contractOf("acme.box")).toBeUndefined();
  });
});
