import sanitizeHtmlLib from "sanitize-html";

const RICHTEXT_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "del",
  "a",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "code",
  "span",
  "img",
  "sub",
  "sup",
  "mark",
  "kbd",
] as const;

const RICHTEXT_OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [...RICHTEXT_TAGS],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    span: ["class", "lang", "data-formula"],
    sup: ["class", "data-footnote"],
    img: ["src", "alt", "width", "height", "loading"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  // Defaults to true, which lets <a href="//attacker.example"> through the
  // scheme allowlist entirely — useful for phishing under the site's branding.
  allowProtocolRelative: false,
  allowedSchemesByTag: {
    img: ["http", "https"],
  },
  transformTags: {
    a: (_tagName: string, attribs: Record<string, string>) => ({
      tagName: "a",
      attribs: {
        ...attribs,
        rel: "noopener noreferrer",
        ...(attribs["target"] === "_blank" ? { target: "_blank" } : {}),
      },
    }),
  },
};

const HTML_BLOCK_OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    ...RICHTEXT_TAGS,
    "div",
    "section",
    "figure",
    "figcaption",
    "hr",
    "pre",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  allowedAttributes: {
    ...RICHTEXT_OPTIONS.allowedAttributes,
    img: ["src", "alt", "width", "height", "loading"],
    div: ["class", "id"],
    section: ["class"],
    p: ["class"],
    table: ["class"],
    thead: ["class"],
    tbody: ["class"],
    tr: ["class"],
    td: ["class", "colspan", "rowspan"],
    th: ["class", "colspan", "rowspan"],
    strong: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  allowedSchemesByTag: {
    img: ["http", "https"],
  },
};

/** Sanitize rich text (paragraphs, quotes) for public rendering. */
export function sanitizeRichText(html: string): string {
  return sanitizeHtmlLib(html, RICHTEXT_OPTIONS);
}

/** Convert untrusted HTML to text without using a tag-stripping regular expression. */
export function sanitizePlainText(html: string): string {
  return sanitizeHtmlLib(html, { allowedTags: [], allowedAttributes: {} });
}

/** Sanitize raw HTML blocks for public rendering. */
export function sanitizeHtmlBlock(html: string): string {
  return sanitizeHtmlLib(html, HTML_BLOCK_OPTIONS);
}

/** Extract text for indexing, keeping adjacent markup fragments separated. */
export function extractPlainText(html: string): string {
  const parts: string[] = [];
  const boundaries = new Set(["p", "div", "section", "article", "li", "ul", "ol", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "blockquote", "pre"]);
  sanitizeHtmlLib(html, {
    allowedTags: [], allowedAttributes: {},
    onOpenTag(name) { if (boundaries.has(name)) parts.push(" "); },
    onCloseTag(name) { if (boundaries.has(name)) parts.push(" "); },
    textFilter(text) { parts.push(text); return ""; },
  });
  // sanitize-html passes entity-escaped text to textFilter. Decode once for
  // storage; consumers must still escape these plain strings when rendering.
  return parts.join("").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()] ?? entity;
  }).replace(/\s+/g, " ").trim();
}

/**
 * CSS values allowed in a plugin preview's inline styles: no `url()` (no
 * requests from the admin), no `expression`, nothing that ends a declaration.
 */
const SAFE_STYLE_VALUE = /^(?!.*(url|expression|image-set|image)\s*\()[^;{}<>\\]*$/i;
const PREVIEW_STYLE_PROPERTIES = [
  "color", "background-color", "opacity",
  "display", "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "align-items", "align-self", "align-content", "justify-content", "justify-items", "justify-self", "gap", "row-gap", "column-gap", "order",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "grid-area",
  "width", "min-width", "max-width", "height", "min-height", "max-height", "aspect-ratio", "box-sizing", "overflow", "object-fit", "object-position",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "margin-inline", "margin-block",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "padding-inline", "padding-block",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-width", "border-style", "border-radius",
  "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-decoration", "text-transform", "white-space", "vertical-align", "list-style",
];

/**
 * Builder preview of a plugin block's own render (justflows-ce#306). Keeps
 * what makes the block look like it does on the page: its elements, classes,
 * ARIA and `data-*` attributes, simple inline SVG icons and layout styles, and
 * the `data-jf-inline` marker for inline editing (see `inline.ts`). Drops
 * scripts, frames, embeds, event handlers, unsafe links, CSS that loads
 * anything, and positioning, so a preview cannot run code, call out, or cover
 * the builder. Editor only; never used for stored or public HTML.
 */
const PLUGIN_PREVIEW_OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    ...RICHTEXT_TAGS,
    "div", "section", "article", "aside", "header", "footer", "nav", "main", "address", "hgroup",
    "figure", "figcaption", "picture", "source", "hr", "pre", "small", "time", "abbr", "cite", "q", "dl", "dt", "dd",
    "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
    "details", "summary", "h1", "label", "button", "progress", "meter",
    "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "title", "desc",
  ],
  allowedAttributes: {
    "*": ["class", "id", "title", "lang", "dir", "role", "hidden", "style", "aria-*", "data-*"],
    a: ["href", "target", "rel"],
    img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"],
    source: ["srcset", "sizes", "media", "type", "width", "height"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    col: ["span"],
    ol: ["start", "reversed", "type"],
    time: ["datetime"],
    button: ["type", "disabled"],
    details: ["open"],
    progress: ["value", "max"],
    meter: ["value", "min", "max", "low", "high", "optimum"],
    svg: ["viewbox", "viewBox", "width", "height", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "xmlns", "focusable", "preserveAspectRatio"],
    g: ["fill", "stroke", "stroke-width", "transform"],
    path: ["d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule", "transform"],
    circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width"],
    ellipse: ["cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width"],
    rect: ["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "stroke-width"],
    line: ["x1", "y1", "x2", "y2", "stroke", "stroke-width", "stroke-linecap"],
    polyline: ["points", "fill", "stroke", "stroke-width"],
    polygon: ["points", "fill", "stroke", "stroke-width"],
  },
  allowedStyles: { "*": Object.fromEntries(PREVIEW_STYLE_PROPERTIES.map((property) => [property, [SAFE_STYLE_VALUE]])) },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowProtocolRelative: false,
  allowedSchemesByTag: { img: ["http", "https"], source: ["http", "https"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "srcset", "cite"],
  parser: { lowerCaseAttributeNames: false },
  transformTags: RICHTEXT_OPTIONS.transformTags,
};

export function sanitizePluginPreviewHtml(html: string): string {
  return sanitizeHtmlLib(html, PLUGIN_PREVIEW_OPTIONS);
}
