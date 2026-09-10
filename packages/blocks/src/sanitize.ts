import sanitizeHtmlLib from "sanitize-html";

const RICHTEXT_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
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
] as const;

const RICHTEXT_OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [...RICHTEXT_TAGS],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    span: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  // Defaults to true, which lets <a href="//attacker.example"> through the
  // scheme allowlist entirely — useful for phishing under the site's branding.
  allowProtocolRelative: false,
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
    "img",
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
