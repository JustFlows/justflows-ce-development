import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containerLayoutAttrs } from "@justflows/blocks";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import {
  ContainerLayoutPanel,
  FlexItemPanel,
  ancestorElementsOf,
  layoutMode,
  withLayoutMode,
} from "../../../src/components/builder/LayoutControls";
import { snapMinHeight, snapSpace, stepSpace } from "../../../src/components/builder/LayoutOverlay";
import { matchReadingOrder, readingOrderDiffers, visualOrder } from "../../../src/components/builder/grid";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";

/** Layout controls, canvas parity and resize handles (justflows-ce#299). */

const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);
const group = (props: Record<string, unknown> = {}, children: BlockNode[] = []): BlockNode => ({
  id: "g",
  type: "core.group",
  version: 1,
  props,
  children,
});
const para = (id: string, props: Record<string, unknown> = {}): BlockNode => ({
  id,
  type: "core.paragraph",
  version: 1,
  props: { text: id, ...props },
});

describe("layout modes", () => {
  it("maps modes to stored layouts and back, keeping settings that still apply", () => {
    expect(layoutMode(undefined)).toBe("stack");
    const row = withLayoutMode({ gap: "4", element: "nav" }, "row")!;
    expect(row).toEqual({ gap: "4", element: "nav", display: "flex", direction: "row" });
    expect(layoutMode(row)).toBe("row");
    expect(withLayoutMode(row, "grid")).toEqual({ gap: "4", element: "nav", display: "grid", columns: 2 });
    expect(withLayoutMode(row, "stack")).toEqual({ element: "nav" });
    expect(withLayoutMode({ display: "flex" }, "stack")).toBeUndefined();
  });
});

describe("ContainerLayoutPanel", () => {
  function Harness({ initial, ancestors = [] }: { initial: BlockNode; ancestors?: string[] }) {
    const [block, setBlock] = useState(initial);
    return (
      <>
        <ContainerLayoutPanel block={block} ancestorElements={ancestors} onChange={(props) => setBlock({ ...block, props })} />
        <output data-testid="props">{JSON.stringify(block.props)}</output>
      </>
    );
  }
  const stored = () => JSON.parse(screen.getByTestId("props").textContent ?? "{}");

  it("switches a group to a row with gap and alignment", () => {
    wrap(<Harness initial={group()} />);
    fireEvent.click(screen.getByRole("radio", { name: /Row/ }));
    expect(stored().containerLayout).toEqual({ display: "flex", direction: "row" });
    fireEvent.change(screen.getByLabelText("Gap"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Vertical"), { target: { value: "center" } });
    expect(stored().containerLayout).toEqual({ display: "flex", direction: "row", gap: "4", align: "center" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Stack into one column on phones" }));
    expect(stored().containerLayout.stack).toBe("never");
  });

  it("removes the layout entirely when switched back to a stack", () => {
    wrap(<Harness initial={group({ containerLayout: { display: "grid", columns: 3 } })} />);
    expect(screen.getByRole("radio", { name: /Grid/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /Stack/ }));
    expect(stored().containerLayout).toBeUndefined();
  });

  it("refuses a header element inside a footer", () => {
    wrap(<Harness initial={group()} ancestors={["section", "footer"]} />);
    const select = screen.getByLabelText("HTML element");
    expect(within(select).getByRole("option", { name: /Header/ })).toBeDisabled();
    expect(within(select).getByRole("option", { name: /Navigation/ })).not.toBeDisabled();
  });

  it("does not offer an element choice for a section", () => {
    wrap(<Harness initial={{ ...group(), id: "s", type: "core.section" }} />);
    expect(screen.queryByLabelText("HTML element")).not.toBeInTheDocument();
  });
});

describe("FlexItemPanel", () => {
  it("offers a share of the row and growth only inside a row", () => {
    const onChange = vi.fn();
    const { rerender } = wrap(<FlexItemPanel block={para("a")} onChange={onChange} parentLayout={undefined} />);
    expect(screen.queryByLabelText("Share of the row")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Content that doesn't fit")).toBeInTheDocument();
    rerender(
      <I18nProvider>
        <FlexItemPanel block={para("a")} onChange={onChange} parentLayout={{ display: "flex" }} />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByLabelText("Share of the row"), { target: { value: "50" } });
    expect(onChange).toHaveBeenLastCalledWith({ text: "a", style: { basis: "50" } });
  });
});

describe("element nesting", () => {
  it("lists what each ancestor renders as", () => {
    const tree: BlockNode[] = [
      {
        id: "s",
        type: "core.section",
        version: 1,
        props: {},
        children: [group({ containerLayout: { element: "footer" } }, [para("a")])],
      },
    ];
    expect(ancestorElementsOf(tree, "a")).toEqual(["section", "footer"]);
  });
});

describe("resize snapping", () => {
  const sizes = { "0": 0, "1": 4, "2": 8, "3": 12, "4": 16, "5": 24, "6": 32, "7": 48, "8": 64 };
  it("snaps a dragged size to the nearest theme step", () => {
    expect(snapSpace(0, sizes)).toBe("0");
    expect(snapSpace(15, sizes)).toBe("4");
    expect(snapSpace(29, sizes)).toBe("6");
    expect(snapSpace(500, sizes)).toBe("8");
  });
  it("steps through the scale with the keyboard and stops at the ends", () => {
    expect(stepSpace("", 1)).toBe("0");
    expect(stepSpace("4", 1)).toBe("5");
    expect(stepSpace("8", 1)).toBe("8");
    expect(stepSpace("0", -1)).toBe("");
  });
  it("snaps minimum height to 5vh steps within bounds", () => {
    expect(snapMinHeight(260, 1000)).toBe(25);
    expect(snapMinHeight(5000, 1000)).toBe(100);
    expect(snapMinHeight(-10, 1000)).toBe(0);
  });
});

describe("grid reading order", () => {
  const placed = (id: string, col: number, row: number): BlockNode => para(id, { gridPlacement: { col, span: 6, row } });
  it("flags explicit placement that shows blocks out of reading order, and fixes it", () => {
    const inOrder = [placed("a", 1, 1), placed("b", 7, 1), placed("c", 1, 2)];
    expect(readingOrderDiffers(inOrder, 12)).toBe(false);
    const swapped = [placed("a", 7, 1), placed("b", 1, 1), para("c")];
    expect(visualOrder(swapped, 12)).toEqual(["b", "a", "c"]);
    expect(readingOrderDiffers(swapped, 12)).toBe(true);
    expect(matchReadingOrder(swapped, 12).map((b) => b.id)).toEqual(["b", "a", "c"]);
  });
});

describe("canvas parity", () => {
  const CATALOG: BlockCatalogEntry[] = [
    { type: "core.group", version: 1, title: "Group", category: "layout", supportsChildren: true },
    { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
  ];
  afterEach(() => vi.unstubAllGlobals());

  it("lays out a container's children with the same classes the public page uses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (String(input).includes("/api/blocks") ? { blocks: CATALOG } : {}),
        } as Response),
      ),
    );
    const layout = { display: "flex", gap: "4", justify: "between" };
    const doc: BlockDocument = {
      version: 1,
      blocks: [group({ containerLayout: layout }, [para("a", { style: { basis: "50", grow: "1" } }), para("b")])],
    };
    wrap(<PageBuilder value={doc} onChange={() => {}} compact flatCanvas />);
    await screen.findAllByText("a");
    const container = document.querySelector('[data-jf-layout-container="g"]') as HTMLElement;
    expect(container.className).toBe(containerLayoutAttrs(layout)!.classes.join(" "));
    expect(container.style.justifyContent).toBe("space-between");
    expect(container.style.getPropertyValue("--jf-cl-gap")).toBe("var(--space-4)");
    const item = container.firstElementChild as HTMLElement;
    expect(item.style.getPropertyValue("--jf-grow")).toBe("1");
    expect(item.style.getPropertyValue("--jf-basis")).toBe("calc(50% - var(--jf-cl-gap, 0px) * 0.5)");
  });

  it("changes padding from the keyboard on the selected block's handle", async () => {
    let latest: BlockDocument = { version: 1, blocks: [para("a")] };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (String(input).includes("/api/blocks") ? { blocks: CATALOG } : {}),
        } as Response),
      ),
    );
    function Controlled() {
      const [value, setValue] = useState(latest);
      return (
        <PageBuilder
          value={value}
          onChange={(next) => {
            latest = next;
            setValue(next);
          }}
          compact
          flatCanvas
        />
      );
    }
    render(
      <SessionProvider>
        <I18nProvider>
          <Controlled />
        </I18nProvider>
      </SessionProvider>,
    );
    await screen.findAllByText("a");
    fireEvent.click(document.querySelector('[data-block-id="a"]')!);
    const handle = await screen.findByRole("slider", { name: "Padding top" });
    expect(handle).toHaveAttribute("aria-valuetext", "Auto");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(latest.blocks[0]!.props.style).toEqual({ padTop: "1" });
    fireEvent.keyDown(handle, { key: "Home" });
    expect(latest.blocks[0]!.props.style).toBeUndefined();
  });
});

describe("add block picker", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("closes on a click outside it and on Escape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            String(input).includes("/api/blocks")
              ? { blocks: [{ type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false }] }
              : {},
        } as Response),
      ),
    );
    wrap(<PageBuilder value={{ version: 1, blocks: [] }} onChange={() => {}} compact flatCanvas />);
    const add = await screen.findByRole("button", { name: /Add block/ });
    fireEvent.click(add);
    expect(add).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("button", { name: /Paragraph/ })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("button", { name: /Paragraph/ })).not.toBeInTheDocument();

    fireEvent.click(add);
    expect(screen.getByRole("button", { name: /Paragraph/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /Paragraph/ })).not.toBeInTheDocument();
    expect(add).toHaveFocus();
  });
});
