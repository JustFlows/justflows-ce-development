// SPDX-License-Identifier: MIT

import { ensurePluginRuntime, getRuntimeHooks } from "../plugins/plugin-runtime.js";

type ContentRenderInput = {
  id: string;
  siteId: string;
  type: string;
  title: string;
  excerpt?: string | null;
  translationGroupId?: string | null;
};

function decodeMustacheEntities(input: string): string {
  if (!input.includes("&#123;") && !input.includes("&#125;")) return input;
  return input.replaceAll("&#123;", "{").replaceAll("&#125;", "}");
}

function filterContext(content: ContentRenderInput) {
  return {
    siteId: content.siteId,
    contentId: content.id,
    type: content.type,
    title: content.title,
    excerpt: content.excerpt ?? null,
    translationGroupId: content.translationGroupId ?? content.id,
  };
}

function hookContext(content: ContentRenderInput) {
  return { siteId: content.siteId, source: "http" as const };
}

/** Fill `{{tags}}` in block props before HTML render. Plugins do the filling. */
export async function applyContentBlocks<T>(blocks: T, content: ContentRenderInput): Promise<T> {
  await ensurePluginRuntime();
  return getRuntimeHooks().applyFilter(
    "content.blocks",
    blocks,
    filterContext(content),
    hookContext(content),
  );
}

/** Fill `{{tags}}` in public body HTML after blocks have rendered. */
export async function applyContentRender(
  html: string,
  content: ContentRenderInput,
): Promise<string> {
  const decoded = decodeMustacheEntities(html);
  if (!decoded.includes("{{")) return decoded;
  await ensurePluginRuntime();
  return getRuntimeHooks().applyFilter(
    "content.render",
    decoded,
    filterContext(content),
    hookContext(content),
  );
}

const FOOTNOTE_REF_RE = /<sup\b[^>]*\bdata-footnote="([^"]*)"[^>]*>[\s\S]*?<\/sup>/gi;
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;

function decodeEntities(raw: string): string {
  return raw.replace(ENTITY_RE, (entity, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : entity;
    }
    return (
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }) as Record<string, string>
    )[code.toLowerCase()] ?? entity;
  });
}

function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Number every `<sup data-footnote="…">` left by the editor in document order
 * and append a "Footnotes" list at the end of the page's main content — the
 * numbering has to happen once across the *whole* rendered page, not per
 * block, since a page can spread footnotes across several paragraphs.
 */
export function applyFootnotes(html: string): string {
  let n = 0;
  const items: string[] = [];
  const withRefs = html.replace(FOOTNOTE_REF_RE, (_match, encoded: string) => {
    n += 1;
    const text = escapeHtml(decodeEntities(encoded));
    items.push(
      `<li id="jf-fn-${n}">${text} <a href="#jf-fnref-${n}" class="jf-footnote-backref" aria-label="Back to footnote reference ${n}">↩</a></li>`,
    );
    return `<sup class="jf-footnote-ref" id="jf-fnref-${n}"><a href="#jf-fn-${n}">${n}</a></sup>`;
  });
  if (items.length === 0) return html;
  return `${withRefs}\n<section class="jf-footnotes" aria-label="Footnotes">\n<hr />\n<ol>${items.join("")}</ol>\n</section>`;
}
