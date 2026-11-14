// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Reusable blocks as drafted, published, safely nested documents (justflows-ce#304). */

const settings = new Map<string, unknown>();
const history: unknown[] = [];

vi.mock("../../../src/lib/settings/site-settings.js", () => ({
  getSiteSetting: async (_site: string, key: string) => settings.get(key) ?? null,
  updateSiteSettingAtomically: async (_site: string, key: string, mutate: (current: unknown) => unknown) => {
    const next = mutate(settings.get(key) ?? null);
    settings.set(key, next);
    return next;
  },
}));
vi.mock("../../../src/lib/rendering/document-history.js", () => ({
  recordDocumentHistory: async (entry: unknown) => void history.push(entry),
}));

const lib = await import("../../../src/lib/rendering/reusable-blocks.js");

const p = (id: string, text: string) => ({ id, type: "core.paragraph", version: 1, props: { text } });
const ref = (id: string, target: string) => ({ id, type: "core.reusable", version: 1, props: { ref: target } });

beforeEach(() => {
  settings.clear();
  history.length = 0;
});

describe("drafts and publish", () => {
  it("publishes a new block at once, then keeps rendering the published tree while a draft is edited", async () => {
    const created = await lib.saveReusableBlock("s", { id: "cta", name: "CTA", blocks: [p("a", "v1")] }, { draft: true });
    expect(created).toMatchObject({ id: "cta", revision: 1, blocks: [{ props: { text: "v1" } }] });
    expect(created.draft).toBeUndefined();

    const drafted = await lib.saveReusableBlock("s", { id: "cta", name: "CTA", blocks: [p("a", "v2")] }, { draft: true, expectedRevision: 1 });
    expect(drafted.blocks[0]!.props.text).toBe("v1");
    expect(drafted.draft?.blocks[0]!.props.text).toBe("v2");

    const library = new Map((await lib.listReusableBlocks("s")).map((item) => [item.id, item]));
    const page = [ref("r", "cta")];
    expect(lib.resolveReusableBlocks(page, library)[0]!.props.text).toBe("v1");
    expect(lib.resolveReusableBlocks(page, library, 0, { preview: true })[0]!.props.text).toBe("v2");

    const published = await lib.publishReusableDraft("s", "cta", { expectedRevision: 1 });
    expect(published).toMatchObject({ revision: 2, blocks: [{ props: { text: "v2" } }] });
    expect(published!.draft).toBeUndefined();
    expect(history.map((h) => (h as { state: string; revision: number }).state)).toEqual(["published", "draft", "published"]);
  });

  it("refuses a save based on an older revision", async () => {
    await lib.saveReusableBlock("s", { id: "cta", blocks: [p("a", "v1")] });
    await lib.saveReusableBlock("s", { id: "cta", blocks: [p("a", "v2")] });
    await expect(lib.saveReusableBlock("s", { id: "cta", blocks: [p("a", "v3")] }, { draft: true, expectedRevision: 1 })).rejects.toMatchObject({
      code: "revision_conflict",
    });
  });

  it("discards a draft, renames without touching the tree, and duplicates with fresh ids", async () => {
    await lib.saveReusableBlock("s", { id: "cta", name: "CTA", blocks: [p("a", "v1")] });
    await lib.saveReusableBlock("s", { id: "cta", blocks: [p("a", "v2")] }, { draft: true });
    await lib.discardReusableDraft("s", "cta");
    expect((await lib.getReusableBlock("s", "cta"))!.draft).toBeUndefined();

    const renamed = await lib.renameReusableBlock("s", "cta", "Call to action");
    expect(renamed).toMatchObject({ name: "Call to action", revision: 1, blocks: [{ props: { text: "v1" } }] });

    const copy = await lib.duplicateReusableBlock("s", "cta", "");
    expect(copy.id).not.toBe("cta");
    expect(copy.name).toBe("Call to action (copy)");
    expect(copy.blocks[0]!.id).not.toBe("a");
    expect(copy.blocks[0]!.props.text).toBe("v1");
  });
});

describe("nesting safety", () => {
  it("refuses a block that contains itself directly or through another", async () => {
    await lib.saveReusableBlock("s", { id: "a", blocks: [p("x", "a")] });
    await expect(lib.saveReusableBlock("s", { id: "a", blocks: [ref("r", "a")] })).rejects.toMatchObject({ code: "cycle" });
    await lib.saveReusableBlock("s", { id: "b", blocks: [ref("r1", "a")] });
    await expect(lib.saveReusableBlock("s", { id: "a", blocks: [ref("r2", "b")] }, { draft: true })).rejects.toMatchObject({ code: "cycle" });
  });

  it("refuses reference chains deeper than the limit", async () => {
    await lib.saveReusableBlock("s", { id: "l1", blocks: [p("x", "deepest")] });
    await lib.saveReusableBlock("s", { id: "l2", blocks: [ref("r", "l1")] });
    await lib.saveReusableBlock("s", { id: "l3", blocks: [ref("r", "l2")] });
    await lib.saveReusableBlock("s", { id: "l4", blocks: [ref("r", "l3")] });
    await expect(lib.saveReusableBlock("s", { id: "l5", blocks: [ref("r", "l4")] })).rejects.toMatchObject({ code: "too_deep" });
  });

  it("renders a stored cycle once instead of spinning, and a deleted source as nothing", () => {
    const library = new Map([
      ["a", { id: "a", name: "a", revision: 1, updatedAt: "", blocks: [p("x", "A"), ref("r", "b")] }],
      ["b", { id: "b", name: "b", revision: 1, updatedAt: "", blocks: [p("y", "B"), ref("r", "a")] }],
    ]);
    const out = lib.resolveReusableBlocks([ref("top", "a"), ref("gone", "deleted")], library as never);
    expect(out.map((b) => b.props.text)).toEqual(["A", "B"]);
  });

  it("keeps deeply nested ordinary content, which the old depth count dropped", () => {
    let tree = p("leaf", "deep") as unknown as { id: string; type: string; version: number; props: Record<string, unknown>; children?: unknown[] };
    for (let i = 0; i < 8; i++) tree = { id: `g${i}`, type: "core.group", version: 1, props: {}, children: [tree] };
    const out = lib.resolveReusableBlocks([tree as never], new Map());
    expect(JSON.stringify(out)).toContain('"deep"');
  });

  it("keeps blocks of unavailable plugin types inside a reusable block", async () => {
    const saved = await lib.saveReusableBlock("s", { id: "p", blocks: [{ id: "u", type: "acme.gone", version: 3, props: { a: 1 } }] });
    expect(saved.blocks[0]).toMatchObject({ type: "acme.gone", props: { a: 1 } });
  });
});
