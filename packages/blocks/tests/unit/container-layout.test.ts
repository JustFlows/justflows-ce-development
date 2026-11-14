// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  BlockRegistry,
  coreBlocks,
  containerElementAllowed,
  containerLayoutAttrs,
  containerLayoutCss,
  flexBasis,
  sanitizeBlockDocument,
  withBlockChrome,
} from "../../src/index.js";

const registry = new BlockRegistry();
for (const def of coreBlocks) registry.register(def);

const p = (id: string, style?: Record<string, unknown>) => ({
  id,
  type: "core.paragraph",
  version: 1,
  props: { text: id, ...(style ? { style } : {}) },
});

describe("containerLayout rendering", () => {
  it("leaves blocks without a layout exactly as they were", () => {
    const node = { id: "s", type: "core.section", props: {}, children: [p("a"), p("b")] };
    const withEmpty = { ...node, props: { containerLayout: { gap: "4" } } };
    expect(registry.renderNode(withEmpty)).toBe(registry.renderNode(node));
  });

  it("lays out a section's inner wrapper, not the section itself", () => {
    const html = registry.renderNode({
      id: "s",
      type: "core.section",
      props: { containerLayout: { display: "flex", justify: "between", align: "center", gap: "4" } },
      children: [p("a"), p("b")],
    });
    expect(html).toMatch(/^<section class="jf-section[^"]*">/);
    expect(html).toContain(
      'class="jf-section__inner jf-cl jf-cl-flex jf-cl-row jf-cl-stack" style="flex-wrap:wrap;justify-content:space-between;align-items:center;gap:var(--space-4);--jf-cl-gap:var(--space-4)"',
    );
  });

  it("targets only the outer section when sections are nested", () => {
    const html = registry.renderNode({
      id: "outer",
      type: "core.section",
      props: { containerLayout: { display: "grid", columns: 3 } },
      children: [{ id: "inner", type: "core.section", props: {}, children: [p("a")] }],
    });
    expect(html.match(/jf-cl-grid/g)).toHaveLength(1);
    const outerInner = html.indexOf("jf-section__inner");
    const innerInner = html.indexOf("jf-section__inner", outerInner + 1);
    expect(html.indexOf("jf-cl-grid")).toBeGreaterThan(outerInner);
    expect(html.indexOf("jf-cl-grid")).toBeLessThan(innerInner);
  });

  it("renders a group as an allowlisted element with a grid on its root", () => {
    const html = registry.renderNode({
      id: "g",
      type: "core.group",
      props: { containerLayout: { display: "grid", columns: 3, element: "article", stack: "never" } },
      children: [p("a")],
    });
    expect(html).toMatch(/^<article class="jf-group jf-cl jf-cl-grid" style="--jf-cl-cols:3">/);
    expect(html.trimEnd()).toMatch(/<\/article>(<!--[^>]*-->)?$/);
  });

  it("drops elements and values outside the allowlist", () => {
    const html = registry.renderNode({
      id: "g",
      type: "core.group",
      props: { containerLayout: { display: "flex", element: "script", gap: "99", justify: "url(x)" } },
      children: [p("a")],
    });
    expect(html).toMatch(/^<div class="jf-group jf-cl jf-cl-flex/);
    expect(html).not.toMatch(/script|url\(|space-99/);
  });

  it("never offers a reversed or reordered layout, so reading order is source order", () => {
    const attrs = containerLayoutAttrs({ display: "flex", direction: "row-reverse" })!;
    expect(attrs.classes).toContain("jf-cl-row");
    expect(JSON.stringify(attrs)).not.toMatch(/reverse|order/);
    expect(containerLayoutCss()).not.toMatch(/reverse|order:/);
  });

  it("ignores a layout on blocks that are not layout containers", () => {
    const node = { id: "x", type: "core.paragraph", props: { text: "x", containerLayout: { display: "flex" } } };
    expect(registry.renderNode(node)).not.toContain("jf-cl");
  });

  it("stacks rows and grids on phones only when allowed", () => {
    expect(containerLayoutAttrs({ display: "flex", direction: "column" })!.classes).not.toContain("jf-cl-stack");
    expect(containerLayoutAttrs({ display: "grid", stack: "never" })!.classes).not.toContain("jf-cl-stack");
    expect(containerLayoutCss()).toMatch(/@media \(max-width: 600px\)[\s\S]*\.jf-cl-stack\.jf-cl-row \{ flex-direction: column; \}/);
  });
});

describe("flex item style", () => {
  it("emits grow and a gap-aware basis on any block, including plugin blocks", () => {
    const html = withBlockChrome('<div class="acme-card">Card</div>', {
      id: "c",
      type: "acme.card",
      props: { style: { grow: "1", basis: "33", overflow: "hidden" } },
    });
    expect(html).toContain("--jf-grow:1");
    expect(html).toContain("--jf-basis:calc(33.3333% - var(--jf-cl-gap, 0px) * 0.6667)");
    expect(html).toContain("overflow:hidden");
  });

  it("makes equal shares fill one row exactly", () => {
    expect(flexBasis("50")).toBe("calc(50% - var(--jf-cl-gap, 0px) * 0.5)");
    expect(flexBasis("100")).toBe("100%");
    expect(flexBasis("auto")).toBe("auto");
  });

  it("keeps only valid layout and item values through the storage sanitizer", () => {
    const doc = sanitizeBlockDocument({
      blocks: [
        {
          id: "g",
          type: "core.group",
          props: { containerLayout: { display: "flex", element: "nav", stack: "sometimes" } },
          children: [p("a", { grow: "1", basis: "40", overflow: "scroll" })],
        },
      ],
    });
    const group = doc.blocks[0] as { props: Record<string, unknown>; children: { props: Record<string, unknown> }[] };
    expect(group.props.containerLayout).toEqual({ display: "flex", element: "nav" });
    expect(group.children[0]!.props.style).toEqual({ grow: "1" });
  });
});

describe("containerElementAllowed", () => {
  it("refuses a header or footer inside another header or footer", () => {
    expect(containerElementAllowed("header", ["section"])).toBe(true);
    expect(containerElementAllowed("header", ["footer"])).toBe(false);
    expect(containerElementAllowed("footer", ["section", "header"])).toBe(false);
    expect(containerElementAllowed("nav", ["header"])).toBe(true);
  });
});

describe("representative layouts without custom CSS", () => {
  const group = (id: string, layout: Record<string, unknown> | undefined, children: unknown[], style?: Record<string, unknown>) => ({
    id,
    type: "core.group",
    props: { ...(layout ? { containerLayout: layout } : {}), ...(style ? { style } : {}) },
    children,
  });
  const section = (id: string, layout: Record<string, unknown>, children: unknown[], style?: Record<string, unknown>) => ({
    id,
    type: "core.section",
    props: { containerLayout: layout, ...(style ? { style } : {}) },
    children,
  });
  const img = (id: string) => ({ id, type: "core.image", props: { src: "/a.jpg", alt: id } });

  const layouts: Record<string, unknown> = {
    hero: section("hero", { display: "flex", direction: "column", justify: "center", align: "center", gap: "4" }, [p("title"), p("cta")], { minHeight: 60 }),
    split: section("split", { display: "flex", align: "center", gap: "6" }, [
      group("text", undefined, [p("copy")], { basis: "50" }),
      group("media", undefined, [img("photo")], { basis: "50" }),
    ]),
    cards: group("cards", { display: "grid", columns: 3, gap: "5" }, [p("c1"), p("c2"), p("c3")]),
    pricing: group("pricing", { display: "grid", columns: 3, gap: "5", align: "stretch" }, [
      group("plan1", { display: "flex", direction: "column", justify: "between" }, [p("price1")]),
      group("plan2", { display: "flex", direction: "column", justify: "between" }, [p("price2")]),
      group("plan3", { display: "flex", direction: "column", justify: "between" }, [p("price3")]),
    ]),
    gallery: group("gallery", { display: "grid", columns: 4, gap: "2" }, [img("g1"), img("g2"), img("g3"), img("g4")]),
  };

  it.each(Object.entries(layouts))("renders the %s layout from stored values only", (_name, node) => {
    const stored = sanitizeBlockDocument({ blocks: [node] }).blocks[0] as Parameters<typeof registry.renderNode>[0];
    const html = registry.renderNode(stored);
    expect(html).toContain("jf-cl ");
    expect(html).not.toContain("<style>");
    /** Every block still appears, in source order. */
    const ids = JSON.stringify(stored).match(/"id":"([^"]+)"/g)!.map((m) => m.slice(6, -1));
    const texts = ids.filter((id) => html.includes(`>${id}<`));
    expect(texts).toEqual([...texts].sort((a, b) => html.indexOf(`>${a}<`) - html.indexOf(`>${b}<`)));
  });

  it("splits content in two equal halves that stack on phones", () => {
    const html = registry.renderNode(sanitizeBlockDocument({ blocks: [layouts.split] }).blocks[0] as Parameters<typeof registry.renderNode>[0]);
    expect(html).toContain("jf-cl-row jf-cl-stack");
    expect(html.match(/--jf-basis:calc\(50% - var\(--jf-cl-gap, 0px\) \* 0\.5\)/g)).toHaveLength(2);
  });
});
