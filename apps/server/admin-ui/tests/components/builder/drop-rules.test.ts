import { describe, expect, it } from "vitest";
import { evaluateDrop, type DropRegion } from "../../../src/components/builder/drop-rules";
import type { BlockCatalogEntry, BlockNode } from "../../../src/components/builder/types";

const catalog = new Map<string, BlockCatalogEntry>(
  [
    { type: "core.section", supportsChildren: true },
    { type: "core.columns", supportsChildren: true },
    { type: "core.column", supportsChildren: true },
    { type: "core.paragraph", supportsChildren: false },
  ].map((e) => [e.type, { version: 1, title: e.type, category: "layout", ...e } as BlockCatalogEntry]),
);

const blocks: BlockNode[] = [
  {
    id: "s",
    type: "core.section",
    version: 1,
    props: {},
    children: [{ id: "inner", type: "core.section", version: 1, props: {}, children: [{ id: "p", type: "core.paragraph", version: 1, props: {} }] }],
  },
];
const headerBlocks: BlockNode[] = [{ id: "h", type: "core.paragraph", version: 1, props: {} }];
const both = new Set<DropRegion>(["body", "header"]);
const bodyOnly = new Set<DropRegion>(["body"]);
const run = (source: { type: string; blockId: string | null }, target: { region?: DropRegion; parentId: string | null; parentType: string | null }, regions = both) =>
  evaluateDrop({ source, target: { region: "body", index: 0, ...target }, blocks, headerBlocks, catalog, regions });

describe("evaluateDrop", () => {
  it("accepts a valid insert and a valid move", () => {
    expect(run({ type: "core.paragraph", blockId: null }, { parentId: "s", parentType: "core.section" })).toEqual({ ok: true });
    expect(run({ type: "core.paragraph", blockId: "p" }, { parentId: null, parentType: null })).toEqual({ ok: true });
  });

  it("refuses invalid nesting", () => {
    expect(run({ type: "core.column", blockId: null }, { parentId: "s", parentType: "core.section" })).toEqual({ ok: false, reason: "nesting" });
    expect(run({ type: "core.paragraph", blockId: null }, { parentId: "p", parentType: "core.paragraph" })).toEqual({ ok: false, reason: "nesting" });
  });

  it("refuses dropping a block onto itself or into its own contents", () => {
    expect(run({ type: "core.section", blockId: "s" }, { parentId: "s", parentType: "core.section" })).toEqual({ ok: false, reason: "self" });
    expect(run({ type: "core.section", blockId: "s" }, { parentId: "inner", parentType: "core.section" })).toEqual({ ok: false, reason: "descendant" });
  });

  it("allows header and body moves only when both regions are edited", () => {
    expect(run({ type: "core.paragraph", blockId: "h" }, { parentId: "s", parentType: "core.section" })).toEqual({ ok: true });
    expect(run({ type: "core.paragraph", blockId: "p" }, { region: "header", parentId: null, parentType: null })).toEqual({ ok: true });
    expect(run({ type: "core.paragraph", blockId: "p" }, { region: "header", parentId: null, parentType: null }, bodyOnly)).toEqual({ ok: false, reason: "region" });
    expect(run({ type: "core.paragraph", blockId: "h" }, { parentId: "s", parentType: "core.section" }, bodyOnly)).toEqual({ ok: false, reason: "region" });
  });

  it("refuses a block that no longer exists", () => {
    expect(run({ type: "core.paragraph", blockId: "gone" }, { parentId: null, parentType: null })).toEqual({ ok: false, reason: "missing" });
  });
});
