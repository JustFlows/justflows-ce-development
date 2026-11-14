// SPDX-License-Identifier: MIT

import { sanitizeContainerLayout, type ContainerLayout } from "./builder-values.js";
import { DEVICE_MAX_MOBILE } from "./visibility.js";
import { injectRootAttrs } from "./animation.js";

/**
 * Rendering `props.containerLayout` (justflows-ce#299): rows, columns and
 * grids built from bounded choices instead of custom CSS.
 *
 * - The layout is written as classes plus a few declarations on the element
 *   that holds the children, so the public renderer, the builder canvas and
 *   the stylesheet below always agree.
 * - Source order is reading order. There is no reverse direction and no
 *   `order`, so what a screen reader reads is what the page shows, and a row
 *   that stacks on a phone keeps the same sequence.
 * - A block without `containerLayout` renders exactly as before.
 */

/**
 * Container blocks that accept a layout, and the class of the element inside
 * them that holds the children (`null` means the block's root element).
 */
export const CONTAINER_LAYOUT_TARGETS: Readonly<Record<string, string | null>> = {
  "core.section": "jf-section__inner",
  "core.container": null,
  "core.group": null,
  "core.column": null,
};

/** Containers whose root may render as another element; their root is always a plain `div`. */
export const CONTAINER_ELEMENT_TYPES: ReadonlySet<string> = new Set(["core.group", "core.container"]);

export function supportsContainerLayout(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTAINER_LAYOUT_TARGETS, type);
}

const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

const ALIGN: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

function space(step: string): string {
  return step === "0" ? "0" : `var(--space-${step})`;
}

export interface ContainerLayoutAttrs {
  classes: string[];
  /** Declarations without a trailing semicolon, keyed for React and joined for HTML. */
  style: Record<string, string>;
}

/**
 * Classes and declarations for a stored layout, or `null` when it sets no
 * display mode. Gap, justify and align only apply to a row or grid.
 */
export function containerLayoutAttrs(raw: unknown): ContainerLayoutAttrs | null {
  const layout = sanitizeContainerLayout(raw);
  if (!layout?.display) return null;
  const classes = ["jf-cl"];
  const style: Record<string, string> = {};
  const stacks = layout.stack !== "never";
  if (layout.display === "flex") {
    const direction = layout.direction ?? "row";
    classes.push("jf-cl-flex", direction === "row" ? "jf-cl-row" : "jf-cl-col");
    if (direction === "row" && stacks) classes.push("jf-cl-stack");
    style["flex-wrap"] = layout.wrap ?? (direction === "row" ? "wrap" : "nowrap");
    if (layout.justify) style["justify-content"] = JUSTIFY[layout.justify]!;
  } else {
    classes.push("jf-cl-grid");
    if (stacks) classes.push("jf-cl-stack");
    style["--jf-cl-cols"] = String(layout.columns ?? 2);
    /** In a grid, "justify" places each item within its track. */
    if (layout.justify && ["start", "center", "end"].includes(layout.justify)) {
      style["justify-items"] = JUSTIFY[layout.justify]!.replace("flex-", "");
    }
  }
  if (layout.align) style["align-items"] = ALIGN[layout.align]!;
  if (layout.gap) {
    style["gap"] = space(layout.gap);
    style["--jf-cl-gap"] = space(layout.gap);
  }
  return { classes, style };
}

function declarations(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

/**
 * Add classes and declarations to the first element carrying `className` (the
 * container's own children wrapper comes before any child markup), or to the
 * root element.
 */
function injectAt(html: string, className: string | null, classes: string[], style: string): string {
  if (!className) return injectRootAttrs(html, classes.join(" "), style, "");
  const match = new RegExp(`<[a-zA-Z][\\w-]*\\s[^>]*\\bclass="(?:[^"]*\\s)?${className}(?:\\s[^"]*)?"`).exec(html);
  if (!match) return html;
  const start = match.index;
  const end = html.indexOf(">", start);
  if (end < 0) return html;
  let tag = html.slice(start, end);
  const selfClosing = tag.endsWith("/");
  if (selfClosing) tag = tag.slice(0, -1);
  if (/\sclass="/.test(tag)) tag = tag.replace(/\sclass="([^"]*)"/, (_m, c: string) => ` class="${`${c} ${classes.join(" ")}`.trim()}"`);
  else tag += ` class="${classes.join(" ")}"`;
  if (style) {
    if (/\sstyle="/.test(tag)) tag = tag.replace(/\sstyle="([^"]*)"/, (_m, s: string) => ` style="${s ? `${s.replace(/;\s*$/, "")};` : ""}${style}"`);
    else tag += ` style="${style}"`;
  }
  return html.slice(0, start) + tag + (selfClosing ? "/" : "") + html.slice(end);
}

/** Swap a plain `div` root for an allowlisted element, keeping its attributes. */
function swapRootElement(html: string, element: string): string {
  const trimmed = html.trim();
  if (!trimmed.startsWith("<div") || !trimmed.endsWith("</div>") || !/^<div[\s>]/.test(trimmed)) return html;
  return `<${element}${trimmed.slice(4, -"</div>".length)}</${element}>`;
}

/**
 * Apply a node's `containerLayout` to its rendered HTML. Called by
 * `withBlockChrome` for every render path; a no-op for blocks without one and
 * for types that are not layout containers.
 */
export function applyContainerLayout(html: string, node: { type?: unknown; props?: unknown }): string {
  const type = typeof node.type === "string" ? node.type : "";
  if (!supportsContainerLayout(type)) return html;
  const raw = (node.props as Record<string, unknown> | undefined)?.["containerLayout"];
  if (!raw) return html;
  let out = html;
  const layout: ContainerLayout | undefined = sanitizeContainerLayout(raw);
  if (layout?.element && layout.element !== "div" && CONTAINER_ELEMENT_TYPES.has(type)) {
    out = swapRootElement(out, layout.element);
  }
  const attrs = containerLayoutAttrs(raw);
  if (!attrs) return out;
  return injectAt(out, CONTAINER_LAYOUT_TARGETS[type] ?? null, attrs.classes, declarations(attrs.style));
}

/**
 * Elements that may not contain each other. A `header` or `footer` inside
 * another `header` or `footer` is invalid HTML and confuses landmarks.
 */
const NO_NESTING: Record<string, readonly string[]> = {
  header: ["header", "footer"],
  footer: ["header", "footer"],
};

/** Whether `element` may render inside containers that render as `ancestors` (outermost first). */
export function containerElementAllowed(element: string, ancestors: readonly string[]): boolean {
  const blocked = NO_NESTING[element];
  if (!blocked) return true;
  return !ancestors.some((a) => (NO_NESTING[a] ?? []).includes(element) || blocked.includes(a));
}

/**
 * The platform rules behind the layout classes. Part of `/theme.css` (see
 * `assembleThemeCss`), so they work on every theme and inside the builder's
 * scoped preview. Rows and grids stack on phones unless the author said
 * never; stacking keeps source order.
 */
export const CONTAINER_LAYOUT_CSS = `/* Container layout (props.containerLayout) */
.jf-cl-flex { display: flex; }
.jf-cl-row { flex-direction: row; }
.jf-cl-col { flex-direction: column; }
.jf-cl-flex > * { flex-grow: var(--jf-grow, 0); flex-basis: var(--jf-basis, auto); min-width: 0; }
.jf-cl-grid { display: grid; grid-template-columns: repeat(var(--jf-cl-cols, 2), minmax(0, 1fr)); }
.jf-cl > * + * { margin-top: 0; }
@media (max-width: ${DEVICE_MAX_MOBILE}px) {
  .jf-cl-stack.jf-cl-row { flex-direction: column; }
  .jf-cl-stack.jf-cl-row > * { flex-basis: auto; }
  .jf-cl-stack.jf-cl-grid { grid-template-columns: minmax(0, 1fr); }
}
`;

export function containerLayoutCss(): string {
  return CONTAINER_LAYOUT_CSS;
}
