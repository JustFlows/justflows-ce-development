import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateBlockDocument, BLOCK_NODE_KEYS } from "@justflows/blocks";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import { BuilderDragProvider, useBuilderDrag } from "../../../src/components/builder/DragContext";
import DropZone from "../../../src/components/builder/DropZone";
import type { BlockCatalogEntry, BlockNode } from "../../../src/components/builder/types";

const catalog = new Map<string, BlockCatalogEntry>(
  [
    { type: "core.section", title: "Section", supportsChildren: true },
    { type: "core.columns", title: "Columns", supportsChildren: true },
    { type: "core.column", title: "Column", supportsChildren: true },
    { type: "core.paragraph", title: "Paragraph", supportsChildren: false },
  ].map((e) => [e.type, { version: 1, category: "layout", ...e } as BlockCatalogEntry]),
);

const doc = (): BlockNode[] => [
  { id: "a", type: "core.section", version: 1, props: {}, children: [{ id: "a1", type: "core.paragraph", version: 1, props: { text: "one" } }] },
  { id: "b", type: "core.section", version: 1, props: {}, children: [] },
];

let api: ReturnType<typeof useBuilderDrag>;
function Capture() {
  api = useBuilderDrag();
  return null;
}

function setup(blocks = doc()) {
  const onChange = vi.fn();
  const onSelect = vi.fn();
  render(
    <I18nProvider>
      <BuilderDragProvider blocks={blocks} catalog={catalog} onChange={onChange} onSelect={onSelect}>
        <Capture />
        <DropZone parentId="b" parentType="core.section" index={0} catalog={catalog} />
      </BuilderDragProvider>
    </I18nProvider>,
  );
  return { onChange, onSelect };
}

function ids(blocks: BlockNode[]): string[] {
  return blocks.flatMap((b) => [b.id, ...ids(b.children ?? [])]);
}

describe("canvas drag and drop", () => {
  afterEach(() => vi.useRealTimers());

  it("moves a block into another container as one change, keeping ids and order", () => {
    const { onChange, onSelect } = setup();
    act(() => {
      api.startPointerMove("a1", "core.paragraph");
      api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 });
    });
    act(() => api.commitPointerMove());
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]![0] as BlockNode[];
    expect(ids(next)).toEqual(["a", "b", "a1"]);
    expect(onSelect).toHaveBeenCalledWith("a1");
    expect(screen.getByText("Moved Paragraph.")).toBeInTheDocument();
  });

  it("never saves canvas state into the document", () => {
    const { onChange } = setup();
    act(() => {
      api.startPointerMove("a1", "core.paragraph");
      api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 });
    });
    act(() => api.commitPointerMove());
    const next = onChange.mock.calls[0]![0] as BlockNode[];
    expect(validateBlockDocument(next)).toEqual([]);
    const keys = new Set(next.flatMap(function walk(b: BlockNode): string[] {
      return [...Object.keys(b), ...(b.children ?? []).flatMap(walk)];
    }));
    for (const key of keys) expect(BLOCK_NODE_KEYS as readonly string[]).toContain(key);
  });

  it("refuses an invalid drop without changing anything and says why", () => {
    const { onChange } = setup();
    act(() => {
      api.startLibraryPointerDrag("core.column");
      api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 });
    });
    act(() => api.commitPointerMove());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Column can't go inside Section.")).toBeInTheDocument();
  });

  it("refuses moving a container into its own contents", () => {
    const blocks: BlockNode[] = [
      { id: "outer", type: "core.section", version: 1, props: {}, children: [{ id: "b", type: "core.section", version: 1, props: {}, children: [] }] },
    ];
    const { onChange } = setup(blocks);
    act(() => {
      api.startPointerMove("outer", "core.section");
      api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 });
    });
    act(() => api.commitPointerMove());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("A block can't be moved inside its own contents.")).toBeInTheDocument();
  });

  it("cancels without changing anything", () => {
    const { onChange } = setup();
    act(() => {
      api.startPointerMove("a1", "core.paragraph");
      api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 });
    });
    act(() => api.cancelDrag());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Move cancelled. Nothing changed.")).toBeInTheDocument();
  });

  it("inserts a library block by pointer (touch) into a valid container", () => {
    const { onChange, onSelect } = setup();
    act(() => {
      api.startLibraryPointerDrag("core.paragraph");
      api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 });
    });
    act(() => api.commitPointerMove());
    const next = onChange.mock.calls[0]![0] as BlockNode[];
    expect(next[1]!.children).toHaveLength(1);
    expect(next[1]!.children![0]!.type).toBe("core.paragraph");
    expect(onSelect).toHaveBeenCalledWith(next[1]!.children![0]!.id);
  });

  it("shows drop zones as unavailable, refused, or active before the drop", () => {
    setup();
    const zone = () => document.querySelector("[data-drop-zone]") as HTMLElement;
    act(() => api.startLibraryPointerDrag("core.column"));
    expect(zone().dataset.dropState).toBe("unavailable");
    act(() => api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 }));
    expect(zone().dataset.dropState).toBe("refused");
    expect(zone()).toHaveTextContent("Column can't go inside Section.");
    act(() => api.cancelDrag());
    act(() => {
      api.startLibraryPointerDrag("core.paragraph");
      api.setDropTarget({ parentId: "b", parentType: "core.section", index: 0 });
    });
    expect(zone().dataset.dropState).toBe("active");
    expect(zone()).toHaveTextContent("Release to add Paragraph here");
  });
});
