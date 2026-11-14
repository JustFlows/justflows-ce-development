import { describe, expect, it } from "vitest";
import { selectionCrumbs } from "../../../../src/components/builder/shell/breadcrumbs";
import type { BlockNode } from "../../../../src/components/builder/types";

const blocks: BlockNode[] = [
  {
    id: "s1",
    type: "core.section",
    version: 1,
    props: {},
    editor: { label: "Hero band" },
    children: [{ id: "p1", type: "core.paragraph", version: 1, props: {} }],
  },
];
const headerBlocks: BlockNode[] = [{ id: "h1", type: "core.button", version: 1, props: {} }];
const titles: Record<string, string> = { "core.section": "Section", "core.paragraph": "Paragraph", "core.button": "Button" };

function crumbs(selectedId: string | null, headerOnly = false) {
  return selectionCrumbs({
    selectedId,
    blocks,
    headerBlocks,
    headerSelectedId: "__header__",
    headerOnly,
    rootLabel: "Page",
    headerLabel: "Global header",
    typeLabel: (type) => titles[type],
  });
}

describe("selectionCrumbs", () => {
  it("is just the root with nothing selected", () => {
    expect(crumbs(null)).toEqual([{ id: null, label: "Page" }]);
  });

  it("lists every ancestor and prefers the editor label", () => {
    expect(crumbs("p1")).toEqual([
      { id: null, label: "Page" },
      { id: "s1", label: "Hero band" },
      { id: "p1", label: "Paragraph" },
    ]);
  });

  it("puts header blocks under the header region on a page", () => {
    expect(crumbs("h1").map((c) => c.label)).toEqual(["Page", "Global header", "Button"]);
  });

  it("treats the header as the root when editing it on its own", () => {
    expect(crumbs("h1", true).map((c) => c.label)).toEqual(["Page", "Button"]);
    expect(crumbs("__header__", true)).toEqual([{ id: null, label: "Page" }]);
  });

  it("falls back to the root for an id that is not in the document", () => {
    expect(crumbs("gone")).toEqual([{ id: null, label: "Page" }]);
  });
});
