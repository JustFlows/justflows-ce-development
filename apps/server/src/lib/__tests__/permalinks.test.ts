// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMALINK_SETTINGS as defaults,
  PERMALINK_PRESETS,
  PermalinkSettingsSchema,
  permalinkPath,
  slashPath,
  type PermalinkContent,
} from "../permalinks.js";
const post: PermalinkContent = {
  id: "abc-123",
  slug: "hello",
  type: "post",
  locale: "en-US",
  publishedAt: "2026-09-07T23:00:00Z",
  createdAt: "2025-01-01T00:00:00Z",
  authorId: "author-1",
  fields: {},
  permalinkCategory: "news",
};

describe("permalink structures", () => {
  it.each([
    ["plain", "/?p=abc-123"],
    ["day", "/2026/09/07/hello"],
    ["month", "/2026/09/hello"],
    ["name", "/hello"],
    ["numeric", "/archives/abc-123"],
  ] as const)("renders %s", (preset, expected) => {
    expect(
      permalinkPath(post, { ...defaults, structure: PERMALINK_PRESETS[preset] }, "en-US"),
    ).toBe(expected);
  });
  it("composes category, author and custom type tokens", () => {
    expect(
      permalinkPath(
        post,
        {
          ...defaults,
          structure: "/%type%/%category%/%author%/%postname%/",
          trailingSlash: "always",
        },
        "en-US",
      ),
    ).toBe("/post/news/author-1/hello/");
  });
  it("uses deterministic category and author fallbacks", () => {
    expect(
      permalinkPath(
        { ...post, permalinkCategory: undefined, authorId: null },
        { ...defaults, structure: "/%category%/%author%/%id%/" },
        "en-US",
      ),
    ).toBe("/uncategorized/unknown/abc-123");
  });
  it("puts locale before nested type bases and preserves page slugs", () => {
    expect(
      permalinkPath(
        { ...post, type: "product", locale: "nl-NL" },
        { ...defaults, typeBases: { product: "shop/products" }, trailingSlash: "always" },
        "en-US",
      ),
    ).toBe("/nl-NL/shop/products/hello/");
    expect(
      permalinkPath(
        { ...post, type: "page" },
        { ...defaults, structure: PERMALINK_PRESETS.day },
        "en-US",
      ),
    ).toBe("/hello");
  });
  it("retains the query when applying slash policy to plain locale roots", () => {
    expect(
      permalinkPath(
        { ...post, locale: "nl-NL" },
        { ...defaults, structure: PERMALINK_PRESETS.plain, trailingSlash: "always" },
        "en-US",
      ),
    ).toBe("/nl-NL/?p=abc-123");
    expect(slashPath("/?p=abc", "always")).toBe("/?p=abc");
  });
  it("encodes untrusted token values as single segments", () => {
    expect(permalinkPath({ ...post, slug: "a/b?x=#" }, defaults, "en-US")).toBe("/a%2Fb%3Fx%3D%23");
  });
  it.each([
    "//evil.test/%id%",
    "/../%id%",
    "/./%id%",
    "/api/%id%",
    "/ADMIN/%id%",
    "/%unknown%/%postname%",
    "/%year%/",
    "/%id%?q=1",
    "/%id%#x",
    "/%id%\\x",
    "/%2e%2e/%id%",
  ])("rejects unsafe or ambiguous structure %s", (structure) => {
    expect(PermalinkSettingsSchema.safeParse({ ...defaults, structure }).success).toBe(false);
  });
  it.each(["api", "admin/test", "../shop", "/shop", "shop/", "shop//items"])(
    "rejects invalid base %s",
    (base) => {
      expect(
        PermalinkSettingsSchema.safeParse({ ...defaults, typeBases: { product: base } }).success,
      ).toBe(false);
    },
  );
});
