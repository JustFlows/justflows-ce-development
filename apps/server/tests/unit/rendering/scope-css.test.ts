// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { scopeThemeCss, widthMediaToContainer } from "../../../src/lib/rendering/scope-css.js";

const S = ".jf-theme-surface";

describe("scopeThemeCss", () => {
  it("turns :root into the wrapper so tokens cascade to the subtree", () => {
    expect(scopeThemeCss(":root { --color-primary: #ff0080; }", S)).toBe(
      `${S} { --color-primary: #ff0080; }`,
    );
  });

  it("folds html / body / html[data-theme] onto the wrapper", () => {
    expect(scopeThemeCss("html { font-size: 16px; }", S)).toBe(`${S} { font-size: 16px; }`);
    expect(scopeThemeCss("body { margin: 0; }", S)).toBe(`${S} { margin: 0; }`);
    expect(scopeThemeCss('html[data-theme="dark"] { --x: 1; }', S)).toBe(
      `${S}[data-theme="dark"] { --x: 1; }`,
    );
  });

  it("prefixes ordinary selectors, each part of a list", () => {
    expect(scopeThemeCss(".jf-hero, .jf-cta h2 { color: red; }", S)).toBe(
      `${S} .jf-hero, ${S} .jf-cta h2 { color: red; }`,
    );
  });

  it("keeps the universal reset bounded by the wrapper", () => {
    expect(scopeThemeCss("*, *::before, *::after { box-sizing: border-box; }", S)).toBe(
      `${S} *, ${S} *::before, ${S} *::after { box-sizing: border-box; }`,
    );
  });

  it("leaves @keyframes and @font-face global", () => {
    const kf = "@keyframes spin { to { transform: rotate(1turn); } }";
    expect(scopeThemeCss(kf, S)).toBe(kf);
  });

  it("recurses into @media / @supports bodies", () => {
    const input = "@media (max-width: 600px) { .jf-hero { padding: 1rem; } :root { --x: 2; } }";
    const out = scopeThemeCss(input, S);
    expect(out.startsWith("@media (max-width: 600px) {")).toBe(true);
    expect(out).toContain(`${S} .jf-hero { padding: 1rem; }`);
    expect(out).toContain(`${S} { --x: 2; }`);
    expect(out.trimEnd().endsWith("}")).toBe(true);
  });

  it("is not fooled by braces or comments inside values", () => {
    const input = '.a { content: "}"; background: url(x); } /* } */ .b { color: red; }';
    const out = scopeThemeCss(input, S);
    expect(out).toContain(`${S} .a { content: "}"; background: url(x); }`);
    expect(out).toContain(`${S} .b { color: red; }`);
  });

  it("drops @import but keeps other at-statements", () => {
    expect(scopeThemeCss('@import "evil.css"; .a { color: red; }', S)).toBe(
      `${S} .a { color: red; }`,
    );
  });

  it("returns the CSS untouched for an unsafe scope selector", () => {
    const css = ":root { --x: 1; }";
    expect(scopeThemeCss(css, "body{}")).toBe(css);
    expect(scopeThemeCss(css, "div")).toBe(css);
  });
});

describe("width media queries as canvas container queries (justflows-ce#300)", () => {
  it("converts width-only media queries, including screen and ranges", () => {
    expect(widthMediaToContainer("(max-width: 900px)", "jf-canvas")).toBe("@container jf-canvas (max-width: 900px)");
    expect(widthMediaToContainer("screen and (min-width: 601px) and (max-width: 1024px)", "jf-canvas")).toBe(
      "@container jf-canvas (min-width: 601px) and (max-width: 1024px)",
    );
    expect(widthMediaToContainer("(max-width: 40em), (min-width: 80em)", "jf-canvas")).toBe(
      "@container jf-canvas (max-width: 40em) or (min-width: 80em)",
    );
  });

  it("leaves every other media query alone", () => {
    expect(widthMediaToContainer("print", "jf-canvas")).toBeNull();
    expect(widthMediaToContainer("(prefers-color-scheme: dark)", "jf-canvas")).toBeNull();
    expect(widthMediaToContainer("(max-width: 600px) and (hover: hover)", "jf-canvas")).toBeNull();
    expect(widthMediaToContainer("(max-width: calc(1px + 2px))", "jf-canvas")).toBeNull();
  });

  it("rewrites the sheet only when a container is asked for", () => {
    const css = "@media (max-width: 600px) { .a { color: red } } @media print { .b { color: blue } }";
    expect(scopeThemeCss(css, ".s")).toContain("@media (max-width: 600px)");
    const canvas = scopeThemeCss(css, ".s", "jf-canvas");
    expect(canvas).toContain("@container jf-canvas (max-width: 600px) {");
    expect(canvas).toContain(".s .a");
    expect(canvas).toContain("@media print");
    expect(scopeThemeCss(css, ".s", "bad name{")).toContain("@media (max-width: 600px)");
  });
});
