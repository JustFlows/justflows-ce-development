import { describe, expect, it } from "vitest";
import {
  ancestorIds,
  blockSearchText,
  endZonesAfter,
  flattenTree,
  moveDestinations,
  planTreeMove,
  treeBadges,
} from "../../../src/components/builder/tree-ops";
import type { BlockCatalogEntry, BlockNode } from "../../../src/components/builder/types";

const catalog = new Map<string, BlockCatalogEntry>(
  [
    { type: "core.section", title: "Section", supportsChildren: true },
    { type: "core.columns", title: "Columns", supportsChildren: true },
    { type: "core.column", title: "Column", supportsChildren: true },
    { type: "core.paragraph", title: "Paragraph", supportsChildren: false },
    { type: "core.reusable", title: "Reusable", supportsChildren: false },
  ].map((e) => [e.type, { version: 1, category: "layout", ...e } as BlockCatalogEntry]),
);

const p = (id: string, text = id): BlockNode => ({ id, type: "core.paragraph", version: 1, props: { text } });
const doc: BlockNode[] = [
  { id: "s1", type: "core.section", version: 1, props: {}, children: [p("a"), p("b"), p("c")] },
  { id: "s2", type: "core.section", version: 1, props: {}, children: [] },
  {
    id: "cols",
    type: "core.columns",
    version: 1,
    props: {},
    children: [{ id: "col", type: "core.column", version: 1, props: {}, children: [p("deep", "<strong>Needle</strong> text")] }],
  },
];
const ids = (blocks: BlockNode[]): string[] => blocks.flatMap((b) => [b.id, ...ids(b.children ?? [])]);
const childIds = (blocks: BlockNode[], parent: string) =>
  (function find(list: BlockNode[]): string[] | null {
    for (const b of list) {
      if (b.id === parent) return (b.children ?? []).map((c) => c.id);
      const nested = find(b.children ?? []);
      if (nested) return nested;
    }
    return null;
  })(blocks);

describe("planTreeMove", () => {
  it("moves up and down among siblings, keeping every id", () => {
    const up = planTreeMove(doc, "b", "up", catalog);
    expect(up.ok && childIds(up.blocks, "s1")).toEqual(["b", "a", "c"]);
    const down = planTreeMove(doc, "b", "down", catalog);
    expect(down.ok && childIds(down.blocks, "s1")).toEqual(["a", "c", "b"]);
    expect(down.ok && down.index).toBe(2);
    expect(down.ok && ids(down.blocks).sort()).toEqual(ids(doc).sort());
  });

  it("refuses moving past either end", () => {
    expect(planTreeMove(doc, "a", "up", catalog)).toEqual({ ok: false, reason: "edge" });
    expect(planTreeMove(doc, "c", "down", catalog)).toEqual({ ok: false, reason: "edge" });
  });

  it("indents into the previous sibling and outdents after the parent", () => {
    const indent = planTreeMove(doc, "s2", "indent", catalog);
    expect(indent.ok && childIds(indent.blocks, "s1")).toEqual(["a", "b", "c", "s2"]);
    const outdent = planTreeMove(doc, "b", "outdent", catalog);
    expect(outdent.ok && outdent.blocks.map((b) => b.id)).toEqual(["s1", "b", "s2", "cols"]);
  });

  it("applies the canvas nesting rules", () => {
    expect(planTreeMove(doc, "b", "indent", catalog)).toMatchObject({ ok: false, reason: "nesting", parentType: "core.paragraph" });
    expect(planTreeMove(doc, "col", "outdent", catalog)).toMatchObject({ ok: false, reason: "nesting" });
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(doc);
    planTreeMove(doc, "b", "outdent", catalog);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("moveDestinations", () => {
  it("offers only valid containers and never the block's own subtree or current parent", () => {
    expect(moveDestinations(doc, "a", catalog).map((d) => d.parentId)).toEqual([null, "s2", "col"]);
    expect(moveDestinations(doc, "cols", catalog).map((d) => d.parentId)).toEqual(["s1", "s2"]);
  });
});

describe("flattenTree", () => {
  const label = (n: BlockNode) => catalog.get(n.type)?.title ?? n.type;

  it("shows only expanded branches with ARIA positions", () => {
    const rows = flattenTree(doc, new Set(["s1"]), "", label);
    expect(rows.map((r) => r.node.id)).toEqual(["s1", "a", "b", "c", "s2", "cols"]);
    expect(rows[2]).toMatchObject({ depth: 2, position: 2, setSize: 3, parentId: "s1" });
    expect(rows.find((r) => r.node.id === "cols")).toMatchObject({ hasChildren: true, expanded: false });
  });

  it("reveals a match inside a collapsed branch, including content text", () => {
    const rows = flattenTree(doc, new Set(), "needle", label);
    expect(rows.map((r) => r.node.id)).toEqual(["cols", "col", "deep"]);
    expect(rows.filter((r) => r.match).map((r) => r.node.id)).toEqual(["deep"]);
  });

  it("matches editor labels", () => {
    const labelled = [{ ...p("x"), editor: { label: "Pricing intro" } }];
    expect(flattenTree(labelled, new Set(), "pricing", label).map((r) => r.node.id)).toEqual(["x"]);
  });
});

describe("helpers", () => {
  it("lists ancestors outermost first", () => {
    expect(ancestorIds(doc, "deep")).toEqual(["cols", "col"]);
  });

  it("strips markup from searchable text", () => {
    expect(blockSearchText(p("z", "<em>Hi</em> there"))).toBe("Hi there");
  });

  it("flags reusable, hidden, locked, and unavailable blocks", () => {
    expect(treeBadges({ id: "r", type: "core.reusable", version: 1, props: {} }, catalog)).toEqual(["reusable"]);
    expect(treeBadges({ ...p("h"), props: { devices: ["mobile"] }, editor: { lock: { move: true } } }, catalog)).toEqual(["hidden", "locked"]);
    expect(treeBadges({ id: "u", type: "acme.gone", version: 1, props: {} }, catalog)).toEqual(["unavailable"]);
  });
});

describe("endZonesAfter", () => {
  const label = (n: BlockNode) => n.type;
  it("closes every level that ends after a row, innermost first", () => {
    const rows = flattenTree(doc, new Set(["s1", "cols", "col"]), "", label);
    const order = rows.map((r) => r.node.id);
    const zones = (id: string) => (endZonesAfter(rows).get(order.indexOf(id)) ?? []).map((z) => `${z.parentId}:${z.index}`);
    expect(zones("c")).toEqual(["s1:3"]);
    expect(zones("deep")).toEqual(["col:1", "cols:1", "null:3"]);
    expect(zones("s1")).toEqual([]);
  });
});
