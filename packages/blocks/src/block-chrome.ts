// SPDX-License-Identifier: MIT

import { injectRootAttrs, withBlockAnimation } from "./animation.js";
import { applyContainerLayout } from "./container-layout.js";
import { blockScopeClass, sanitizeBlockClassName, scopeBlockCss } from "./safe-css.js";
import { isDefaultPlacement, isPlacementShaped, parseBlockPlacement, placementStyleVars } from "./layout.js";
import { blockStyleDeclarations, parseBlockStyle } from "./block-style.js";
import { deviceVisibilityAttr } from "./visibility.js";

/** The parts of a stored block that presentation reads. */
export interface BlockChromeNode {
  /** Block type. A plugin block's type is marked in the output (see {@link blockAssetMarker}). */
  type?: unknown;
  id?: unknown;
  props?: unknown;
}

const MARKED_BLOCK_TYPE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Core block types the host asked to mark (see {@link markBlockTypes}). */
const markedCoreTypes = new Set<string>();

/** Whether `type` is a plain block id a marker comment can carry. */
export function isMarkableBlockType(type: unknown): type is string {
  return typeof type === "string" && MARKED_BLOCK_TYPE.test(type) && !type.includes("--");
}

/**
 * Also mark these core block types, because something (the active theme) has
 * assets for them. Process-wide and only ever growing: an extra marker is an
 * inert comment, and which assets a page gets is still decided per site.
 */
export function markBlockTypes(types: Iterable<string>): void {
  for (const type of types) {
    if (isMarkableBlockType(type) && type.startsWith("core.")) markedCoreTypes.add(type);
  }
}

/**
 * The comment a rendered block carries so the host can tell which block types
 * a finished page contains, including blocks in cached fragments, and load
 * their per-block assets only there. Every plugin block is marked; a core
 * block only once {@link markBlockTypes} named it. "" when unmarked, and for a
 * type that is not a plain block id.
 */
export function blockAssetMarker(type: unknown): string {
  if (!isMarkableBlockType(type)) return "";
  if (type.startsWith("core.") && !markedCoreTypes.has(type)) return "";
  return `<!--jf-block:${type}-->`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Apply everything the page builder attaches to a block's rendered HTML that
 * the block's own `render` knows nothing about: animation, editor-supplied
 * classes, and the block's own CSS.
 *
 * The CSS rides along as a `<style>` element in front of the markup rather than
 * being collected into the page head. That keeps it inside the one function
 * that already has both the node and its HTML, so every render path — nested
 * children, plugin blocks, the forms block — gets it by construction instead of
 * by remembering to thread a collector through. It needs `style-src` to allow
 * inline styles, which the shipped Content-Security-Policy default does.
 */
export function withBlockChrome(html: string, node: BlockChromeNode): string {
  if (!html.trim()) return html;
  const props = asRecord(node.props);

  /** Layout first: it may swap the root element that the attributes below are added to. */
  let out = withBlockAnimation(applyContainerLayout(html, node), props);

  const classes: string[] = [];
  const custom = sanitizeBlockClassName(props["className"]);
  if (custom) classes.push(custom);

  const scope = blockScopeClass(node.id);
  const css = scope ? scopeBlockCss(props["css"], `.${scope}`) : "";
  if (css) classes.push(scope);

  // Grid placement and per-block spacing both ride on the item itself, and both
  // are emitted only when set, so an untouched block carries no attributes at
  // all. Placement first: it is what a media query later overrides.
  const declarations: string[] = [];
  const placementSource = props["gridPlacement"] ?? (isPlacementShaped(props["layout"]) ? props["layout"] : undefined);
  if (placementSource) {
    const placement = parseBlockPlacement(placementSource);
    if (!isDefaultPlacement(placement)) declarations.push(placementStyleVars(placement));
  }
  if (props["style"]) {
    const spacing = blockStyleDeclarations(parseBlockStyle(props["style"]));
    if (spacing) declarations.push(spacing);
  }
  const styleVars = declarations.join(";");

  // "Show on devices" — hidden off-range by the platform CSS (blockVisibilityCss).
  const dataAttrs = deviceVisibilityAttr(props["devices"]);

  if (classes.length > 0 || styleVars || dataAttrs) {
    out = injectRootAttrs(out, classes.join(" "), styleVars, dataAttrs);
  }

  out += blockAssetMarker(node.type);
  return css ? `<style>${css}</style>\n${out}` : out;
}
