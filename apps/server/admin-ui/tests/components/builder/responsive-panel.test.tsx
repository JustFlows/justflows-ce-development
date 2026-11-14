import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { breakpointCss } from "@justflows/blocks";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import ResponsivePanel, { responsiveWarnings } from "../../../src/components/builder/ResponsivePanel";
import { canvasBreakpointCss } from "../../../src/components/builder/BlockCanvas";
import { clampPreviewWidth, parseBuilderPrefs } from "../../../src/components/builder/shell/builder-prefs";
import type { BlockNode } from "../../../src/components/builder/types";

/** Breakpoint overrides in the builder (justflows-ce#300). */

const block = (props: Record<string, unknown>, type = "core.group"): BlockNode => ({ id: "b1", type, version: 1, props });

function Harness({ initial, previewing = "desktop" as const, onPreview }: { initial: BlockNode; previewing?: "desktop" | "tablet" | "mobile"; onPreview?: (bp: "tablet" | "mobile") => void }) {
  const [node, setNode] = useState(initial);
  return (
    <I18nProvider>
      <ResponsivePanel block={node} previewing={previewing} onPreview={onPreview} onChange={(props) => setNode({ ...node, props })} />
      <output data-testid="props">{JSON.stringify(node.props)}</output>
    </I18nProvider>
  );
}
const stored = () => JSON.parse(screen.getByTestId("props").textContent ?? "{}");

describe("ResponsivePanel", () => {
  it("shows the inherited value and its source, then writes only an override", () => {
    render(<Harness initial={block({ style: { padTop: "6" } })} previewing="mobile" />);
    expect(screen.getByRole("radio", { name: /Mobile/ })).toHaveAttribute("aria-checked", "true");
    const pad = screen.getByLabelText("Padding top");
    expect(pad).toHaveAccessibleDescription("XL · from Desktop");
    fireEvent.change(pad, { target: { value: "2" } });
    expect(stored()).toEqual({ style: { padTop: "6" }, breakpoints: { mobile: { style: { padTop: "2" } } } });
    expect(screen.getByLabelText("Padding top")).toHaveAccessibleDescription("Set for this breakpoint");
  });

  it("resets one field at one breakpoint and keeps the rest", () => {
    render(
      <Harness
        initial={block({ breakpoints: { tablet: { style: { padTop: "4", padBottom: "4" } }, mobile: { style: { padTop: "1" } } } })}
        previewing="tablet"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Padding top for Tablet" }));
    expect(stored().breakpoints).toEqual({ tablet: { style: { padBottom: "4" } }, mobile: { style: { padTop: "1" } } });
    expect(screen.getByRole("button", { name: "Reset Padding top for Tablet" })).toBeDisabled();
  });

  it("keeps editing and previewing apart, and offers to preview what is edited", () => {
    const onPreview = vi.fn();
    render(<Harness initial={block({})} previewing="desktop" onPreview={onPreview} />);
    expect(screen.getByRole("radio", { name: /Tablet/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/You are editing Tablet but previewing Desktop/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview at Tablet" }));
    expect(onPreview).toHaveBeenCalledWith("tablet");
  });

  it("offers layout overrides only for a block that has a layout", () => {
    const { unmount } = render(<Harness initial={block({})} previewing="tablet" />);
    expect(screen.queryByLabelText("Direction")).not.toBeInTheDocument();
    unmount();
    render(<Harness initial={block({ containerLayout: { display: "flex" } })} previewing="mobile" />);
    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "row" } });
    expect(stored().breakpoints).toEqual({ mobile: { containerLayout: { direction: "row" } } });
  });
});

describe("responsiveWarnings", () => {
  it("flags hidden content, reordering, tiny text, too wide and too tall blocks", () => {
    const node = block({
      devices: ["desktop", "tablet"],
      breakpoints: { mobile: { order: 2, style: { fontSize: "xs", maxWidth: 900, minHeight: 95 } } },
    });
    expect(responsiveWarnings(node, "mobile")).toEqual(["hidden", "order", "tinyText", "tooWide", "tall"]);
    expect(responsiveWarnings(node, "tablet")).toEqual([]);
  });

  it("warns about a row kept on one line unless it stacks on phones", () => {
    const row = block({ containerLayout: { display: "flex", wrap: "nowrap" } });
    expect(responsiveWarnings(row, "tablet")).toContain("nowrap");
    expect(responsiveWarnings(row, "mobile")).not.toContain("nowrap");
  });
});

describe("canvas parity", () => {
  it("emits the same rules as the public page, as container queries on the canvas elements", () => {
    const node = block({ containerLayout: { display: "grid", columns: 3 }, breakpoints: { mobile: { containerLayout: { columns: 1 }, style: { padX: "2" } } } });
    const canvas = canvasBreakpointCss(node);
    const page = breakpointCss(node.props.breakpoints, node.props.containerLayout, { block: "B", layout: "L", item: "I" });
    const normalize = (css: string) =>
      css
        .replace(/@container jf-canvas /g, "@media ")
        .replace(/\[data-jf-block-preview="b1"\]/g, "B")
        .replace(/\[data-jf-layout-container="b1"\]/g, "L")
        .replace(/\[data-jf-layout-item="b1"\]/g, "I");
    expect(normalize(canvas)).toBe(page);
  });
});

describe("preview width preference", () => {
  it("keeps custom widths within bounds and drops anything else", () => {
    expect(clampPreviewWidth(500)).toBe(500);
    expect(clampPreviewWidth(100)).toBeNull();
    expect(clampPreviewWidth("700")).toBeNull();
    expect(parseBuilderPrefs({ previewWidth: 4000 }).previewWidth).toBeNull();
    expect(parseBuilderPrefs({ previewWidth: 820.4 }).previewWidth).toBe(820);
  });
});

describe("shell width input", () => {
  it("sets a custom preview width and clears it when a preset is chosen", async () => {
    const { default: BuilderShell } = await import("../../../src/components/builder/shell/BuilderShell");
    const { DEFAULT_BUILDER_PREFS } = await import("../../../src/components/builder/shell/builder-prefs");
    const onPrefsChange = vi.fn();
    render(
      <I18nProvider>
        <BuilderShell
          context="page"
          prefs={{ ...DEFAULT_BUILDER_PREFS, breakpoint: "tablet" }}
          onPrefsChange={onPrefsChange}
          history={{ undo() {}, redo() {}, canUndo: false, canRedo: false }}
          previewScheme="light"
          onPreviewSchemeChange={() => {}}
          blockCount={0}
          breadcrumbs={[]}
          onSelectCrumb={() => {}}
          library={null}
          inspector={null}
          canvas={null}
          onCanvasBackgroundClick={() => {}}
        />
      </I18nProvider>,
    );
    const input = screen.getByLabelText("Preview width in pixels");
    expect(input).toHaveValue(768);
    fireEvent.change(input, { target: { value: "414" } });
    fireEvent.blur(input);
    expect(onPrefsChange).toHaveBeenLastCalledWith({ previewWidth: 414 });
    fireEvent.click(within(screen.getByRole("group", { name: /breakpoint|width/i })).getByRole("button", { name: "Mobile" }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ breakpoint: "mobile", previewWidth: null });
  });
});
