import { describe, expect, it } from "vitest";
import {
  sanitizeBlockBreakpoints,
  sanitizeBlockDocument,
  sanitizeContainerLayout,
  sanitizeStyleRef,
} from "../../src/index.js";

function propsOf(input: Record<string, unknown>): Record<string, unknown> {
  const doc = sanitizeBlockDocument({ version: 1, blocks: [{ id: "a", type: "core.section", version: 1, props: input }] });
  return (doc.blocks[0] as { props: Record<string, unknown> }).props;
}

describe("containerLayout", () => {
  it("keeps allowlisted values and drops the rest", () => {
    expect(
      sanitizeContainerLayout({
        display: "flex",
        direction: "column",
        wrap: "wrap",
        justify: "between",
        align: "center",
        gap: "4",
        columns: 3,
        position: "absolute",
      }),
    ).toEqual({ display: "flex", direction: "column", wrap: "wrap", justify: "between", align: "center", gap: "4", columns: 3 });
  });

  it("rejects CSS-shaped and out-of-range values", () => {
    expect(sanitizeContainerLayout({ display: "block;color:red", gap: "var(--x)", columns: 40 })).toBeUndefined();
    expect(sanitizeContainerLayout("flex")).toBeUndefined();
  });
});

describe("styleRef", () => {
  it("accepts a preset slug only", () => {
    expect(sanitizeStyleRef("brand-hero")).toBe("brand-hero");
    expect(sanitizeStyleRef("Brand Hero")).toBeUndefined();
    expect(sanitizeStyleRef("x\"><script>")).toBeUndefined();
  });
});

describe("breakpoints", () => {
  it("keeps per-breakpoint overrides on the allowlist", () => {
    expect(
      sanitizeBlockBreakpoints({
        tablet: { style: { padTop: "2", textAlign: "center", background: "red" }, gridPlacement: { span: 6 } },
        mobile: { containerLayout: { display: "grid", direction: "column", gap: "2" }, order: 2 },
        desktop: { style: { padTop: "8" } },
        wide: {},
      }),
    ).toEqual({
      tablet: { style: { padTop: "2", textAlign: "center" }, gridPlacement: { span: 6 } },
      mobile: { containerLayout: { direction: "column", gap: "2" }, order: 2 },
    });
  });

  it("treats a missing field as inherited and never stores an empty override", () => {
    expect(sanitizeBlockBreakpoints({ tablet: { style: { padTop: "" } }, mobile: {} })).toBeUndefined();
  });

  it("bounds numeric values", () => {
    expect(
      sanitizeBlockBreakpoints({ mobile: { order: 999, gridPlacement: { span: 0, col: 2 }, style: { maxWidth: -5, minHeight: 50 } } }),
    ).toEqual({ mobile: { gridPlacement: { col: 2 }, style: { minHeight: 50 } } });
  });
});

describe("sanitizeBlockDocument with Builder 2.0 values", () => {
  it("stores valid values and drops invalid ones", () => {
    expect(
      propsOf({
        containerLayout: { display: "flex", nonsense: 1 },
        styleRef: "card",
        breakpoints: { mobile: { style: { padX: "2" } } },
      }),
    ).toEqual({
      containerLayout: { display: "flex" },
      styleRef: "card",
      breakpoints: { mobile: { style: { padX: "2" } } },
    });
    expect(propsOf({ containerLayout: { display: "table" }, styleRef: "!", breakpoints: { mobile: {} } })).toEqual({});
  });

  it("does not touch the image block's own `responsive` prop", () => {
    const doc = sanitizeBlockDocument({
      version: 1,
      blocks: [{ id: "i", type: "core.image", version: 1, props: { src: "/a.jpg", responsive: { src: "/a-800.webp" } } }],
    });
    expect((doc.blocks[0] as { props: Record<string, unknown> }).props["responsive"]).toEqual({ src: "/a-800.webp" });
  });
});
