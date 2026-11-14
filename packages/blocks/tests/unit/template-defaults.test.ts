// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  BlockRegistry,
  applyTemplateDefaults,
  coreBlocks,
  resolveStyleValue,
  sanitizeTemplateDefaults,
  templateDefaultSets,
} from "../../src/index.js";

const registry = new BlockRegistry();
for (const def of coreBlocks) registry.register(def);

describe("template defaults", () => {
  it("keeps only valid block types with bounded style values, sorted", () => {
    expect(
      sanitizeTemplateDefaults({
        "core.heading": { textAlign: "center", css: "x{}" },
        "acme.card": { radius: "md" },
        "not a type": { padTop: "4" },
        "core.paragraph": { padTop: "huge" },
      }),
    ).toEqual({ "acme.card": { radius: "md" }, "core.heading": { textAlign: "center" } });
    expect(sanitizeTemplateDefaults([])).toBeUndefined();
    expect(sanitizeTemplateDefaults({ "core.heading": {} })).toBeUndefined();
  });

  it("applies beneath a block's own values, recursively, without touching other types", () => {
    const defaults = { "core.heading": { textAlign: "center", padTop: "4" } };
    const blocks = [
      { id: "s", type: "core.section", props: {}, children: [{ id: "h", type: "core.heading", props: { text: "Hi", style: { padTop: "1" } } }] },
      { id: "p", type: "core.paragraph", props: { text: "x" } },
    ];
    const out = applyTemplateDefaults(blocks, defaults);
    expect(out[0]!.children![0]!.props.style).toEqual({ textAlign: "center", padTop: "1" });
    expect(out[1]).toBe(blocks[1]);
    expect(applyTemplateDefaults(blocks, undefined)).toBe(blocks);
  });

  it("renders a template default as the block's own inline value, so it beats a preset class", () => {
    const html = registry.renderNode(
      applyTemplateDefaults([{ id: "h", type: "core.heading", props: { text: "Hi", level: 2, styleRef: "card" } }], { "core.heading": { textAlign: "center" } })[0]!,
    );
    expect(html).toContain("text-align:center");
    expect(html).toContain("jf-sp-card");
  });

  it("leaves a block whose schema owns a scalar style alone", () => {
    const blocks = [{ id: "w", type: "acme.widget", props: { style: "compact" } }];
    expect(applyTemplateDefaults(blocks, { "acme.widget": { padTop: "4" } })).toBe(blocks);
  });

  it("names the template layer between local and preset", () => {
    const preset = { id: "card", name: "Card", style: { padTop: "6", radius: "md" } };
    const tpl = { padTop: "3", textAlign: "center" };
    expect(resolveStyleValue({ styleRef: "card" }, "padTop", preset, "desktop", tpl)).toEqual({ value: "3", layer: "template-default" });
    expect(resolveStyleValue({ styleRef: "card", style: { padTop: "1" } }, "padTop", preset, "desktop", tpl)).toEqual({ value: "1", layer: "local" });
    expect(resolveStyleValue({ styleRef: "card" }, "radius", preset, "desktop", tpl)).toEqual({ value: "md", layer: "style-preset" });
    expect(templateDefaultSets({ "core.heading": tpl }, "core.heading", "textAlign")).toBe(true);
    expect(templateDefaultSets({ "core.heading": tpl }, "core.heading", "radius")).toBe(false);
  });
});
