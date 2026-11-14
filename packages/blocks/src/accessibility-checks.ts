// SPDX-License-Identifier: MIT

import { parseBlockPlacement } from "./layout.js";
import { normalizeDeviceList } from "./visibility.js";

/**
 * Authoring checks for common accessibility problems in a block document
 * (justflows-ce#307).
 *
 * These help authors; they do not certify anything. They only look at what
 * the stored document says, so they cannot see what a theme, a plugin's
 * render or the visitor's settings change. Where a check cannot decide, it
 * says so with severity `unavailable` instead of guessing.
 *
 * - `error`: almost certainly a barrier (a link with no text, an empty heading).
 * - `warning`: often a problem, worth a look (missing alt text, a skipped
 *   heading level, a reading order that differs from the visual order).
 * - `unavailable`: this check could not be run for the block.
 */

export type AccessibilitySeverity = "error" | "warning" | "unavailable";

export type AccessibilityCheckCode =
  | "image-alt"
  | "link-text"
  | "link-target"
  | "heading-empty"
  | "heading-skip"
  | "heading-level-one"
  | "contrast"
  | "contrast-unknown"
  | "hidden-on-mobile"
  | "reading-order"
  | "icon-label"
  | "table-header"
  | "content-unchecked";

/** Inspector tab where the author fixes the problem. */
export type AccessibilityFixTab = "content" | "style" | "layout" | "responsive";

export interface AccessibilityIssue {
  code: AccessibilityCheckCode;
  severity: AccessibilitySeverity;
  blockId: string;
  type: string;
  /** The prop to change, when there is one. */
  field?: string;
  tab: AccessibilityFixTab;
  /** Values for the message, such as heading levels or a contrast ratio. */
  params?: Record<string, string | number>;
}

interface Node {
  id?: unknown;
  type?: unknown;
  props?: unknown;
  children?: unknown;
}

export interface AccessibilityCheckOptions {
  /** Block types the document may contain that the checks cannot look inside (plugin and theme blocks). */
  isOpaqueType?: (type: string) => boolean;
  /** Level of the heading the page shows above its content (the page title). Default 1. */
  startLevel?: number;
}

const MAX_NODES = 5_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : "";
}

function props(node: Node): Record<string, unknown> {
  return node.props && typeof node.props === "object" && !Array.isArray(node.props) ? (node.props as Record<string, unknown>) : {};
}

function children(node: Node): Node[] {
  return Array.isArray(node.children) ? (node.children as Node[]).filter((c) => c && typeof c === "object") : [];
}

function hasUrl(value: unknown): boolean {
  const url = typeof value === "string" ? value.trim() : "";
  return url !== "" && url !== "#";
}

/** A heading level the public renderer writes for this block, or null. */
function headingLevel(type: string, p: Record<string, unknown>): number | null {
  switch (type) {
    case "core.heading": {
      const level = Number(p["level"]);
      return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
    }
    case "core.hero":
      return text(p["heading"]) ? 1 : null;
    case "core.cta":
      return text(p["heading"]) ? 2 : null;
    case "core.link-list":
      return text(p["heading"]) ? 3 : null;
    case "core.tab":
      return 3;
    default:
      return null;
  }
}

/** sRGB colour from `#rgb`, `#rrggbb` (alpha ignored when opaque) or `rgb()`; null when it cannot be known here. */
export function parseColor(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "white") return [255, 255, 255];
  if (v === "black") return [0, 0, 0];
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    const [r, g, b, a] = m[1]!.split("").map((c) => parseInt(c + c, 16));
    return a !== undefined && a < 255 ? null : [r!, g!, b!];
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) {
    if (m[2] && parseInt(m[2], 16) < 255) return null;
    return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as [number, number, number];
  }
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && (m[4].endsWith("%") ? parseFloat(m[4]) < 100 : parseFloat(m[4]) < 1)) return null;
    return [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n))) as [number, number, number];
  }
  return null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Blocks whose own text sits on their own (or an inherited) background. */
const TEXT_BLOCKS = new Set([
  "core.paragraph", "core.heading", "core.quote", "core.button", "core.list-item", "core.hero", "core.cta",
  "core.callout", "core.link-list", "core.details", "core.tab", "core.code",
]);

/** Inline styles a block stores, for colours. */
function styleColors(p: Record<string, unknown>): { text?: string; background?: string } {
  const style = p["style"] && typeof p["style"] === "object" ? (p["style"] as Record<string, unknown>) : {};
  return {
    ...(typeof style["textColor"] === "string" && style["textColor"] ? { text: style["textColor"] } : {}),
    ...(typeof style["background"] === "string" && style["background"] ? { background: style["background"] } : {}),
  };
}

export function checkAccessibility(blocks: unknown, options: AccessibilityCheckOptions = {}): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  const add = (node: Node, issue: Omit<AccessibilityIssue, "blockId" | "type">) =>
    issues.push({ blockId: String(node.id ?? ""), type: String(node.type ?? ""), ...issue });
  let previousLevel = options.startLevel ?? 1;
  let seen = 0;
  const opaqueReported = new Set<string>();

  const visit = (list: Node[], inherited: { text?: string; background?: string }) => {
    for (const node of list) {
      if (++seen > MAX_NODES) return;
      const type = typeof node.type === "string" ? node.type : "";
      const p = props(node);

      if (!type.startsWith("core.") && options.isOpaqueType?.(type) !== false && !opaqueReported.has(type)) {
        opaqueReported.add(type);
        add(node, { code: "content-unchecked", severity: "unavailable", tab: "content" });
      }
      if (type === "core.html" && text(p["html"])) add(node, { code: "content-unchecked", severity: "unavailable", tab: "content" });

      /** Images. */
      if (type === "core.image" && hasUrl(p["src"]) && !text(p["alt"])) add(node, { code: "image-alt", severity: "warning", field: "alt", tab: "content" });
      if (type === "core.media-text" && p["mediaType"] !== "video" && hasUrl(p["src"]) && !text(p["alt"])) {
        add(node, { code: "image-alt", severity: "warning", field: "alt", tab: "content" });
      }

      /** Links and buttons. */
      if (type === "core.button") {
        if (!text(p["label"])) add(node, { code: "link-text", severity: "error", field: "label", tab: "content" });
        else if (!hasUrl(p["url"])) add(node, { code: "link-target", severity: "warning", field: "url", tab: "content" });
      }
      if (type === "core.hero" || type === "core.cta") {
        const label = text(p["buttonLabel"]);
        if (hasUrl(p["buttonUrl"]) && !label) add(node, { code: "link-text", severity: "error", field: "buttonLabel", tab: "content" });
        else if (label && !hasUrl(p["buttonUrl"])) add(node, { code: "link-target", severity: "warning", field: "buttonUrl", tab: "content" });
      }
      if (type === "core.link-list" && Array.isArray(p["items"])) {
        (p["items"] as Array<Record<string, unknown>>).forEach((item, index) => {
          if (item && hasUrl(item["url"]) && !text(item["label"])) {
            add(node, { code: "link-text", severity: "error", field: "items", tab: "content", params: { item: index + 1 } });
          }
        });
      }
      /** A meaningful icon without a label is announced by its icon name ("star"). */
      if (type === "core.icon" && p["decorative"] === false && !text(p["label"])) add(node, { code: "icon-label", severity: "warning", field: "label", tab: "content" });
      if (type === "core.table" && p["header"] === false) add(node, { code: "table-header", severity: "warning", field: "header", tab: "content" });

      /** Headings, in the order a screen reader meets them. */
      const level = headingLevel(type, p);
      if (level !== null) {
        if (type === "core.heading" && !text(p["text"])) add(node, { code: "heading-empty", severity: "error", field: "text", tab: "content" });
        else {
          if (type === "core.heading" && level === 1) add(node, { code: "heading-level-one", severity: "warning", field: "level", tab: "content" });
          if (level > previousLevel + 1) {
            add(node, { code: "heading-skip", severity: "warning", ...(type === "core.heading" ? { field: "level" } : {}), tab: "content", params: { from: previousLevel, to: level } });
          }
          previousLevel = level;
        }
      }

      /** Visibility. */
      const devices = normalizeDeviceList(p["devices"]);
      if (devices && !devices.includes("mobile") && (level !== null || type === "core.button")) {
        add(node, { code: "hidden-on-mobile", severity: "warning", field: "devices", tab: "responsive" });
      }

      /** Reading order: breakpoint `order` overrides, and grid placement out of document order. */
      const breakpoints = p["breakpoints"] && typeof p["breakpoints"] === "object" ? (p["breakpoints"] as Record<string, Record<string, unknown> | undefined>) : {};
      if (Object.values(breakpoints).some((layer) => layer && layer["order"] !== undefined)) {
        add(node, { code: "reading-order", severity: "warning", tab: "responsive" });
      }
      if (type === "core.grid") {
        const columns = Number(p["columns"]) || 12;
        const kids = children(node);
        const shown = kids
          .map((child, index) => ({ index, placement: parseBlockPlacement(props(child)["gridPlacement"] ?? props(child)["layout"], columns) }))
          .sort((a, b) => {
            const ar = a.placement.row > 0 ? a.placement.row : Number.POSITIVE_INFINITY;
            const br = b.placement.row > 0 ? b.placement.row : Number.POSITIVE_INFINITY;
            if (ar !== br) return ar - br;
            if (a.placement.row > 0 && a.placement.col !== b.placement.col) return a.placement.col - b.placement.col;
            return a.index - b.index;
          });
        if (shown.some((entry, i) => entry.index !== i)) add(node, { code: "reading-order", severity: "warning", tab: "layout" });
      }

      /** Contrast, only where the document sets colours. */
      const own = styleColors(p);
      const colors = { ...inherited, ...own };
      if (TEXT_BLOCKS.has(type) && (own.text || own.background)) {
        const fg = colors.text ? parseColor(colors.text) : null;
        const bg = colors.background ? parseColor(colors.background) : null;
        if (fg && bg) {
          const ratio = contrastRatio(fg, bg);
          if (ratio < 4.5) {
            add(node, { code: "contrast", severity: ratio < 3 ? "error" : "warning", field: own.text ? "textColor" : "background", tab: "style", params: { ratio: Math.floor(ratio * 10) / 10 } });
          }
        } else {
          add(node, { code: "contrast-unknown", severity: "unavailable", field: own.text ? "textColor" : "background", tab: "style" });
        }
      }

      visit(children(node), colors);
    }
  };

  visit(Array.isArray(blocks) ? (blocks as Node[]) : [], {});
  return issues;
}
