// SPDX-License-Identifier: MIT
import { withCoreInspectorConditions } from "./inspector-fields.js";
import type { BlockDefinition, BlockSchema } from "../registry/block-registry.js";
import { esc, sanitizeMediaSrc, safeMediaSrc } from "../safe-url.js";
import { sanitizeRichText, sanitizePlainText } from "../sanitize.js";

const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
const text = (raw: unknown, fallback = ""): string => typeof raw === "string" ? raw.slice(0, 50000) : fallback;
const flag = (raw: unknown, fallback = false): boolean => typeof raw === "boolean" ? raw : fallback;
const number = (raw: unknown, fallback: number, min = 0, max = 1000): number => {
  const value = Number(raw); return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
};
const choice = (raw: unknown, options: string[], fallback: string): string => options.includes(text(raw)) ? text(raw) : fallback;
const color = (raw: unknown, fallback: string): string => /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text(raw)) ? text(raw) : fallback;
const select = (options: string[], value: string): BlockSchema[string] => ({ type: "select", options, default: value });
const bool = (value = false): BlockSchema[string] => ({ type: "boolean", default: value });
const num = (value: number): BlockSchema[string] => ({ type: "number", default: value });
const txt = (value = ""): BlockSchema[string] => ({ type: "text", default: value });

function define(type: string, title: string, category: string, schema: BlockSchema,
  validate: (r: Record<string, unknown>) => Record<string, unknown>,
  render: BlockDefinition["render"], children?: string[] | true): BlockDefinition {
  return { type: `core.${type}`, title, version: 1, category, icon: "▧", schema: withCoreInspectorConditions(type, schema),
    validateProps: raw => validate(record(raw)), render,
    ...(children ? { supportsChildren: true, ...(children === true ? {} : { allowedChildTypes: children }) } : {}),
  };
}

export const ICON_PATHS: Record<string, string> = {
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  check: 'm4 12 5 5L20 6', arrow: 'M4 12h16m-6-6 6 6-6 6',
  info: 'M12 11v6m0-10v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  warning: 'm12 3 10 18H2Zm0 6v5m0 3v.01',
  mail: 'M3 5h18v14H3Zm0 0 9 7 9-7', phone: 'M4 3h4l2 5-3 2a16 16 0 0 0 7 7l2-3 5 2v4C11 23 1 13 4 3Z',
  location: 'M12 22s8-7 8-13a8 8 0 1 0-16 0c0 6 8 13 8 13Zm3-13a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  calendar: 'M4 5h16v16H4Zm0 5h16M8 2v6m8-6v6',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  shield: 'm12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Zm-4 10 3 3 5-6',
};

export const functionalBlocks: BlockDefinition[] = [
  define("list", "List", "content", { listStyle: select(["bullet", "numbered", "checklist"], "bullet"), start: num(1), reversed: bool(), marker: select(["disc", "circle", "square", "decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"], "disc"), gap: num(8) },
    r => ({ listStyle: choice(r["listStyle"], ["bullet", "numbered", "checklist"], "bullet"), start: number(r["start"], 1, 1, 100000), reversed: flag(r["reversed"]), marker: choice(r["marker"], ["disc", "circle", "square", "decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"], "disc"), gap: number(r["gap"], 8, 0, 100) }),
    (p, children = "") => { const ordered = p["listStyle"] === "numbered", tag = ordered ? "ol" : "ul";
      const marker = ordered && ["disc", "circle", "square"].includes(String(p["marker"])) ? "decimal" : p["marker"];
      return `<${tag} class="jf-list${p["listStyle"] === "checklist" ? " jf-list--checklist" : ""}"${ordered ? ` start="${p["start"]}"${p["reversed"] ? " reversed" : ""}` : ""} style="list-style-type:${marker};--jf-list-gap:${p["gap"]}px">${children}</${tag}>`; }, ["core.list-item"]),
  define("list-item", "List item", "content", { text: { type: "richtext", default: "" }, checked: bool() },
    r => ({ text: sanitizeRichText(text(r["text"])), checked: flag(r["checked"]) }),
    (p, children = "") => `<li class="jf-list-item"><label class="jf-list-check"><input type="checkbox"${p["checked"] ? " checked" : ""} aria-label="${esc(sanitizePlainText(String(p["text"])) || "Checklist item")}"></label><div class="jf-list-item-content">${p["text"]}${children}</div></li>`, ["core.list"]),
  define("table", "Table", "content", { caption: txt(), rows: { type: "textarea", default: [["", ""], ["", ""]] }, header: bool(true), footer: bool(), striped: bool(true), borders: bool(true), fixedLayout: bool(), align: select(["left", "center", "right"], "left"), cellPadding: num(12) },
    r => ({ caption: text(r["caption"]), rows: (Array.isArray(r["rows"]) ? r["rows"] : []).slice(0, 100).map(row => (Array.isArray(row) ? row : []).slice(0, 20).map(cell => text(cell))), header: flag(r["header"], true), footer: flag(r["footer"]), striped: flag(r["striped"], true), borders: flag(r["borders"], true), fixedLayout: flag(r["fixedLayout"]), align: choice(r["align"], ["left", "center", "right"], "left"), cellPadding: number(r["cellPadding"], 12, 0, 64) }),
    p => { const rows = p["rows"] as string[][]; const width = Math.max(0, ...rows.map(row => row.length));
      const rowHtml = (row: string[], header = false) => `<tr>${Array.from({ length: width }, (_, i) => header ? `<th scope="col">${esc(row[i] || "")}</th>` : `<td>${esc(row[i] || "")}</td>`).join("")}</tr>`;
      const hasHeader = Boolean(p["header"] && rows.length), hasFooter = Boolean(p["footer"] && rows.length > (hasHeader ? 1 : 0));
      return `<figure class="jf-table-wrap"><table class="jf-table${p["striped"] ? " jf-table--striped" : ""}${p["borders"] ? " jf-table--bordered" : ""}" style="table-layout:${p["fixedLayout"] ? "fixed" : "auto"};text-align:${p["align"]};--jf-cell-padding:${p["cellPadding"]}px">${p["caption"] ? `<caption>${esc(String(p["caption"]))}</caption>` : ""}${hasHeader ? `<thead>${rowHtml(rows[0]!, true)}</thead>` : ""}<tbody>${rows.slice(hasHeader ? 1 : 0, hasFooter ? -1 : undefined).map(row => rowHtml(row)).join("")}</tbody>${hasFooter ? `<tfoot>${rowHtml(rows[rows.length - 1]!)}</tfoot>` : ""}</table></figure>`; }),
  define("details", "Details", "content", { summary: txt("Details"), open: bool(), marker: select(["arrow", "plus", "none"], "arrow") },
    r => ({ summary: text(r["summary"], "Details"), open: flag(r["open"]), marker: choice(r["marker"], ["arrow", "plus", "none"], "arrow") }),
    (p, children = "") => `<details class="jf-details jf-details--${p["marker"]}"${p["open"] ? " open" : ""}><summary>${esc(String(p["summary"]))}</summary><div class="jf-details-content">${children}</div></details>`, true),
  define("accordion", "Accordion", "content", { exclusive: bool(true), gap: num(8) },
    r => ({ exclusive: flag(r["exclusive"], true), gap: number(r["gap"], 8, 0, 100) }),
    (p, children = "") => `<div class="jf-accordion" data-jf-exclusive="${p["exclusive"]}" style="gap:${p["gap"]}px">${children}</div>`, ["core.details"]),
  define("cover", "Cover", "media", { mediaType: select(["image", "video"], "image"), src: { type: "url" }, alt: txt(), poster: { type: "media" }, minHeight: num(400), overlayColor: txt("#000000"), overlayOpacity: num(40), position: select(["top", "center", "bottom"], "center"), align: select(["left", "center", "right"], "center"), focalX: num(50), focalY: num(50), loop: bool(true), playLabel: txt("Play background video"), pauseLabel: txt("Pause background video") },
    r => ({ mediaType: choice(r["mediaType"], ["image", "video"], "image"), src: sanitizeMediaSrc(text(r["src"])), alt: text(r["alt"]), poster: sanitizeMediaSrc(text(r["poster"])), minHeight: number(r["minHeight"], 400, 0, 2000), overlayColor: color(r["overlayColor"], "#000000"), overlayOpacity: number(r["overlayOpacity"], 40, 0, 100), position: choice(r["position"], ["top", "center", "bottom"], "center"), align: choice(r["align"], ["left", "center", "right"], "center"), focalX: number(r["focalX"], 50, 0, 100), focalY: number(r["focalY"], 50, 0, 100), loop: flag(r["loop"], true), playLabel: text(r["playLabel"], "Play background video"), pauseLabel: text(r["pauseLabel"], "Pause background video") }),
    (p, children = "") => { const src = safeMediaSrc(String(p["src"])); const mediaStyle = `object-position:${p["focalX"]}% ${p["focalY"]}%`;
      const media = !src ? "" : p["mediaType"] === "video" ? `<video class="jf-cover-media" src="${src}"${p["poster"] ? ` poster="${safeMediaSrc(String(p["poster"]))}"` : ""} muted playsinline autoplay${p["loop"] ? " loop" : ""} preload="metadata" aria-hidden="true" style="${mediaStyle}"></video><button class="jf-cover-playback" type="button" data-jf-cover-toggle data-jf-play-label="${esc(String(p["playLabel"]))}" data-jf-pause-label="${esc(String(p["pauseLabel"]))}" aria-label="${esc(String(p["pauseLabel"]))}">Ⅱ</button>` : `<img class="jf-cover-media" src="${src}" alt="${esc(String(p["alt"]))}" loading="lazy" style="${mediaStyle}">`;
      return `<section class="jf-cover" style="min-height:${p["minHeight"]}px;justify-content:${p["position"] === "top" ? "flex-start" : p["position"] === "bottom" ? "flex-end" : "center"};text-align:${p["align"]}">${media}<span class="jf-cover-overlay" aria-hidden="true" style="background:${p["overlayColor"]};opacity:${Number(p["overlayOpacity"]) / 100}"></span><div class="jf-cover-content">${children}</div></section>`; }, true),
  define("media-text", "Media & Text", "media", { mediaType: select(["image", "video"], "image"), src: { type: "url" }, alt: txt(), poster: { type: "media" }, mediaSide: select(["left", "right"], "left"), mediaWidth: num(50), gap: num(32), verticalAlign: select(["start", "center", "end"], "center"), stackOnMobile: bool(true), objectFit: select(["contain", "cover"], "cover") },
    r => ({ mediaType: choice(r["mediaType"], ["image", "video"], "image"), src: sanitizeMediaSrc(text(r["src"])), alt: text(r["alt"]), poster: sanitizeMediaSrc(text(r["poster"])), mediaSide: choice(r["mediaSide"], ["left", "right"], "left"), mediaWidth: number(r["mediaWidth"], 50, 10, 90), gap: number(r["gap"], 32, 0, 200), verticalAlign: choice(r["verticalAlign"], ["start", "center", "end"], "center"), stackOnMobile: flag(r["stackOnMobile"], true), objectFit: choice(r["objectFit"], ["contain", "cover"], "cover") }),
    (p, children = "") => { const src = safeMediaSrc(String(p["src"])); const visual = !src ? "" : p["mediaType"] === "video" ? `<video src="${src}"${p["poster"] ? ` poster="${safeMediaSrc(String(p["poster"]))}"` : ""} controls playsinline preload="metadata" style="object-fit:${p["objectFit"]}"></video>` : `<img src="${src}" alt="${esc(String(p["alt"]))}" loading="lazy" style="object-fit:${p["objectFit"]}">`;
      return `<div class="jf-media-text${p["stackOnMobile"] ? " jf-media-text--stack" : ""}${p["mediaSide"] === "right" ? " jf-media-text--right" : ""}" style="--jf-media-width:${p["mediaWidth"]}%;gap:${p["gap"]}px;align-items:${p["verticalAlign"]}"><div class="jf-media-text-media">${visual}</div><div class="jf-media-text-content">${children}</div></div>`; }, true),
  define("buttons", "Buttons", "layout", { align: select(["left", "center", "right", "between"], "left"), direction: select(["row", "column"], "row"), gap: num(12), wrap: bool(true) },
    r => ({ align: choice(r["align"], ["left", "center", "right", "between"], "left"), direction: choice(r["direction"], ["row", "column"], "row"), gap: number(r["gap"], 12, 0, 100), wrap: flag(r["wrap"], true) }),
    (p, children = "") => `<div class="jf-buttons" style="display:flex;flex-direction:${p["direction"]};flex-wrap:${p["wrap"] ? "wrap" : "nowrap"};gap:${p["gap"]}px;justify-content:${p["align"] === "between" ? "space-between" : p["align"] === "left" ? "flex-start" : p["align"] === "right" ? "flex-end" : "center"}">${children}</div>`, ["core.button"]),
  define("card", "Card", "layout", { padding: num(24), gap: num(16), border: bool(true), radius: num(12), shadow: select(["none", "small", "medium", "large"], "small"), align: select(["left", "center", "right"], "left") },
    r => ({ padding: number(r["padding"], 24, 0, 200), gap: number(r["gap"], 16, 0, 100), border: flag(r["border"], true), radius: number(r["radius"], 12, 0, 100), shadow: choice(r["shadow"], ["none", "small", "medium", "large"], "small"), align: choice(r["align"], ["left", "center", "right"], "left") }),
    (p, children = "") => `<div class="jf-card jf-card--shadow-${p["shadow"]}" style="padding:${p["padding"]}px;gap:${p["gap"]}px;border:${p["border"] ? "1px solid var(--color-border,#ddd)" : "0"};border-radius:${p["radius"]}px;text-align:${p["align"]}">${children}</div>`, true),
  define("icon", "Icon", "content", { name: select(Object.keys(ICON_PATHS), "star"), label: txt(), decorative: bool(true), size: num(32), color: txt("#334155"), strokeWidth: num(2) },
    r => ({ name: choice(r["name"], Object.keys(ICON_PATHS), "star"), label: text(r["label"]), decorative: flag(r["decorative"], true), size: number(r["size"], 32, 8, 256), color: color(r["color"], "#334155"), strokeWidth: number(r["strokeWidth"], 2, 1, 6) }),
    p => `<span class="jf-icon"${p["decorative"] ? ' aria-hidden="true"' : ` role="img" aria-label="${esc(String(p["label"]) || String(p["name"]))}"`}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${p["size"]}" height="${p["size"]}" fill="none" stroke="${p["color"]}" stroke-width="${p["strokeWidth"]}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[String(p["name"])]}"></path></svg></span>`),
  define("callout", "Notice / Callout", "content", { title: txt(), variant: select(["info", "success", "warning", "error", "neutral"], "info"), showIcon: bool(true), dismissible: bool(), dismissLabel: txt("Dismiss notice") },
    r => ({ title: text(r["title"]), variant: choice(r["variant"], ["info", "success", "warning", "error", "neutral"], "info"), showIcon: flag(r["showIcon"], true), dismissible: flag(r["dismissible"]), dismissLabel: text(r["dismissLabel"], "Dismiss notice") }),
    (p, children = "") => `<aside class="jf-callout jf-callout--${p["variant"]}">${p["showIcon"] ? `<span class="jf-callout-icon" aria-hidden="true">${p["variant"] === "success" ? "✓" : p["variant"] === "warning" ? "⚠" : p["variant"] === "error" ? "!" : "ⓘ"}</span>` : ""}<div class="jf-callout-content">${p["title"] ? `<strong class="jf-callout-title">${esc(String(p["title"]))}</strong>` : ""}${children}</div>${p["dismissible"] ? `<button type="button" data-jf-dismiss aria-label="${esc(String(p["dismissLabel"]))}">×</button>` : ""}</aside>`, true),
  define("tabs", "Tabs", "content", { label: txt("Tabbed content"), orientation: select(["horizontal", "vertical"], "horizontal"), activation: select(["automatic", "manual"], "automatic"), selected: num(1) },
    r => ({ label: text(r["label"], "Tabbed content"), orientation: choice(r["orientation"], ["horizontal", "vertical"], "horizontal"), activation: choice(r["activation"], ["automatic", "manual"], "automatic"), selected: number(r["selected"], 1, 1, 100) }),
    (p, children = "") => `<div class="jf-tabs" data-jf-label="${esc(String(p["label"]))}" data-jf-orientation="${p["orientation"]}" data-jf-activation="${p["activation"]}" data-jf-selected="${p["selected"]}">${children}</div>`, ["core.tab"]),
  define("tab", "Tab panel", "content", { title: txt("Tab") }, r => ({ title: text(r["title"], "Tab") }),
    (p, children = "") => `<section class="jf-tab" data-jf-title="${esc(String(p["title"]))}"><h3 class="jf-tab-heading">${esc(String(p["title"]))}</h3>${children}</section>`, true),
];

/** List items are edited in place on the canvas, with the list's own inline formatting. */
for (const block of functionalBlocks) {
  if (block.type === "core.list-item") block.inline = { text: { mode: "rich", multiline: false, formats: ["bold", "italic", "underline", "link", "code"] } };
}
