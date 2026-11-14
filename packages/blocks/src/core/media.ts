// SPDX-License-Identifier: MIT
import type { BlockDefinition, BlockSchema } from "../registry/block-registry.js";
import { esc, safeMediaSrc, sanitizeMediaSrc } from "../safe-url.js";

const text = (value: unknown): string => typeof value === "string" ? value : "";
const flag = (value: unknown, fallback = false): boolean => typeof value === "boolean" ? value : fallback;
const dimension = (value: unknown): number => Math.min(10000, Math.max(0, Math.round(Number(value) || 0)));

const playbackSchema: BlockSchema = {
  src: { type: "url", required: true },
  caption: { type: "text" },
  controls: { type: "boolean", default: true },
  autoplay: { type: "boolean", default: false },
  muted: { type: "boolean", default: false },
  loop: { type: "boolean", default: false },
  preload: { type: "select", options: ["none", "metadata", "auto"], default: "metadata" },
};

function playbackBlock(kind: "video" | "audio"): BlockDefinition {
  return {
    type: `core.${kind}`,
    version: 1,
    inline: { caption: { mode: "plain", maxLength: 500 } },
    title: kind === "video" ? "Video" : "Audio",
    icon: kind === "video" ? "▶" : "♫",
    category: "media",
    schema: kind === "video" ? {
      ...playbackSchema,
      poster: { type: "url" },
      playsInline: { type: "boolean", default: true },
      width: { type: "number", default: 0 },
      height: { type: "number", default: 0 },
      objectFit: { type: "select", options: ["contain", "cover", "fill"], default: "contain" },
    } : { ...playbackSchema },
    validateProps: (raw) => {
      const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        src: sanitizeMediaSrc(text(r["src"])), caption: text(r["caption"]),
        controls: flag(r["controls"], true), autoplay: flag(r["autoplay"]),
        muted: flag(r["muted"]), loop: flag(r["loop"]),
        preload: ["none", "metadata", "auto"].includes(text(r["preload"])) ? text(r["preload"]) : "metadata",
        ...(kind === "video" ? {
          poster: sanitizeMediaSrc(text(r["poster"])), playsInline: flag(r["playsInline"], true),
          width: dimension(r["width"]), height: dimension(r["height"]),
          objectFit: ["contain", "cover", "fill"].includes(text(r["objectFit"])) ? text(r["objectFit"]) : "contain",
        } : {}),
      };
    },
    render: (props) => {
      const src = safeMediaSrc(text(props["src"]));
      const attrs = [src ? `src="${src}"` : "", `preload="${esc(text(props["preload"]))}"`];
      for (const name of ["controls", "autoplay", "muted", "loop"]) {
        if (props[name] === true) attrs.push(name);
      }
      if (kind === "video") {
        if (props["playsInline"] === true) attrs.push("playsinline");
        const poster = safeMediaSrc(text(props["poster"]));
        if (poster) attrs.push(`poster="${poster}"`);
        if (props["width"]) attrs.push(`width="${props["width"]}"`);
        if (props["height"]) attrs.push(`height="${props["height"]}"`);
      }
      const style = kind === "video"
        ? `display:block;max-width:100%;${props["width"] ? "" : "width:100%;"}${props["height"] ? "" : "height:auto;"}object-fit:${props["objectFit"]}`
        : "display:block;width:100%;max-width:100%";
      return `<figure class="jf-${kind}" style="margin:0"><${kind} ${attrs.filter(Boolean).join(" ")} style="${style}"></${kind}>${props["caption"] ? `<figcaption>${esc(text(props["caption"]))}</figcaption>` : ""}</figure>`;
    },
  };
}

export const mediaBlocks: BlockDefinition[] = [
  playbackBlock("video"),
  playbackBlock("audio"),
  {
    type: "core.file", version: 1, inline: { label: { mode: "plain", maxLength: 200 }, caption: { mode: "plain", maxLength: 500 } }, title: "File", icon: "⇩", category: "media",
    schema: {
      src: { type: "url", required: true },
      label: { type: "text" },
      caption: { type: "text" },
      download: { type: "boolean", default: true },
    },
    validateProps: (raw) => {
      const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return { src: sanitizeMediaSrc(text(r["src"])), label: text(r["label"]), caption: text(r["caption"]), download: flag(r["download"], true) };
    },
    render: (props) => {
      const src = safeMediaSrc(text(props["src"]));
      const label = text(props["label"]) || text(props["src"]).split("/").pop()?.split(/[?#]/)[0] || "File";
      return `<figure class="jf-file" style="margin:0">${src ? `<a href="${src}"${props["download"] === true ? " download" : ""}>${esc(label)}</a>` : `<span>${esc(label)}</span>`}${props["caption"] ? `<figcaption>${esc(text(props["caption"]))}</figcaption>` : ""}</figure>`;
    },
  },
];
