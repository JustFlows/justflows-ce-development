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

/** Sanitize raw HTML blocks for public rendering. */
export function sanitizeHtmlBlock(html: string): string {
  return sanitizeHtmlLib(html, HTML_BLOCK_OPTIONS);
}
