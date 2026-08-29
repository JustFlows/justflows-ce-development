// SPDX-License-Identifier: MIT

import { sanitizeHtmlBlock, sanitizeRichText } from "./sanitize.js";
import { sanitizeHref, sanitizeMediaSrc } from "./safe-url.js";
import { sanitizeAnimationProp } from "./animation.js";
import { sanitizeBlockClassName, sanitizeBlockCss } from "./safe-css.js";
import { isPlacementShaped, sanitizePlacementProp } from "./layout.js";
import { sanitizeBlockStyleProp } from "./block-style.js";


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

const SHOP_MEDIA_KEYS = new Set(["src", "imageSrc", "avatarSrc"]);
const SHOP_HREF_KEYS = new Set(["href", "url"]);

function sanitizeShopMediaItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const row = { ...(item as Record<string, unknown>) };
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") continue;
    if (SHOP_MEDIA_KEYS.has(key)) row[key] = sanitizeMediaSrc(value);
    else if (SHOP_HREF_KEYS.has(key)) row[key] = sanitizeHref(value);
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
  if (type === "core.image" && typeof next["src"] === "string") {
    next["src"] = sanitizeMediaSrc(next["src"]);
  }
  if (type === "core.link-list" && Array.isArray(next["items"])) {
    next["items"] = next["items"].map((item) =>
      item && typeof item === "object" && "url" in item && typeof (item as { url: unknown }).url === "string"
        ? { ...item, url: sanitizeHref((item as { url: string }).url) }
        : item,
    );
  }

  if (type.startsWith("justflows.shop.")) {
    for (const key of ["cartUrl", "wishlistUrl", "writeHref", "ctaHref"]) {
      if (typeof next[key] === "string") next[key] = sanitizeHref(next[key] as string);
    }
    for (const key of ["images", "items"]) {
      if (Array.isArray(next[key])) {
        next[key] = (next[key] as unknown[]).map((item) => sanitizeShopMediaItem(item));
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
  if ("style" in next) {
    const style = sanitizeBlockStyleProp(next["style"]);
    if (style) next["style"] = style;
    else delete next["style"];
  }

  return next;
}

function sanitizeNode(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as BlockLike;
  const type = typeof n.type === "string" ? n.type : "";
  const props = sanitizeProps(type, asRecord(n.props));
  const children = Array.isArray(n.children) ? n.children.map(sanitizeNode) : n.children;
  return { ...n, props, children };
}

/** Sanitize a stored block document before it is written to the database. */
export function sanitizeBlockDocument(input: unknown): { version: 1; blocks: unknown[] } {
  if (!input || typeof input !== "object") return { version: 1, blocks: [] };
  const doc = input as { blocks?: unknown };
  const blocks = Array.isArray(doc.blocks) ? doc.blocks.map(sanitizeNode) : [];
  return { version: 1, blocks };
}
