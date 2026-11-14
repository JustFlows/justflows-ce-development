// SPDX-License-Identifier: MIT

import { sanitizeHtmlBlock, sanitizeRichText } from "./sanitize.js";
import { sanitizeHref, sanitizeMediaSrc } from "./safe-url.js";
import { sanitizeAnimationProp } from "./animation.js";
import { sanitizeBlockClassName, sanitizeBlockCss } from "./safe-css.js";
import { isPlacementShaped, sanitizePlacementProp } from "./layout.js";
import { sanitizeBlockStyleProp } from "./block-style.js";
import { normalizeDeviceList } from "./visibility.js";
import { sanitizeBlockBreakpoints, sanitizeContainerLayout, sanitizeStyleRef } from "./builder-values.js";
import { BLOCK_NODE_KEYS, sanitizeEditorMeta } from "./document-contract.js";


interface BlockLike {
  type?: unknown;
  props?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

const MEDIA_KEYS = new Set(["src", "imageSrc", "avatarSrc"]);
const HREF_KEYS = new Set(["href", "url"]);

function sanitizeLinkedItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const row = { ...(item as Record<string, unknown>) };
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") continue;
    if (MEDIA_KEYS.has(key)) row[key] = sanitizeMediaSrc(value);
    else if (HREF_KEYS.has(key)) row[key] = sanitizeHref(value);
  }
  if (Array.isArray(row["colors"])) {
    row["colors"] = row["colors"].map((color) => {
      if (!color || typeof color !== "object" || Array.isArray(color)) return color;
      const swatch = { ...(color as Record<string, unknown>) };
      if (typeof swatch["colorBg"] === "string" && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(swatch["colorBg"].trim())) {
        swatch["colorBg"] = "";
      }
      return swatch;
    });
  }
  return row;
}

function sanitizeProps(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const next = { ...props };

  if (type === "core.paragraph" || type === "core.quote") {
    if (typeof next["text"] === "string") next["text"] = sanitizeRichText(next["text"]);
  }
  if (type === "core.html" && typeof next["html"] === "string") {
    next["html"] = sanitizeHtmlBlock(next["html"]);
  }
  if ((type === "core.button" || type === "core.embed") && typeof next["url"] === "string") {
    next["url"] = sanitizeHref(next["url"]);
  }
  if (type === "core.cta" || type === "core.hero") {
    if (typeof next["buttonUrl"] === "string") next["buttonUrl"] = sanitizeHref(next["buttonUrl"]);
    if (typeof next["backgroundImage"] === "string") {
      next["backgroundImage"] = sanitizeMediaSrc(next["backgroundImage"]);
    }
  }
  if (["core.image", "core.video", "core.audio", "core.file", "core.cover", "core.media-text"].includes(type) && typeof next["src"] === "string") {
    next["src"] = sanitizeMediaSrc(next["src"]);
  }
  if (["core.video", "core.cover", "core.media-text"].includes(type) && typeof next["poster"] === "string") {
    next["poster"] = sanitizeMediaSrc(next["poster"]);
  }
  if (type === "core.list-item" && typeof next["text"] === "string") next["text"] = sanitizeRichText(next["text"]);
  if (type === "core.social-links" && Array.isArray(next["links"])) next["links"] = next["links"].map(sanitizeLinkedItem);
  if (type === "core.link-list" && Array.isArray(next["items"])) {
    next["items"] = next["items"].map((item) =>
      item && typeof item === "object" && "url" in item && typeof (item as { url: unknown }).url === "string"
        ? { ...item, url: sanitizeHref((item as { url: string }).url) }
        : item,
    );
  }

  if (!type.startsWith("core.")) {
    for (const key of ["cartUrl", "wishlistUrl", "writeHref", "ctaHref"]) {
      if (typeof next[key] === "string") next[key] = sanitizeHref(next[key] as string);
    }
    for (const key of ["images", "items"]) {
      if (Array.isArray(next[key])) {
        next[key] = (next[key] as unknown[]).map((item) => sanitizeLinkedItem(item));
      }
    }
  }

  if ("animation" in next) {
    const animation = sanitizeAnimationProp(next["animation"]);
    if (animation) next["animation"] = animation;
    else delete next["animation"];
  }

  // Presentation an editor attached to this block, on every type including
  // plugin blocks. Cleared here so nothing unusable is ever stored; the render
  // path re-checks rather than trusting what it reads back.
  if ("className" in next) {
    const className = sanitizeBlockClassName(next["className"]);
    if (className) next["className"] = className;
    else delete next["className"];
  }
  // "Show on devices" — a proper subset of desktop/tablet/mobile, else dropped.
  if ("devices" in next) {
    const devices = normalizeDeviceList(next["devices"]);
    if (devices) next["devices"] = devices;
    else delete next["devices"];
  }
  if ("css" in next) {
    const css = sanitizeBlockCss(next["css"]);
    if (css) next["css"] = css;
    else delete next["css"];
  }
  // Grid placement (col/span/row/rowSpan) lives under its own `gridPlacement`
  // key rather than the generic `layout` key, because `layout` is also where
  // block schemas put their own unrelated settings — the gallery block's
  // grid/masonry/carousel choice, for one. That used to share this key, so
  // saving a gallery block ran its "masonry" string through the placement
  // sanitizer, which didn't recognize the shape and silently deleted it.
  if ("gridPlacement" in next) {
    const placement = sanitizePlacementProp(next["gridPlacement"]);
    if (placement) next["gridPlacement"] = placement;
    else delete next["gridPlacement"];
  }
  // Migrate placement data saved under the old shared key. It is always a
  // plain object, so this can't mistake a block's own `layout` value (e.g. a
  // string) for placement data and destroy it.
  if (isPlacementShaped(next["layout"])) {
    const migrated = sanitizePlacementProp(next["layout"]);
    delete next["layout"];
    if (migrated && !("gridPlacement" in next)) next["gridPlacement"] = migrated;
  }
  // `style` is also a schema-owned select value on several blocks (for
  // example language switcher "flags" and color scheme "icons"). Only an
  // object-shaped value is the shared advanced block-style payload.
  if (next["style"] && typeof next["style"] === "object" && !Array.isArray(next["style"])) {
    const style = sanitizeBlockStyleProp(next["style"]);
    if (style) next["style"] = style;
    else delete next["style"];
  }

  /**
   * Builder 2.0 values (see `builder-values.ts`). Each key is namespaced so a
   * block schema's own props cannot collide with it; an invalid value is
   * dropped rather than stored.
   */
  if ("containerLayout" in next) {
    const layout = sanitizeContainerLayout(next["containerLayout"]);
    if (layout) next["containerLayout"] = layout;
    else delete next["containerLayout"];
  }
  if ("styleRef" in next) {
    const ref = sanitizeStyleRef(next["styleRef"]);
    if (ref) next["styleRef"] = ref;
    else delete next["styleRef"];
  }
  if ("breakpoints" in next) {
    const breakpoints = sanitizeBlockBreakpoints(next["breakpoints"]);
    if (breakpoints) next["breakpoints"] = breakpoints;
    else delete next["breakpoints"];
  }

  return next;
}

const NODE_KEYS = new Set<string>(BLOCK_NODE_KEYS);

/**
 * Hard limits for any stored block document (justflows-ce#309). The document
 * contract allows 32 levels; these are the safety ceiling past which a
 * document is hostile or broken, never a page an author built. Writes over
 * them are refused (see `measureBlockDocument`); the sanitizer itself never
 * throws, so a document over them that is already stored still renders, cut
 * off at the ceiling instead of overflowing the stack.
 */
export const BLOCK_DOCUMENT_MAX_DEPTH = 64;
export const BLOCK_DOCUMENT_MAX_NODES = 20_000;

/** Depth and node count of the block lists in a document, measured without recursion. */
export function measureBlockDocument(input: unknown): { depth: number; nodes: number } {
  let depth = 0;
  let nodes = 0;
  const roots = Array.isArray(input) ? input : Array.isArray((input as { blocks?: unknown } | null)?.blocks) ? (input as { blocks: unknown[] }).blocks : [];
  const stack: Array<{ list: unknown[]; level: number }> = [{ list: roots, level: 1 }];
  while (stack.length) {
    const { list, level } = stack.pop()!;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      nodes++;
      if (level > depth) depth = level;
      if (nodes > BLOCK_DOCUMENT_MAX_NODES || depth > BLOCK_DOCUMENT_MAX_DEPTH) return { depth, nodes };
      const kids = (item as { children?: unknown }).children;
      if (Array.isArray(kids) && kids.length) stack.push({ list: kids, level: level + 1 });
    }
  }
  return { depth, nodes };
}

/** Whether a document is within the hard limits. */
export function withinBlockDocumentLimits(input: unknown): boolean {
  const { depth, nodes } = measureBlockDocument(input);
  return depth <= BLOCK_DOCUMENT_MAX_DEPTH && nodes <= BLOCK_DOCUMENT_MAX_NODES;
}

function sanitizeNode(node: unknown, level = 1, budget = { nodes: 0 }): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as BlockLike;
  const type = typeof n.type === "string" ? n.type : "";
  const props = sanitizeProps(type, asRecord(n.props));
  /** Past the ceiling, children are dropped instead of recursing further. */
  const children = Array.isArray(n.children)
    ? level >= BLOCK_DOCUMENT_MAX_DEPTH
      ? []
      : n.children.filter(() => ++budget.nodes <= BLOCK_DOCUMENT_MAX_NODES).map((child) => sanitizeNode(child, level + 1, budget))
    : n.children;
  /**
   * Only contract keys are stored. Anything else on a node is transient editor
   * state (selection, drag, hover) and must never reach the database.
   */
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(n)) {
    if (NODE_KEYS.has(key) && key !== "editor") out[key] = value;
  }
  out["props"] = props;
  out["children"] = children;
  if ("editor" in n) {
    const editor = sanitizeEditorMeta(n["editor"]);
    if (editor) out["editor"] = editor;
  }
  return out;
}

/** Sanitize a stored block document before it is written to the database. */
export function sanitizeBlockDocument(input: unknown): { version: 1; blocks: unknown[] } {
  if (!input || typeof input !== "object") return { version: 1, blocks: [] };
  const doc = input as { blocks?: unknown };
  const budget = { nodes: 0 };
  const blocks = Array.isArray(doc.blocks)
    ? doc.blocks.filter(() => ++budget.nodes <= BLOCK_DOCUMENT_MAX_NODES).map((node) => sanitizeNode(node, 1, budget))
    : [];
  return { version: 1, blocks };
}
