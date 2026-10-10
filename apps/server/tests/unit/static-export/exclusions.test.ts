// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  isExcludedPath,
  nginxExclusionLocations,
  rewriteExcludedLinks,
  sanitizeExclusions,
} from "../../../src/lib/static-export/exclusions.js";

describe("sanitizeExclusions", () => {
  it("preserves mandatory home-page and large type exclusions beyond the plugin limit", () => {
    const rules = [{ path: "/", match: "exact" }, ...Array.from({ length: 250 }, (_, i) => ({ path: `/private-${i}`, match: "exact" }))];
    const safe = sanitizeExclusions(rules, "/admin", true);
    expect(safe).toHaveLength(251);
    expect(isExcludedPath("/", safe)).toBe(true);
    expect(isExcludedPath("/private-249", safe)).toBe(true);
    expect(nginxExclusionLocations(safe)).toContain("location = /  { try_files /_pass @fallback; }");
    expect(nginxExclusionLocations(safe).some(line => line.includes("location = //"))).toBe(false);
  });
  it("keeps safe paths, defaults to prefix, and normalizes", () => {
    expect(
      sanitizeExclusions([
        { path: "/shop/checkout" },
        { path: "/shop/cart/", match: "exact" },
        { path: "/member-area", match: "prefix" },
      ]),
    ).toEqual([
      { path: "/shop/checkout", match: "prefix" },
      { path: "/shop/cart", match: "exact" },
      { path: "/member-area", match: "prefix" },
    ]);
  });

  it("drops the root, unsafe characters, traversal, and non-objects", () => {
    expect(
      sanitizeExclusions([
        "/shop",
        { path: "/" },
        { path: "shop" },
        { path: "//evil.example/x" },
        { path: "/a b" },
        { path: "/x;}\nlocation / { deny all" },
        { path: "/a/../b" },
        { path: "/a?x=1" },
        { path: `/${"a".repeat(250)}` },
        { path: 42 },
        null,
      ]),
    ).toEqual([]);
  });

  it("ignores paths core already routes to the app, including a renamed admin", () => {
    const rules = sanitizeExclusions(
      [
        { path: "/api/x" },
        { path: "/login" },
        { path: "/control-room/users" },
        { path: "/ext" },
        { path: "/favicon.ico", match: "exact" },
        { path: "/admin-guide" },
      ],
      "/control-room",
    );
    expect(rules).toEqual([{ path: "/admin-guide", match: "prefix" }]);
  });

  it("removes duplicates", () => {
    expect(sanitizeExclusions([{ path: "/cart" }, { path: "/cart/" }])).toHaveLength(1);
  });

  it("returns nothing for a filter that did not return an array", () => {
    expect(sanitizeExclusions({ path: "/cart" })).toEqual([]);
    expect(sanitizeExclusions(undefined)).toEqual([]);
  });
});

describe("isExcludedPath", () => {
  const rules = sanitizeExclusions([{ path: "/shop/cart" }, { path: "/member-area", match: "exact" }]);

  it("matches a prefix on a segment boundary only", () => {
    expect(isExcludedPath("/shop/cart", rules)).toBe(true);
    expect(isExcludedPath("/shop/cart/", rules)).toBe(true);
    expect(isExcludedPath("/shop/cart/step-2?x=1", rules)).toBe(true);
    expect(isExcludedPath("/shop/cartoon", rules)).toBe(false);
    expect(isExcludedPath("/shop", rules)).toBe(false);
  });

  it("matches an exact path and nothing below it", () => {
    expect(isExcludedPath("/member-area#top", rules)).toBe(true);
    expect(isExcludedPath("/member-area/orders", rules)).toBe(false);
  });
});

describe("rewriteExcludedLinks", () => {
  const rules = sanitizeExclusions([{ path: "/shop/checkout" }]);

  it("points links and form actions at the live origin, keeping the query", () => {
    const html =
      `<a class="x" href="/shop/checkout?step=2">Pay</a>` +
      `<form action="/shop/checkout" method="post"></form>` +
      `<a href="/shop">Shop</a><a href="//cdn.example/shop/checkout">cdn</a>`;
    const out = rewriteExcludedLinks(html, rules, "https://app.example.com/");
    expect(out).toContain(`href="https://app.example.com/shop/checkout?step=2"`);
    expect(out).toContain(`action="https://app.example.com/shop/checkout"`);
    expect(out).toContain(`href="/shop"`);
    expect(out).toContain(`href="//cdn.example/shop/checkout"`);
  });

  it("leaves pages alone without an origin URL", () => {
    const html = `<a href="/shop/checkout">Pay</a>`;
    expect(rewriteExcludedLinks(html, rules, "")).toBe(html);
  });

  it("cannot break out of the attribute through the origin URL", () => {
    const out = rewriteExcludedLinks(
      `<a href="/shop/checkout">x</a>`,
      rules,
      `https://a.example"onmouseover="x`,
    );
    expect(out).not.toContain(`"onmouseover="`);
  });
});

describe("nginxExclusionLocations", () => {
  it("emits one location per form and never a duplicate", () => {
    const lines = nginxExclusionLocations(
      sanitizeExclusions([{ path: "/cart" }, { path: "/cart", match: "exact" }]),
    );
    expect(lines).toEqual([
      "location = /cart  { try_files /_pass @fallback; }",
      "location ^~ /cart/ { try_files /_pass @fallback; }",
      "location = /cart/ { try_files /_pass @fallback; }",
    ]);
  });
});
