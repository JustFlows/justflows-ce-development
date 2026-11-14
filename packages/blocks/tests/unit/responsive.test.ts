// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  BlockRegistry,
  breakpointCss,
  breakpointForWidth,
  coreBlocks,
  resolveResponsiveValue,
  sanitizeBlockDocument,
  setBreakpointValue,
} from "../../src/index.js";

const registry = new BlockRegistry();
for (const def of coreBlocks) registry.register(def);

const targets = { block: ".b", layout: ".l", item: ".i" };

describe("breakpointCss", () => {
  it("emits nothing for a block without overrides, so older documents are unchanged", () => {
    expect(breakpointCss(undefined, undefined, targets)).toBe("");
    expect(breakpointCss({ tablet: { style: { padTop: "nope" } } }, undefined, targets)).toBe("");
    const node = { id: "p1", type: "core.paragraph", props: { text: "x", style: { padTop: "4" } } };
    expect(registry.renderNode(node)).not.toContain("<style>");
  });

  it("writes tablet then mobile rules, in a fixed order, scoped to the targets", () => {
    const css = breakpointCss(
      { mobile: { style: { padTop: "2", alignSelf: "center" }, order: 1 }, tablet: { style: { padTop: "5", fontSize: "lg" } } },
      undefined,
      targets,
    );
    expect(css).toBe(
      [
        "@media (max-width: 1024px){.b{padding-top:var(--space-5) !important;font-size:var(--jf-text-lg,1.125rem) !important}}",
        "@media (max-width: 600px){.b{padding-top:var(--space-2) !important;font-size:var(--jf-text-lg,1.125rem) !important}.i{justify-self:center !important;align-self:center !important;order:1 !important}}",
      ].join("\n"),
    );
  });

  it("lets mobile inherit what it does not set from tablet", () => {
    const css = breakpointCss({ tablet: { gridPlacement: { span: 6 } }, mobile: { gridPlacement: { col: 1 } } }, undefined, targets);
    expect(css).toContain("@media (max-width: 600px){.i{grid-column:1 / span 6 !important}}");
  });

  it("overrides a row's layout only when the block has one", () => {
    const layout = { tablet: { containerLayout: { direction: "column", gap: "2" } } };
    expect(breakpointCss(layout, undefined, targets)).toBe("");
    expect(breakpointCss(layout, { display: "flex" }, targets)).toBe(
      "@media (max-width: 1024px){.l{flex-direction:column !important;gap:var(--space-2) !important;--jf-cl-gap:var(--space-2) !important}}",
    );
    expect(breakpointCss({ mobile: { containerLayout: { columns: 2 } } }, { display: "grid", columns: 4 }, targets)).toContain(
      "grid-template-columns:repeat(2,minmax(0,1fr)) !important;--jf-cl-cols:2 !important",
    );
  });

  it("can write container queries for the builder canvas", () => {
    expect(breakpointCss({ tablet: { style: { padX: "1" } } }, undefined, targets, { kind: "container", name: "jf-canvas" })).toMatch(
      /^@container jf-canvas \(max-width: 1024px\)\{/,
    );
  });

  it("is emitted by the public renderer under the block's scope class", () => {
    const html = registry.renderNode({
      id: "sec-1",
      type: "core.section",
      props: { containerLayout: { display: "flex" }, breakpoints: { mobile: { containerLayout: { direction: "row" } } } },
      children: [{ id: "a", type: "core.paragraph", props: { text: "a" } }],
    });
    expect(html).toMatch(/^<style>@media \(max-width: 600px\)\{\.jf-b-sec-1 > \.jf-section__inner\{flex-direction:row !important\}\}<\/style>/);
    expect(html).toMatch(/<section class="[^"]*jf-b-sec-1/);
  });

  it("only ever contains allowlisted values", () => {
    const doc = sanitizeBlockDocument({
      blocks: [
        {
          id: "x",
          type: "core.group",
          props: {
            containerLayout: { display: "flex" },
            breakpoints: {
              mobile: { style: { padTop: "}body{x:y", fontSize: "999px" }, containerLayout: { gap: "url(x)" }, order: 99 },
              desktop: { style: { padTop: "4" } },
            },
          },
        },
      ],
    });
    const html = registry.renderNode(doc.blocks[0] as Parameters<typeof registry.renderNode>[0]);
    expect(html).not.toMatch(/body\{|999px|url\(|order:99/);
    expect((doc.blocks[0] as { props: Record<string, unknown> }).props.breakpoints).toBeUndefined();
  });
});

describe("inheritance and reset", () => {
  const props = {
    style: { padTop: "6" },
    containerLayout: { display: "flex", gap: "4" },
    breakpoints: { tablet: { style: { padTop: "4" } }, mobile: { containerLayout: { gap: "1" } } },
  };

  it("resolves a value and the breakpoint it comes from", () => {
    expect(resolveResponsiveValue(props, "desktop", "style", "padTop")).toEqual({ value: "6", source: "desktop" });
    expect(resolveResponsiveValue(props, "tablet", "style", "padTop")).toEqual({ value: "4", source: "tablet" });
    expect(resolveResponsiveValue(props, "mobile", "style", "padTop")).toEqual({ value: "4", source: "tablet" });
    expect(resolveResponsiveValue(props, "mobile", "containerLayout", "gap")).toEqual({ value: "1", source: "mobile" });
    expect(resolveResponsiveValue(props, "tablet", "containerLayout", "gap")).toEqual({ value: "4", source: "desktop" });
    expect(resolveResponsiveValue(props, "mobile", "style", "fontSize")).toEqual({ value: undefined, source: null });
  });

  it("resets only the selected override and prunes what becomes empty", () => {
    const reset = setBreakpointValue(props, "tablet", "style", "padTop", undefined);
    expect(reset.breakpoints).toEqual({ mobile: { containerLayout: { gap: "1" } } });
    expect(resolveResponsiveValue(reset, "mobile", "style", "padTop")).toEqual({ value: "6", source: "desktop" });
    const empty = setBreakpointValue(reset, "mobile", "containerLayout", "gap", "");
    expect(empty.breakpoints).toBeUndefined();
    expect(empty.style).toEqual({ padTop: "6" });
  });

  it("refuses values outside the allowlist when setting", () => {
    expect(setBreakpointValue({}, "mobile", "style", "padTop", "huge").breakpoints).toBeUndefined();
    expect(setBreakpointValue({}, "mobile", "order", undefined, 3).breakpoints).toEqual({ mobile: { order: 3 } });
  });

  it("maps widths to breakpoints at the contract's edges", () => {
    expect(breakpointForWidth(600)).toBe("mobile");
    expect(breakpointForWidth(601)).toBe("tablet");
    expect(breakpointForWidth(1024)).toBe("tablet");
    expect(breakpointForWidth(1025)).toBe("desktop");
  });
});
