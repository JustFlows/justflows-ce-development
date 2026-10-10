// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { assetPathsFromCss, assetPathsFromHtml, originHost } from "../../../src/lib/static-export/assets.js";

describe("assetPathsFromHtml", () => {
  it("collects same-origin stylesheets, scripts and images", () => {
    const html = `
      <link rel="stylesheet" href="/theme.css">
      <script src="/js/site-chrome.js"></script>
      <img src="/uploads/hero.jpg">
      <img src='/uploads/logo.png'>
    `;
    expect(assetPathsFromHtml(html).sort()).toEqual([
      "/js/site-chrome.js",
      "/theme.css",
      "/uploads/hero.jpg",
      "/uploads/logo.png",
    ]);
  });

  it("expands srcset entries and ignores their descriptors", () => {
    const html = `<img srcset="/uploads/a.jpg 1x, /uploads/a@2x.jpg 2x">`;
    expect(assetPathsFromHtml(html).sort()).toEqual(["/uploads/a.jpg", "/uploads/a@2x.jpg"]);
  });

  it("skips external hosts, data URIs and non-asset paths", () => {
    const html = `
      <img src="https://cdn.example.com/x.png">
      <img src="data:image/png;base64,AAAA">
      <a href="/about">About</a>
      <link rel="stylesheet" href="//fonts.example/x.css">
    `;
    expect(assetPathsFromHtml(html)).toEqual([]);
  });

  it("reads url() from inline <style>", () => {
    const html = `<style>.h{background:url("/uploads/bg.webp")}</style>`;
    expect(assetPathsFromHtml(html)).toEqual(["/uploads/bg.webp"]);
  });

  it("captures plugin and custom-theme scripts from any same-origin path", () => {
    const html = `
      <script src="/ext/acme.widget/widget.js"></script>
      <link rel="modulepreload" href="/ext/acme.widget/chunk.js">
      <script type="module" src="/themes/mytheme/app.js"></script>
      <img src="/plugin-media/acme/logo.svg">
    `;
    expect(assetPathsFromHtml(html).sort()).toEqual([
      "/ext/acme.widget/chunk.js",
      "/ext/acme.widget/widget.js",
      "/plugin-media/acme/logo.svg",
      "/themes/mytheme/app.js",
    ]);
  });

  it("ignores <link rel> that is not a real sub-resource", () => {
    const html = `
      <link rel="canonical" href="/about">
      <link rel="alternate" hreflang="nl" href="/nl-NL/over-ons">
      <link rel="stylesheet" href="/theme.css">
    `;
    expect(assetPathsFromHtml(html)).toEqual(["/theme.css"]);
  });

  it("never downloads dynamic surfaces (admin, api, auth, submit endpoints)", () => {
    const html = `
      <script src="/api/v1/config.js"></script>
      <script src="/admin/assets/x.js"></script>
      <link rel="stylesheet" href="/login/style.css">
      <img src="/justflows-forms/pixel.gif">
    `;
    expect(assetPathsFromHtml(html)).toEqual([]);
  });

  it("captures the page's own absolute-URL assets when the host matches", () => {
    const html = `
      <script src="https://www.example.com/ext/acme/w.js"></script>
      <script src="https://cdn.other.com/vendor.js"></script>
    `;
    expect(assetPathsFromHtml(html, originHost("https://www.example.com"))).toEqual([
      "/ext/acme/w.js",
    ]);
    // No known host → all absolute URLs are treated as off-site.
    expect(assetPathsFromHtml(html)).toEqual([]);
  });
});

describe("originHost", () => {
  it("returns the lowercased host or empty", () => {
    expect(originHost("https://WWW.Example.com:443/x")).toBe("www.example.com");
    expect(originHost("")).toBe("");
    expect(originHost("not a url")).toBe("");
  });
});

describe("assetPathsFromCss", () => {
  it("collects url() and @import targets under known prefixes", () => {
    const css = `
      @import "/css-providers/base.css";
      @font-face { src: url(/fonts/inter.woff2) format("woff2"); }
      .x { background: url('/uploads/tile.png'); }
      .y { background: url(https://cdn.example.com/no.png); }
    `;
    expect(assetPathsFromCss(css).sort()).toEqual([
      "/css-providers/base.css",
      "/fonts/inter.woff2",
      "/uploads/tile.png",
    ]);
  });
});


it("never downloads account data disguised as a static subresource", () => {
  expect(assetPathsFromHtml('<img src="/account/avatar.png"><script src="/ext/example/account/data.js"></script><link rel="preload" href="/api/account/profile">')).toEqual([]);
});
