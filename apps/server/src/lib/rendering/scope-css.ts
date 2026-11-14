// SPDX-License-Identifier: MIT

/**
 * Confine a whole stylesheet to a subtree.
 *
 * The page builder renders block previews in the admin document, not an iframe,
 * so the theme's `/theme.css` — full of `body{}`, `:root{}`, resets and
 * `@keyframes` — cannot be linked as-is without repainting the admin chrome.
 * `scopeThemeCss` rewrites every selector to sit under one wrapper element
 * (`.jf-theme-surface`), turns `:root` / `html` / `body` into that wrapper, and
 * leaves `@keyframes` and `@font-face` global (they are not selectors).
 *
 * It is a structural pass — brace/string/comment aware — not a regex over the
 * whole file, so a colour value containing `}` or a comment containing `{`
 * cannot throw the rewrite off.
 */

const PASSTHROUGH_AT_RULES = new Set([
  "keyframes",
  "-webkit-keyframes",
  "font-face",
  "page",
  "property",
  "counter-style",
  "font-feature-values",
]);

const NESTED_AT_RULES = new Set(["media", "supports", "container", "layer", "scope"]);

/** Scan from `start` (just after `{`) to the matching `}`. Returns the body and the index of `}`. */
function readBlock(css: string, start: number): { body: string; end: number } {
  let depth = 1;
  let i = start;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: css.slice(start, i), end: i };
    }
    i++;
  }
  return { body: css.slice(start), end: n };
}

function skipString(css: string, i: number): number {
  const quote = css[i];
  i++;
  const n = css.length;
  while (i < n) {
    if (css[i] === "\\") {
      i += 2;
      continue;
    }
    if (css[i] === quote) return i + 1;
    i++;
  }
  return n;
}

/** Rewrite one comma-separated selector so it lives under `scope`. */
function scopeSelector(selector: string, scope: string): string {
  const sel = selector.trim();
  if (!sel) return sel;

  // `:root` is the theme's token home — become the wrapper itself.
  if (sel === ":root") return scope;
  if (sel.startsWith(":root")) return scope + sel.slice(":root".length);

  // `html` / `html[data-theme="dark"]` / `body` / `body.x` → the wrapper,
  // carrying any attribute or class that followed.
  for (const tag of ["html", "body"] as const) {
    if (sel === tag) return scope;
    const rest = sel.slice(tag.length);
    if (
      sel.startsWith(tag) &&
      (rest[0] === "[" || rest[0] === "." || rest[0] === ":" || rest[0] === " " || rest[0] === ">")
    ) {
      return scope + rest;
    }
  }

  // Universal selector stays universal, just bounded by the wrapper.
  if (sel === "*" || sel.startsWith("*,") || sel.startsWith("* ")) return `${scope} ${sel}`;

  return `${scope} ${sel}`;
}

function scopeSelectorList(list: string, scope: string): string {
  return splitTopLevel(list, ",")
    .map((s) => scopeSelector(s, scope))
    .join(", ");
}

/** Split on `sep` that is not inside (), [], or a string. */
function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      i = skipString(input, i);
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(input.slice(start));
  return parts;
}

/** A single width feature, such as `(max-width: 900px)` or `(min-width:48em)`. */
const WIDTH_FEATURE = /^\(\s*(?:min|max)-width\s*:\s*[\d.]+(?:px|em|rem)\s*\)$/i;

/**
 * `@media` → `@container <name>` when the query only tests the viewport
 * width (optionally with `screen`/`all`). Anything else (print, colour
 * scheme, hover, reduced motion) stays a media query. Comma lists become
 * `or`. Returns `null` when the query must stay as it is.
 */
export function widthMediaToContainer(query: string, name: string): string | null {
  const parts = query.split(",").map((part) => part.trim());
  if (!parts.length || parts.some((p) => !p)) return null;
  const converted: string[] = [];
  for (const part of parts) {
    const tokens = part
      .replace(/^(?:only\s+)?(?:screen|all)\s+and\s+/i, "")
      .split(/\s+and\s+/i)
      .map((t) => t.trim());
    if (!tokens.length || !tokens.every((t) => WIDTH_FEATURE.test(t))) return null;
    converted.push(tokens.length === 1 ? tokens[0]! : `(${tokens.join(" and ")})`);
  }
  return `@container ${name} ${converted.length === 1 ? converted[0]!.replace(/^\((\(.*\))\)$/, "$1") : converted.join(" or ")}`;
}

function scopeRules(css: string, scope: string, container?: string): string {
  const out: string[] = [];
  let i = 0;
  const n = css.length;
  let prelude = "";

  while (i < n) {
    const ch = css[i];

    if (ch === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      out.push(css.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipString(css, i);
      prelude += css.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "{") {
      const { body, end } = readBlock(css, i + 1);
      const head = prelude.trim();
      prelude = "";
      i = end + 1;

      if (head.startsWith("@")) {
        const name = head.slice(1).split(/[\s(]/, 1)[0]!.toLowerCase();
        if (PASSTHROUGH_AT_RULES.has(name)) {
          out.push(`${head} {${body}}`);
        } else if (NESTED_AT_RULES.has(name)) {
          const asContainer = container && name === "media" ? widthMediaToContainer(head.slice("@media".length).trim(), container) : null;
          out.push(`${asContainer ?? head} {${scopeRules(body, scope, container)}}`);
        } else {
          out.push(`${head} {${body}}`);
        }
      } else {
        out.push(`${scopeSelectorList(head, scope)} {${body}}`);
      }
      continue;
    }

    if (ch === ";" && prelude.trim().startsWith("@")) {
      // @import / @charset etc. Drop @import (a scoped sheet must not pull in
      // more unscoped CSS); keep the rest verbatim.
      const stmt = prelude.trim();
      if (!/^@import\b/i.test(stmt)) out.push(`${stmt};`);
      prelude = "";
      i++;
      continue;
    }

    prelude += ch;
    i++;
  }

  const tail = prelude.trim();
  if (tail && !tail.startsWith("@")) out.push(tail);
  return out.join("\n");
}

const SAFE_SCOPE = /^\.[-_a-zA-Z][-_a-zA-Z0-9]*$/;

export function isSafeScopeSelector(scope: string): boolean {
  return SAFE_SCOPE.test(scope);
}

const SAFE_CONTAINER = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * `container` names the builder canvas's query container (justflows-ce#300):
 * width-only media queries then follow the canvas width instead of the
 * admin window, so tablet and mobile previews show the theme's own
 * responsive rules.
 */
export function scopeThemeCss(css: string, scope: string, container?: string): string {
  if (!isSafeScopeSelector(scope)) return css;
  return scopeRules(css, scope, container && SAFE_CONTAINER.test(container) ? container : undefined);
}
