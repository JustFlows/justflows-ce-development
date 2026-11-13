import { useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import { BuilderDragProvider } from "../../../src/components/builder/DragContext";
import Navigator from "../../../src/components/builder/Navigator";
import type { BlockCatalogEntry, BlockNode } from "../../../src/components/builder/types";

const catalog = new Map<string, BlockCatalogEntry>(
  [
    { type: "core.section", title: "Section", supportsChildren: true },
    { type: "core.paragraph", title: "Paragraph", supportsChildren: false },
    { type: "core.reusable", title: "Reusable", supportsChildren: false },
  ].map((e) => [e.type, { version: 1, category: "layout", ...e } as BlockCatalogEntry]),
);

const p = (id: string, text = id): BlockNode => ({ id, type: "core.paragraph", version: 1, props: { text } });
const initial = (): BlockNode[] => [
  { id: "s1", type: "core.section", version: 1, props: {}, children: [p("a", "Alpha"), p("b", "Bravo")] },
  { id: "s2", type: "core.section", version: 1, props: {}, editor: { label: "Pricing" }, children: [p("deep", "Hidden needle")] },
  { id: "r", type: "core.reusable", version: 1, props: { devices: ["mobile"] } },
];

function Harness({ start = initial(), onChangeSpy = vi.fn(), initialSelected = null as string | null }) {
  const [blocks, setBlocks] = useState(start);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  return (
    <I18nProvider>
      <BuilderDragProvider blocks={blocks} catalog={catalog} onChange={setBlocks} onSelect={setSelected}>
        <Navigator
          blocks={blocks}
          catalog={catalog}
          selectedId={selected}
          onSelect={setSelected}
          onChange={(next) => {
            onChangeSpy(next);
            setBlocks(next);
          }}
        />
      </BuilderDragProvider>
    </I18nProvider>
  );
}

const ids = (blocks: BlockNode[]): string[] => blocks.flatMap((b) => [b.id, ...ids(b.children ?? [])]);

describe("Navigator", () => {
  it("renders an accessible tree with level, position, and expanded state", async () => {
    render(<Harness />);
    const tree = await screen.findByRole("tree", { name: "Layers" });
    const items = within(tree).getAllByRole("treeitem");
    expect(items[0]).toHaveAccessibleName("Section");
    expect(items[1]).toHaveAccessibleName("Pricing");
    expect(items[2]).toHaveAccessibleName(expect.stringContaining("Reusable"));
    expect(items[0]).toHaveAttribute("aria-level", "1");
    expect(items[0]).toHaveAttribute("aria-posinset", "1");
    expect(items[0]).toHaveAttribute("aria-setsize", "3");
    expect(items[0]).toHaveAttribute("aria-expanded", "false");
    expect(items[2]).not.toHaveAttribute("aria-expanded");
    expect(within(items[2]!).getByText(/Reusable block/)).toBeInTheDocument();
    expect(within(items[2]!).getByText("Hidden on some devices")).toBeInTheDocument();
  });

  it("reveals and selects a block chosen on the canvas", async () => {
    render(<Harness initialSelected="deep" />);
    const row = await screen.findByRole("treeitem", { name: /Paragraph/, selected: true });
    expect(row).toHaveAttribute("aria-level", "2");
    expect(screen.getByRole("treeitem", { name: "Pricing" })).toHaveAttribute("aria-expanded", "true");
  });

  it("browses with arrow keys and expands with the right arrow", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = await screen.findByRole("treeitem", { name: "Section" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(first).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(screen.getAllByRole("treeitem")[1]).toHaveFocus());
    await user.keyboard("{ArrowLeft}");
    await vi.waitFor(() => expect(first).toHaveFocus());
  });

  it("moves a block with Alt+arrows as one change, keeps focus on it, and announces where it went", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} initialSelected="b" />);
    const row = await screen.findByRole("treeitem", { selected: true });
    row.focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(spy).toHaveBeenCalledOnce();
    expect(ids(spy.mock.calls[0]![0] as BlockNode[])).toEqual(["s1", "b", "a", "s2", "deep", "r"]);
    expect(await screen.findByText("Moved Paragraph to position 1 in Section.")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole("treeitem", { selected: true })).toHaveFocus());
  });

  it("refuses an invalid keyboard move without changing anything", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} initialSelected="b" />);
    (await screen.findByRole("treeitem", { selected: true })).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(spy).not.toHaveBeenCalled();
    expect(await screen.findByText("Paragraph can't go inside Paragraph.")).toBeInTheDocument();
  });

  it("finds blocks by content text inside collapsed branches", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(await screen.findByRole("searchbox", { name: "Find a block" }), "needle");
    expect(screen.getAllByRole("treeitem").map((i) => i.getAttribute("aria-level"))).toEqual(["1", "2"]);
  });

  it("renames a block with F2 using an editor-only label, and clears it again", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    (await screen.findByRole("treeitem", { name: "Section" })).focus();
    await user.keyboard("{F2}");
    await user.type(screen.getByRole("textbox", { name: "Name in this editor only" }), "Hero{Enter}");
    expect((spy.mock.calls.at(-1)![0] as BlockNode[])[0]!.editor).toEqual({ label: "Hero" });
    expect((spy.mock.calls.at(-1)![0] as BlockNode[])[0]!.props).toEqual({});

    (await screen.findByRole("treeitem", { name: "Hero" })).focus();
    await user.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "Name in this editor only" });
    await user.clear(input);
    await user.type(input, "{Enter}");
    expect((spy.mock.calls.at(-1)![0] as BlockNode[])[0]).not.toHaveProperty("editor");
  });

  it("moves the selected block anywhere valid through the destination chooser", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} initialSelected="a" />);
    const chooser = await screen.findByRole("combobox", { name: /Move “Paragraph” to/ });
    const options = within(chooser).getAllByRole("option").map((o) => o.textContent?.trim());
    expect(options).toEqual(["Choose a container", "Top level", "Pricing"]);
    await user.selectOptions(chooser, "1");
    expect(ids(spy.mock.calls[0]![0] as BlockNode[])).toEqual(["s1", "b", "s2", "deep", "a", "r"]);
  });

  it("renders a long tree windowed but keeps the focused row", async () => {
    const many: BlockNode[] = Array.from({ length: 400 }, (_, i) => p(`p${i}`));
    render(<Harness start={many} initialSelected="p399" />);
    await act(async () => {});
    const rendered = screen.getAllByRole("treeitem");
    expect(rendered.length).toBeLessThan(120);
    expect(rendered.some((row) => row.getAttribute("aria-posinset") === "400")).toBe(true);
  });
});
