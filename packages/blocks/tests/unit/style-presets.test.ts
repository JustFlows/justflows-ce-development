// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  BlockRegistry,
  coreBlocks,
  resolveStyleValue,
  sanitizeBlockDocument,
  sanitizeStylePresets,
  stylePresetClass,
  stylePresetsCss,
} from "../../src/index.js";

const registry = new BlockRegistry();
for (const def of coreBlocks) registry.register(def);

describe("style presets", () => {
  it("normalizes a stored list: bad ids dropped, duplicates kept once, sorted, values bounded", () => {
    const presets = sanitizeStylePresets([
      { id: "card", name: "  Card  ", style: { padTop: "4", background: "#fff", radius: "md", css: "x{}" } },
      { id: "card", name: "Duplicate", style: {} },
      { id: "Bad Id", name: "Nope", style: {} },
      { id: "accent", style: { textColor: "javascript:alert(1)", shadow: "md" } },
      "junk",
    ]);
    expect(presets).toEqual([
      { id: "accent", name: "accent", style: { shadow: "md" } },
      { id: "card", name: "Card", style: { padTop: "4", radius: "md", background: "#fff" } },
    ]);
  });

  it("emits one class rule per preset, in a fixed order, from the style contract only", () => {
    const css = stylePresetsCss([
      { id: "hero", name: "Hero", style: { padTop: "7", padBottom: "7", textAlign: "center" } },
      { id: "card", name: "Card", style: { radius: "md", shadow: "sm", background: "#ffffff" } },
      { id: "empty", name: "Empty", style: {} },
    ]);
    expect(css).toBe(
      [
        ".jf-sp-card{border-radius:var(--radius-md);box-shadow:var(--shadow-sm);background:#ffffff;--jf-block-bg:#ffffff}",
        ".jf-sp-hero{padding-top:var(--space-7);padding-bottom:var(--space-7);text-align:center}",
      ].join("\n"),
    );
    expect(stylePresetsCss([])).toBe("");
  });

  it("gives a block its preset class and keeps local values inline so they win", () => {
    const html = registry.renderNode({
      id: "p1",
      type: "core.paragraph",
      props: { text: "Hi", styleRef: "card", style: { padTop: "2" } },
    });
    expect(html).toMatch(/class="[^"]*\bjf-sp-card\b/);
    expect(html).toContain("padding-top:var(--space-2)");
    expect(stylePresetClass("not valid")).toBe("");
    expect(registry.renderNode({ id: "p2", type: "core.paragraph", props: { text: "x", styleRef: "../x" } })).not.toContain("jf-sp-");
  });

  it("survives the storage sanitizer", () => {
    const doc = sanitizeBlockDocument({ blocks: [{ id: "a", type: "core.group", props: { styleRef: "card" } }] });
    expect((doc.blocks[0] as { props: Record<string, unknown> }).props.styleRef).toBe("card");
  });

  it("resolves which layer supplies a value", () => {
    const preset = { id: "card", name: "Card", style: { padTop: "5", radius: "md" } };
    const props = { style: { padTop: "2" }, styleRef: "card", breakpoints: { mobile: { style: { padTop: "1" } } } };
    expect(resolveStyleValue(props, "padTop", preset)).toEqual({ value: "2", layer: "local" });
    expect(resolveStyleValue(props, "padTop", preset, "mobile")).toEqual({ value: "1", layer: "breakpoint-override", breakpoint: "mobile" });
    expect(resolveStyleValue(props, "padTop", preset, "tablet")).toEqual({ value: "2", layer: "local" });
    expect(resolveStyleValue(props, "radius", preset)).toEqual({ value: "md", layer: "style-preset" });
    expect(resolveStyleValue(props, "shadow", preset)).toEqual({ value: undefined, layer: "theme" });
    expect(resolveStyleValue({}, "padTop", null)).toEqual({ value: undefined, layer: "theme" });
  });
});
