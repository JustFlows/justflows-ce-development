// SPDX-License-Identifier: MIT
import { searchBlock } from "./search.js";
import type { BlockDefinition } from "../registry/block-registry.js";
import { sanitizeHtmlBlock, sanitizeRichText } from "../sanitize.js";
import { esc, safeHref, safeMediaSrc } from "../safe-url.js";
import { siteWidgetBlocks } from "./site-widgets.js";
import { GRID_DEFAULT_COLUMNS, GRID_MAX_COLUMNS, GRID_MIN_COLUMNS } from "../layout.js";
import {
  renderResponsiveImage,
  sanitizeSizes,
  sanitizeSrcset,
  type ResponsiveImageInput,
  type ResponsiveSource,
} from "../responsive-image.js";

function str(raw: unknown, fallback = ""): string {
  return typeof raw === "string" ? raw : fallback;
}

function num(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function dimension(raw: unknown): number {
  return Math.min(10000, Math.max(0, Math.round(num(raw, 0))));
}

interface SanitizedResponsive {
  src: string;
  width: number;
  height: number;
  sources: ResponsiveSource[];
  fallbackSrcset: string;
  focalX: number | null;
  focalY: number | null;
}

const IMAGE_TYPE_RE = /^image\/[a-z0-9.+-]{2,40}$/i;

function focal01(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** Intrinsic pixel dimension — wider ceiling than `dimension()` so very large originals keep their true ratio. */
function intrinsic(raw: unknown): number {
  return Math.min(30000, Math.max(0, Math.round(num(raw, 0))));
}

/** Coerce the server-injected `responsive` prop; returns null when nothing usable is present. */
function sanitizeResponsiveProp(raw: unknown): SanitizedResponsive | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sourcesRaw = Array.isArray(r["sources"]) ? r["sources"] : [];
  const sources: ResponsiveSource[] = [];
  for (const entry of sourcesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e["type"] === "string" && IMAGE_TYPE_RE.test(e["type"]) ? e["type"] : "";
    const srcset = sanitizeSrcset(e["srcset"]);
    if (type && srcset) sources.push({ type, srcset });
  }
  const src = safeMediaSrc(str(r["src"]));
  const fallbackSrcset = sanitizeSrcset(r["fallbackSrcset"]);
  if (!src && !sources.length && !fallbackSrcset) return null;
  return {
    src,
    width: intrinsic(r["width"]),
    height: intrinsic(r["height"]),
    sources,
    fallbackSrcset,
    focalX: focal01(r["focalX"]),
    focalY: focal01(r["focalY"]),
  };
}

export const coreBlocks: BlockDefinition[] = [
  searchBlock,
  {
    type: "core.paragraph",
    version: 1,
    title: "Paragraph",
    icon: "¶",
    category: "content",
    schema: { text: { type: "richtext", required: true } },
    validateProps: (raw) => ({ text: str((raw as Record<string, unknown>)["text"]) }),
    render: (props) =>
      `<div class="jf-paragraph">${sanitizeRichText((props as { text: string }).text)}</div>`,
  },
  {
    type: "core.heading",
    version: 1,
    title: "Heading",
    icon: "H",
    category: "content",
    schema: {
      text: { type: "text", required: true },
      level: { type: "number", default: 2 },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      return { text: str(r["text"]), level: Math.min(6, Math.max(1, num(r["level"], 2))) };
    },
    render: (props) => {
      const { text, level } = props as { text: string; level: number };
      return `<h${level}>${esc(text)}</h${level}>`;
    },
  },
  {
    type: "core.image",
    version: 1,
    title: "Image",
    icon: "🖼",
    category: "media",
    schema: {
      src: { type: "media", required: true },
      alt: { type: "text" },
      caption: { type: "text" },
      width: { type: "number" },
      height: { type: "number" },
      objectFit: { type: "select", options: ["contain", "cover", "fill"] },
      sizes: { type: "text" },
      loading: { type: "select", options: ["lazy", "eager"], default: "lazy" },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      const objectFit = ["contain", "cover", "fill"].includes(str(r["objectFit"]))
        ? str(r["objectFit"])
        : "contain";
      return {
        src: str(r["src"]),
        alt: str(r["alt"]),
        caption: str(r["caption"]),
        width: dimension(r["width"]),
        height: dimension(r["height"]),
        objectFit,
        sizes: sanitizeSizes(r["sizes"]),
        loading: str(r["loading"]) === "eager" ? "eager" : "lazy",
        // Server-injected in `apps/server/src/lib/responsive-blocks.ts` from the
        // media library's stored derivatives; re-sanitized here because block
        // props are persisted, editable JSON.
        responsive: sanitizeResponsiveProp(r["responsive"]),
      };
    },
    render: (props) => {
      const { src, alt, caption, width, height, objectFit, sizes, loading, responsive } = props as {
        src: string;
        alt: string;
        caption: string;
        width: number;
        height: number;
        objectFit: "contain" | "cover" | "fill";
        sizes: string;
        loading: "lazy" | "eager";
        responsive: SanitizedResponsive | null;
      };

      const input: ResponsiveImageInput = {
        src: responsive?.src || src,
        alt,
        loading,
        objectFit,
        displayWidth: width,
        displayHeight: height,
      };
      if (sizes) input.sizes = sizes;
      if (responsive) {
        if (responsive.width) input.width = responsive.width;
        if (responsive.height) input.height = responsive.height;
        if (responsive.sources.length) input.sources = responsive.sources;
        if (responsive.fallbackSrcset) input.fallbackSrcset = responsive.fallbackSrcset;
        if (responsive.focalX !== null) input.focalX = responsive.focalX;
        if (responsive.focalY !== null) input.focalY = responsive.focalY;
      }

      const img = renderResponsiveImage(input);
      return caption ? `<figure>${img}<figcaption>${esc(caption)}</figcaption></figure>` : img;
    },
  },
  {
    type: "core.quote",
    version: 1,
    title: "Quote",
    icon: "❝",
    category: "content",
    schema: { text: { type: "richtext", required: true }, attribution: { type: "text" } },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      return { text: str(r["text"]), attribution: str(r["attribution"]) };
    },
    render: (props) => {
      const { text, attribution } = props as { text: string; attribution: string };
      return attribution
        ? `<blockquote><div class="jf-quote__text">${sanitizeRichText(text)}</div><cite>${esc(attribution)}</cite></blockquote>`
        : `<blockquote><div class="jf-quote__text">${sanitizeRichText(text)}</div></blockquote>`;
    },
  },
  {
    type: "core.button",
    version: 1,
    title: "Button",
    icon: "⬛",
    category: "content",
    schema: {
      label: { type: "text", required: true },
      url: { type: "url", required: true },
      variant: { type: "select", options: ["primary", "secondary", "outline"], default: "primary" },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      return {
        label: str(r["label"]),
        url: str(r["url"]),
        variant: ["primary", "secondary", "outline"].includes(str(r["variant"]))
          ? str(r["variant"])
          : "primary",
      };
    },
    render: (props) => {
      const { label, url, variant } = props as { label: string; url: string; variant: string };
      return `<a href="${safeHref(url)}" class="btn btn--${variant}">${esc(label)}</a>`;
    },
  },
  {
    type: "core.link-list",
    version: 1,
    title: "Link list",
    icon: "🔗",
    category: "content",
    description:
      "A heading with a stack of plain-text links — footer columns, sitemaps, resource lists.",
    schema: {
      heading: { type: "text" },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      const items = Array.isArray(r["items"]) ? r["items"] : [];
      return {
        heading: str(r["heading"]),
        items: items
          .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
          .map((i) => ({ label: str(i["label"]), url: str(i["url"]) }))
          .filter((i) => i.label || i.url),
      };
    },
    render: (props) => {
      const { heading, items } = props as {
        heading: string;
        items: Array<{ label: string; url: string }>;
      };
      const links = items
        .map(
          (item) =>
            `<li><a href="${safeHref(item.url)}" class="jf-link-list__link">${esc(item.label)}</a></li>`,
        )
        .join("");
      return `<div class="jf-link-list">${heading ? `<h3 class="jf-link-list__heading">${esc(heading)}</h3>` : ""}<ul class="jf-link-list__items">${links}</ul></div>`;
    },
  },
  {
    type: "core.divider",
    version: 1,
    title: "Divider",
    icon: "—",
    category: "layout",
    schema: {},
    validateProps: () => ({}),
    render: () => "<hr>",
  },
  {
    type: "core.spacer",
    version: 1,
    title: "Spacer",
    icon: "↕",
    category: "layout",
    schema: { height: { type: "number", default: 40 } },
    validateProps: (raw) => ({ height: num((raw as Record<string, unknown>)["height"], 40) }),
    render: (props) =>
      `<div style="height:${(props as { height: number }).height}px" aria-hidden="true"></div>`,
  },
  {
    type: "core.html",
    version: 1,
    title: "HTML",
    icon: "</>",
    category: "content",
    schema: { html: { type: "textarea", required: true } },
    validateProps: (raw) => ({ html: str((raw as Record<string, unknown>)["html"]) }),
    // Wrap in a single element so `withBlockChrome` has one root to attach the
    // block's class / scoped CSS / style overrides to — custom HTML often has
    // several top-level nodes, and otherwise only the first would be styled.
    render: (props) =>
      `<div class="jf-html">${sanitizeHtmlBlock((props as { html: string }).html)}</div>`,
  },
  {
    type: "core.code",
    version: 1,
    title: "Code",
    icon: "{ }",
    category: "content",
    schema: {
      code: { type: "textarea", required: true },
      language: { type: "text" },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      return { code: str(r["code"]), language: str(r["language"]) };
    },
    render: (props) => {
      const { code, language } = props as { code: string; language: string };
      return `<pre><code class="language-${esc(language)}">${esc(code)}</code></pre>`;
    },
  },
  {
    type: "core.embed",
    version: 1,
    title: "Embed",
    icon: "⬡",
    category: "media",
    schema: { url: { type: "url", required: true }, caption: { type: "text" } },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      return { url: str(r["url"]), caption: str(r["caption"]) };
    },
    render: (props) => {
      const { url, caption } = props as { url: string; caption: string };
      return `<figure class="embed"><a href="${safeHref(url)}">${esc(url)}</a>${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>`;
    },
  },
  {
    type: "core.section",
    version: 1,
    title: "Section",
    icon: "▭",
    category: "layout",
    schema: {
      background: {
        type: "select",
        options: ["default", "muted", "primary", "dark", "gradient"],
        default: "default",
      },
      padding: { type: "select", options: ["sm", "md", "lg", "xl"], default: "lg" },
      align: { type: "select", options: ["left", "center"], default: "left" },
    },
    supportsChildren: true,
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      const bg = ["default", "muted", "primary", "dark", "gradient"].includes(str(r["background"]))
        ? str(r["background"])
        : "default";
      const pad = ["sm", "md", "lg", "xl"].includes(str(r["padding"])) ? str(r["padding"]) : "lg";
      const align = ["left", "center"].includes(str(r["align"])) ? str(r["align"]) : "left";
      return { background: bg, padding: pad, align };
    },
    render: (props, children = "") => {
      const { background, padding, align } = props as {
        background: string;
        padding: string;
        align: string;
      };
      return `<section class="jf-section jf-section--bg-${background} jf-section--pad-${padding} jf-section--align-${align}"><div class="jf-section__inner">${children}</div></section>`;
    },
  },
  {
    type: "core.container",
    version: 1,
    title: "Container",
    icon: "⬚",
    category: "layout",
    schema: {
      width: { type: "select", options: ["narrow", "default", "wide", "full"], default: "default" },
    },
    supportsChildren: true,
    validateProps: (raw) => {
      const w = str((raw as Record<string, unknown>)["width"]);
      return {
        width: ["narrow", "default", "wide", "full"].includes(w) ? w : "default",
      };
    },
    render: (props, children = "") =>
      `<div class="jf-container jf-container--${(props as { width: string }).width}">${children}</div>`,
  },
  {
    type: "core.group",
    version: 1,
    title: "Group",
    icon: "▢",
    category: "layout",
    schema: {},
    supportsChildren: true,
    validateProps: () => ({}),
    render: (_props, children = "") => `<div class="jf-group">${children}</div>`,
  },
  {
    type: "core.columns",
    version: 1,
    title: "Columns",
    icon: "⊞",
    category: "layout",
    schema: {
      columns: { type: "number", default: 2 },
      gap: { type: "select", options: ["sm", "md", "lg"], default: "md" },
    },
    supportsChildren: true,
    allowedChildTypes: ["core.column"],
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      const gap = ["sm", "md", "lg"].includes(str(r["gap"])) ? str(r["gap"]) : "md";
      return { columns: Math.min(4, Math.max(2, num(r["columns"], 2))), gap };
    },
    render: (props, children = "") => {
      const { columns, gap } = props as { columns: number; gap: string };
      return `<div class="jf-columns jf-columns--${columns} jf-columns--gap-${gap}">${children}</div>`;
    },
  },
  {
    type: "core.column",
    version: 1,
    title: "Column",
    icon: "▯",
    category: "layout",
    schema: {},
    supportsChildren: true,
    validateProps: () => ({}),
    render: (_props, children = "") => `<div class="jf-column">${children}</div>`,
  },
  {
    type: "core.grid",
    version: 1,
    title: "Grid",
    description: "Place blocks anywhere on a column grid. Drag to move, drag an edge to resize.",
    icon: "▦",
    category: "layout",
    schema: {
      columns: { type: "number", default: GRID_DEFAULT_COLUMNS },
      gap: { type: "select", options: ["none", "sm", "md", "lg"], default: "md" },
      rowHeight: { type: "select", options: ["auto", "sm", "md", "lg"], default: "auto" },
    },
    supportsChildren: true,
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      const gap = ["none", "sm", "md", "lg"].includes(str(r["gap"])) ? str(r["gap"]) : "md";
      const rowHeight = ["auto", "sm", "md", "lg"].includes(str(r["rowHeight"]))
        ? str(r["rowHeight"])
        : "auto";
      return {
        columns: Math.min(
          GRID_MAX_COLUMNS,
          Math.max(GRID_MIN_COLUMNS, num(r["columns"], GRID_DEFAULT_COLUMNS)),
        ),
        gap,
        rowHeight,
      };
    },
    render: (props, children = "") => {
      const { columns, gap, rowHeight } = props as {
        columns: number;
        gap: string;
        rowHeight: string;
      };
      // Children position themselves; the container only declares the tracks.
      return `<div class="jf-grid jf-grid--gap-${gap} jf-grid--rows-${rowHeight}" style="--jf-grid-cols:${columns}">${children}</div>`;
    },
  },
  {
    type: "core.reusable",
    version: 1,
    title: "Reusable block",
    description: "Shows a saved block. Editing the saved copy updates every page using it.",
    icon: "♻",
    category: "layout",
    schema: {
      ref: { type: "text", required: true },
    },
    validateProps: (raw) => ({ ref: str((raw as Record<string, unknown>)["ref"]) }),
    // Reached only when the reference is missing or the resolver did not run.
    render: () => `<!-- reusable block not found -->`,
  },
  {
    type: "core.hero",
    version: 1,
    title: "Hero",
    icon: "★",
    category: "sections",
    schema: {
      heading: { type: "text", required: true },
      subheading: { type: "text" },
      buttonLabel: { type: "text" },
      buttonUrl: { type: "url" },
      backgroundImage: { type: "media" },
      align: { type: "select", options: ["left", "center"], default: "center" },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      const align = ["left", "center"].includes(str(r["align"])) ? str(r["align"]) : "center";
      return {
        heading: str(r["heading"]),
        subheading: str(r["subheading"]),
        buttonLabel: str(r["buttonLabel"]),
        buttonUrl: str(r["buttonUrl"]),
        backgroundImage: str(r["backgroundImage"]),
        align,
      };
    },
    render: (props) => {
      const { heading, subheading, buttonLabel, buttonUrl, backgroundImage, align } = props as {
        heading: string;
        subheading: string;
        buttonLabel: string;
        buttonUrl: string;
        backgroundImage: string;
        align: string;
      };
      const bgStyle = backgroundImage
        ? ` style="background-image:url(&quot;${safeMediaSrc(backgroundImage)}&quot;)"`
        : "";
      const btn =
        buttonLabel && buttonUrl
          ? `<a href="${safeHref(buttonUrl)}" class="btn btn--primary jf-hero__btn">${esc(buttonLabel)}</a>`
          : "";
      return `<section class="jf-hero jf-hero--align-${align}"${bgStyle}><div class="jf-hero__inner"><h1 class="jf-hero__heading">${esc(heading)}</h1>${subheading ? `<p class="jf-hero__sub">${esc(subheading)}</p>` : ""}${btn}</div></section>`;
    },
  },
  {
    type: "core.features",
    version: 1,
    title: "Features",
    icon: "◆",
    category: "sections",
    schema: {
      heading: { type: "text" },
      columns: { type: "number", default: 3 },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      const items = Array.isArray(r["items"]) ? r["items"] : [];
      return {
        heading: str(r["heading"]),
        columns: Math.min(4, Math.max(2, num(r["columns"], 3))),
        items: items
          .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
          .map((i) => ({
            icon: str(i["icon"], "✦"),
            title: str(i["title"]),
            description: str(i["description"]),
          })),
      };
    },
    render: (props) => {
      const { heading, columns, items } = props as {
        heading: string;
        columns: number;
        items: Array<{ icon: string; title: string; description: string }>;
      };
      const cards = items
        .map(
          (item) =>
            `<div class="jf-feature"><span class="jf-feature__icon">${esc(item.icon)}</span><h3 class="jf-feature__title">${esc(item.title)}</h3><p class="jf-feature__desc">${esc(item.description)}</p></div>`,
        )
        .join("");
      return `<section class="jf-features"><div class="jf-container jf-container--wide">${heading ? `<h2 class="jf-features__heading">${esc(heading)}</h2>` : ""}<div class="jf-features__grid jf-features__grid--${columns}">${cards}</div></div></section>`;
    },
  },
  {
    type: "core.cta",
    version: 1,
    title: "Call to Action",
    icon: "→",
    category: "sections",
    schema: {
      heading: { type: "text", required: true },
      text: { type: "text" },
      buttonLabel: { type: "text" },
      buttonUrl: { type: "url" },
      variant: { type: "select", options: ["primary", "dark"], default: "primary" },
    },
    validateProps: (raw) => {
      const r = raw as Record<string, unknown>;
      return {
        heading: str(r["heading"]),
        text: str(r["text"]),
        buttonLabel: str(r["buttonLabel"]),
        buttonUrl: str(r["buttonUrl"]),
        variant: ["primary", "dark"].includes(str(r["variant"])) ? str(r["variant"]) : "primary",
      };
    },
    render: (props) => {
      const { heading, text, buttonLabel, buttonUrl, variant } = props as {
        heading: string;
        text: string;
        buttonLabel: string;
        buttonUrl: string;
        variant: string;
      };
      const btn =
        buttonLabel && buttonUrl
          ? `<a href="${safeHref(buttonUrl)}" class="btn btn--primary jf-cta__btn">${esc(buttonLabel)}</a>`
          : "";
      return `<section class="jf-cta jf-cta--${variant}"><div class="jf-container jf-container--default"><h2 class="jf-cta__heading">${esc(heading)}</h2>${text ? `<p class="jf-cta__text">${esc(text)}</p>` : ""}${btn}</div></section>`;
    },
  },
  ...siteWidgetBlocks,
];
