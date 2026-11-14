import { describe, expect, it } from "vitest";
import { historyStepKey, insertBlock, moveBlock, removeBlock, updateBlockProps } from "../../../src/components/builder/block-tree";
import type { BlockNode } from "../../../src/components/builder/types";

const doc: BlockNode[] = [
  {
    id: "s",
    type: "core.section",
    version: 1,
    props: {},
    children: [
      { id: "p1", type: "core.paragraph", version: 1, props: { text: "a" } },
      { id: "p2", type: "core.paragraph", version: 1, props: { text: "b" } },
    ],
  },
];

describe("historyStepKey", () => {
  it("names the one block whose props changed", () => {
    expect(historyStepKey(doc, updateBlockProps(doc, "p2", { text: "bc" }))).toBe("props:p2");
  });

  it("treats moves, inserts, and removals as structural", () => {
    expect(historyStepKey(doc, moveBlock(doc, "p1", 1))).toBeNull();
    expect(historyStepKey(doc, removeBlock(doc, "p1"))).toBeNull();
    expect(historyStepKey(doc, insertBlock(doc, "s", 0, { id: "n", type: "core.paragraph", version: 1, props: {} }))).toBeNull();
  });

  it("treats a change to two blocks at once as its own step", () => {
    const both = updateBlockProps(updateBlockProps(doc, "p1", { text: "x" }), "p2", { text: "y" });
    expect(historyStepKey(doc, both)).toBeNull();
  });

  it("treats an unchanged document as nothing to coalesce", () => {
    expect(historyStepKey(doc, doc)).toBeNull();
  });
});
