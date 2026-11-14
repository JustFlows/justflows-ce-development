import { describe, expect, it } from "vitest";
import {
  actionStates,
  duplicateBlocks,
  extendSelection,
  groupBlocks,
  pasteTarget,
  removeBlocks,
  resetBlockStyles,
  siblingSet,
  ungroupBlock,
} from "../../../src/components/builder/block-actions";
import type { BlockCatalogEntry, BlockNode } from "../../../src/components/builder/types";

const catalog = new Map<string, BlockCatalogEntry>(
  [
    { type: "core.section", title: "Section", supportsChildren: true },
    { type: "core.group", title: "Group", supportsChildren: true },
    { type: "core.columns", title: "Columns", supportsChildren: true, allowedChildTypes: ["core.column"] },
    { type: "core.column", title: "Column", supportsChildren: true },
    { type: "core.paragraph", title: "Paragraph", supportsChildren: false },
    { type: "core.reusable", title: "Reusable", supportsChildren: false },
  ].map((e) => [e.type, { version: 1, category: "layout", ...e } as BlockCatalogEntry]),
);

const p = (id: string, extra: Partial<BlockNode> = {}): BlockNode => ({
  id,
  type: "core.paragraph",
  version: 1,
  props: { text: id },
  ...extra,
});
const doc = (): BlockNode[] => [
  { id: "s1", type: "core.section", version: 1, props: {}, children: [p("a"), p("b"), p("c")] },
  { id: "s2", type: "core.section", version: 1, props: {}, children: [p("d")] },
  {
    id: "cols",
    type: "core.columns",
    version: 1,
    props: {},
    children: [{ id: "col", type: "core.column", version: 1, props: {}, children: [] }],
  },
];
const counter = () => {
  let n = 0;
  return () => `new${++n}`;
};
const ids = (blocks: BlockNode[]): string[] => blocks.flatMap((b) => [b.id, ...ids(b.children ?? [])]);
const children = (blocks: BlockNode[], id: string): string[] => {
  for (const b of blocks) {
    if (b.id === id) return (b.children ?? []).map((c) => c.id);
    const nested = children(b.children ?? [], id);
    if (nested.length) return nested;
  }
  return [];
};

describe("selection", () => {
  it("groups siblings in document order", () => {
    expect(siblingSet(doc(), ["c", "a"])).toMatchObject({ parentId: "s1", ids: ["a", "c"], indices: [0, 2] });
    expect(siblingSet(doc(), ["a", "d"])).toBeNull();
  });

  it("toggles siblings and refuses a block under another parent", () => {
    let sel = extendSelection(doc(), ["a"], "a", "c", "toggle");
    expect(sel).toEqual({ ids: ["a", "c"], anchor: "c" });
    sel = extendSelection(doc(), sel.ids, sel.anchor, "a", "toggle");
    expect(sel.ids).toEqual(["c"]);
    expect(extendSelection(doc(), ["a"], "a", "d", "toggle")).toMatchObject({ ids: ["a"], refused: "parent" });
  });

  it("selects a sibling range from the anchor", () => {
    expect(extendSelection(doc(), ["a"], "a", "c", "range")).toEqual({ ids: ["a", "b", "c"], anchor: "a" });
    expect(extendSelection(doc(), ["c"], "c", "a", "range").ids).toEqual(["a", "b", "c"]);
  });

  it("refuses a block from another region", () => {
    expect(extendSelection(doc(), ["a"], "a", "header-logo", "toggle")).toMatchObject({ refused: "context" });
  });
});

describe("operations", () => {
  it("duplicates after the last selected block with fresh ids and no locks", () => {
    const blocks = doc();
    blocks[0]!.children![0] = p("a", { editor: { label: "Intro", lock: { remove: true } } });
    const out = duplicateBlocks(blocks, ["a", "b"], counter())!;
    expect(children(out.blocks, "s1")).toEqual(["a", "b", "new1", "new2", "c"]);
    expect(out.ids).toEqual(["new1", "new2"]);
    const copy = out.blocks[0]!.children![2]!;
    expect(copy.editor).toEqual({ label: "Intro" });
    expect(copy.props).not.toBe(blocks[0]!.children![0]!.props);
  });

  it("removes several blocks at once", () => {
    expect(children(removeBlocks(doc(), ["a", "c"]), "s1")).toEqual(["b"]);
  });

  it("groups siblings in place and ungroups back to the same order", () => {
    const grouped = groupBlocks(doc(), ["c", "b"], counter())!;
    expect(children(grouped.blocks, "s1")).toEqual(["a", "new1"]);
    expect(children(grouped.blocks, "new1")).toEqual(["b", "c"]);
    const back = ungroupBlock(grouped.blocks, "new1")!;
    expect(children(back.blocks, "s1")).toEqual(["a", "b", "c"]);
    expect(back.ids).toEqual(["b", "c"]);
  });

  it("resets generic style but keeps a schema-owned style variant", () => {
    const blocks: BlockNode[] = [
      p("x", { props: { text: "x", style: { padTop: "md" }, styleRef: "card", breakpoints: { mobile: {} } } }),
      { id: "w", type: "plugin.widget", version: 1, props: { style: "compact" } },
    ];
    const out = resetBlockStyles(blocks, ["x", "w"]);
    expect(out[0]!.props).toEqual({ text: "x" });
    expect(out[1]!.props).toEqual({ style: "compact" });
  });

  it("pastes after the selection, into a selected container, or at the end", () => {
    const para = [p("z")];
    expect(pasteTarget(doc(), ["b"], para, catalog)).toEqual({ parentId: "s1", index: 2 });
    expect(pasteTarget(doc(), ["col"], para, catalog)).toEqual({ parentId: "col", index: 0 });
    expect(pasteTarget(doc(), [], para, catalog)).toEqual({ parentId: null, index: 3 });
    const column = [{ id: "c2", type: "core.column", version: 1, props: {} }];
    expect(pasteTarget(doc(), ["col"], column, catalog)).toEqual({ parentId: "cols", index: 1 });
    expect(pasteTarget(doc(), ["a"], column, catalog)).toBeNull();
  });

  it("keeps every id in the document unique after duplicating", () => {
    const out = duplicateBlocks(doc(), ["s1"], counter())!;
    const all = ids(out.blocks);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("actionStates", () => {
  const ctx = (blocks: BlockNode[], selection: string[], extra = {}) =>
    actionStates({ blocks, selection, catalog, hasClipboard: false, canSaveLibrary: true, librarySaves: true, ...extra });

  it("explains a selection across parents", () => {
    const states = ctx(doc(), ["a", "d"]);
    expect(states.delete).toEqual({ ok: false, reason: "mixedParents" });
    expect(states.group).toEqual({ ok: false, reason: "mixedParents" });
  });

  it("blocks delete and cut when a block or a descendant is remove-locked", () => {
    const blocks = doc();
    blocks[0]!.children![1] = p("b", { editor: { lock: { remove: true } } });
    expect(ctx(blocks, ["s1"]).delete).toEqual({ ok: false, reason: "lockedRemove" });
    expect(ctx(blocks, ["s1"]).cut).toEqual({ ok: false, reason: "lockedRemove" });
    expect(ctx(blocks, ["s1"]).copy).toEqual({ ok: true });
    expect(ctx(blocks, ["s1"]).duplicate).toEqual({ ok: true });
    expect(ctx(blocks, ["s1"]).saveReusable).toEqual({ ok: false, reason: "lockedRemove" });
    expect(ctx(blocks, ["s1"]).savePattern).toEqual({ ok: true });
  });

  it("blocks grouping move-locked blocks and resetting edit-locked ones", () => {
    const blocks = doc();
    blocks[0]!.children![0] = p("a", { props: { text: "a", style: { padTop: "md" } }, editor: { lock: { move: true, edit: true } } });
    const states = ctx(blocks, ["a", "b"]);
    expect(states.group).toEqual({ ok: false, reason: "lockedMove" });
    expect(states.resetStyle).toEqual({ ok: false, reason: "lockedEdit" });
  });

  it("refuses grouping where a group may not sit, and ungrouping non-wrappers", () => {
    expect(ctx(doc(), ["col"]).group).toEqual({ ok: false, reason: "nesting" });
    expect(ctx(doc(), ["a"]).ungroup).toEqual({ ok: false, reason: "notGroup" });
    expect(ctx(doc(), ["a"]).resetStyle).toEqual({ ok: false, reason: "noStyle" });
  });

  it("reports clipboard and library permission state", () => {
    expect(ctx(doc(), ["a"]).paste).toEqual({ ok: false, reason: "clipboardEmpty" });
    expect(ctx(doc(), ["a"], { hasClipboard: true }).paste).toEqual({ ok: true });
    expect(ctx(doc(), ["a"], { canSaveLibrary: false }).saveReusable).toEqual({ ok: false, reason: "permission" });
  });
});
