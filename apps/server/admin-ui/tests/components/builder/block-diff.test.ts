import { describe, expect, it } from "vitest";
import { isEmptySummary, summarizeBlockChanges } from "../../../src/components/builder/block-diff";
import type { BlockNode } from "../../../src/components/builder/types";

const p = (id: string, text = id, extra: Partial<BlockNode> = {}): BlockNode => ({ id, type: "core.paragraph", version: 1, props: { text }, ...extra });

describe("summarizeBlockChanges", () => {
  const current: BlockNode[] = [
    { id: "s", type: "core.section", version: 1, props: {}, children: [p("a"), p("b")] },
    p("c"),
  ];

  it("reports nothing for identical trees", () => {
    expect(isEmptySummary(summarizeBlockChanges(current, JSON.parse(JSON.stringify(current))))).toBe(true);
  });

  it("finds added, removed, changed, and moved blocks by id", () => {
    const version: BlockNode[] = [
      { id: "s", type: "core.section", version: 1, props: {}, children: [p("b"), p("a", "edited")] },
      p("d", "new", { editor: { label: "Intro" } }),
    ];
    const summary = summarizeBlockChanges(current, version);
    expect(summary.added).toEqual([{ id: "d", type: "core.paragraph", label: "Intro" }]);
    expect(summary.removed.map((b) => b.id)).toEqual(["c"]);
    expect(summary.changed.map((b) => b.id)).toEqual(["a"]);
    expect(summary.moved.map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("treats a changed editor label as a change", () => {
    const version = [current[0]!, p("c", "c", { editor: { label: "Renamed" } })];
    expect(summarizeBlockChanges(current, version).changed.map((b) => b.id)).toEqual(["c"]);
  });
});
