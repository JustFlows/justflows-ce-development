import { render } from "@testing-library/react";
import { breakpointCss, coreBlocks, createBlockRegistrySync, sanitizePluginPreviewHtml } from "@justflows/blocks";
import { describe, expect, it, vi } from "vitest";
import { BlockPreview } from "../../../src/components/builder/BlockPreview";
import { canvasBreakpointCss } from "../../../src/components/builder/BlockCanvas";
import { createBlock } from "../../../src/components/builder/block-defaults";
import { PREVIEW_SUBSTITUTES } from "../../../src/components/builder/preview-substitutions";
import type { BlockNode } from "../../../src/components/builder/types";

/**
 * The builder canvas against the public renderer (justflows-ce#306).
 *
 * Every core block is rendered twice, by `@justflows/blocks` as the page does
 * and by the canvas, and the element structure and classes must match. What
 * the canvas adds for editing (wrappers, chrome, labels) is removed first, and
 * links compare as links whether they are `<a>` or the canvas's inert `<span>`.
 * Blocks in `PREVIEW_SUBSTITUTES` are deliberate stand-ins: they must carry
 * the stand-in label instead. Any other difference fails here, so a change to
 * either renderer has to change both.
 */

vi.mock("../../../src/i18n/I18nProvider", () => ({ useT: () => ({ t: (key: string) => key, locale: "en" }) }));
vi.mock("../../../src/lib/theme-style-tokens", () => ({ useThemeStyleTokens: () => ({ theme: "", tokens: [], blockControls: {} }) }));

const registry = createBlockRegistrySync();
const definitions = new Map(coreBlocks.map((definition) => [definition.type, definition]));

/** Blocks that only render inside another document's context (a reusable library). */
const CONTEXT_ONLY = new Set(["core.reusable"]);

/** Representative stored props: the builder's defaults, with text, links and media filled in so no empty-state hint shows. */
function fixture(type: string, id = "b"): BlockNode {
  const node = createBlock(type);
  const schema = definitions.get(type)?.schema ?? {};
  const props: Record<string, unknown> = { ...node.props };
  for (const [name, field] of Object.entries(schema)) {
    if (props[name] !== undefined && props[name] !== "") continue;
    if (field.type === "media") props[name] = "/uploads/sample.jpg";
    else if (field.type === "url") props[name] = name === "src" ? "/uploads/sample.mp4" : "/sample";
    else if (field.type === "text" || field.type === "textarea" || field.type === "richtext") props[name] = `Sample ${name}`;
  }
  if (type === "core.video" || type === "core.audio" || type === "core.file") props.src = `/uploads/sample.${type === "core.audio" ? "mp3" : type === "core.file" ? "pdf" : "mp4"}`;
  const definition = definitions.get(type);
  let children = node.children;
  if (definition?.supportsChildren && (!children || children.length === 0)) {
    const allowed = definition.allowedChildTypes;
    children = [fixture(allowed?.length ? allowed[0]! : "core.paragraph", `${id}-c`)];
  }
  return { ...node, id, props, ...(children ? { children: children.map((child, i) => ({ ...child, id: `${id}-${i}` })) } : {}) };
}

function renderCanvas(block: BlockNode): HTMLElement {
  const renderChildren = (children: BlockNode[], depth: number) =>
    children.map((child) => <BlockPreview key={child.id} block={child} depth={depth} renderChildren={renderChildren} />);
  const { container } = render(<BlockPreview block={block} renderChildren={renderChildren} />);
  return container;
}

function renderServer(block: BlockNode): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = registry.renderNode(block as never);
  return root;
}

/** Scope wrappers the canvas puts around a top-level block for theme styles and light/dark mode. */
const CANVAS_SCOPE_CLASSES = new Set(["jf-theme-surface"]);

const LINK_CLASS = /(^btn$|__link$|-link$|__btn$)/;

/**
 * Tag and class outline of a rendered tree, without what only the canvas adds:
 * builder chrome, classless wrapper `<div>`s (both sides, so structure still
 * has to line up), per-block style elements and scope classes.
 */
function outline(root: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (child.matches("[data-builder-chrome], style, script")) continue;
      const tag = child.tagName.toLowerCase();
      const classes = [...child.classList].filter((c) => !c.startsWith("jf-b-") && !c.startsWith("jf-sp-")).sort();
      const wrapper = classes.length === 0 || (classes.length === 1 && CANVAS_SCOPE_CLASSES.has(classes[0]!));
      if ((tag === "div" || tag === "span") && wrapper && !child.hasAttribute("role")) {
        walk(child);
        continue;
      }
      const isLink = tag === "a" || (tag === "span" && classes.some((c) => LINK_CLASS.test(c)));
      out.push(`${isLink ? "link" : tag}${classes.map((c) => `.${c}`).join("")}`);
      walk(child);
    }
  };
  walk(root);
  return out;
}

const blocks = coreBlocks.map((d) => d.type).filter((type) => !CONTEXT_ONLY.has(type));

describe("canvas and public page render core blocks alike", () => {
  it.each(blocks.filter((type) => !PREVIEW_SUBSTITUTES[type]))("%s", (type) => {
    const block = fixture(type);
    expect(outline(renderCanvas(block))).toEqual(outline(renderServer(block)));
  });

  it.each(Object.keys(PREVIEW_SUBSTITUTES).filter((type) => definitions.has(type)))("%s is labelled as a stand-in", (type) => {
    const canvas = renderCanvas(fixture(type));
    const wrapper = canvas.querySelector(`[data-jf-stand-in]`);
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute("data-jf-stand-in")).toBe(PREVIEW_SUBSTITUTES[type]);
    expect(wrapper!.querySelector(".jf-preview-stand-in")).not.toBeNull();
  });

  it("fills a missing setting with the same default as the page", () => {
    for (const type of ["core.hero", "core.cta", "core.section", "core.button"]) {
      const block: BlockNode = { id: "d", type, version: 1, props: { heading: "Hi", label: "Go" }, children: [] };
      expect(outline(renderCanvas(block)), type).toEqual(outline(renderServer(block)));
    }
  });
});

describe("styles, presets and responsive values", () => {
  const styled: BlockNode = {
    id: "s1",
    type: "core.group",
    version: 1,
    props: { style: { padTop: "6", padX: "4", radius: "md", maxWidth: "720px", minHeight: "40vh" }, styleRef: "card" },
    children: [{ id: "p1", type: "core.paragraph", version: 1, props: { text: "Hi" } }],
  };

  it("puts the same style declarations and preset class on the block's root", () => {
    const declarations = (el: Element | null) =>
      (el?.getAttribute("style") ?? "").split(";").map((d) => d.trim().replace(/\s*:\s*/, ":")).filter(Boolean).sort();
    const server = renderServer(styled).querySelector(".jf-group");
    const canvas = renderCanvas(styled).querySelector(".jf-group");
    expect(declarations(server).length).toBeGreaterThan(3);
    expect(declarations(canvas)).toEqual(declarations(server));
    expect(canvas!.classList.contains("jf-sp-card")).toBe(true);
    expect(server!.classList.contains("jf-sp-card")).toBe(true);
  });

  it("writes the same breakpoint rules, scoped to the canvas width instead of the window", () => {
    const block: BlockNode = {
      id: "r1",
      type: "core.section",
      version: 1,
      props: { containerLayout: { display: "grid", columns: 3 }, breakpoints: { tablet: { style: { padTop: "2" } }, mobile: { containerLayout: { columns: 1 }, style: { textAlign: "center" } } } },
      children: [],
    };
    const strip = (css: string) => css.replace(/@(media|container)[^{]*\{/g, "@q{").replace(/[^{}]*\{/g, (m) => (m.startsWith("@q") ? m : "S{"));
    const server = breakpointCss(block.props.breakpoints, block.props.containerLayout, { block: ".jf-b-r1", layout: ".jf-b-r1 > .jf-section__inner" });
    expect(server).not.toBe("");
    expect(strip(canvasBreakpointCss(block))).toBe(strip(server));
    expect(canvasBreakpointCss(block)).toContain("@container jf-canvas");
  });
});

describe("plugin blocks", () => {
  it("show the plugin's own markup on the canvas, minus scripts and handlers", () => {
    const html = '<article class="acme-card"><h3 class="acme-card__title">Pro</h3><a class="acme-card__link" href="/p" onclick="x()">More</a><script>alert(1)</script></article>';
    const shown = document.createElement("div");
    shown.innerHTML = sanitizePluginPreviewHtml(html);
    const page = document.createElement("div");
    page.innerHTML = html;
    expect(outline(shown)).toEqual(outline(page));
    expect(shown.innerHTML).not.toContain("onclick");
  });
});
