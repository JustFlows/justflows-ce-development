// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { listThemePatterns, loadThemePattern } from "../theme-files.js";
import { isEmptyBlockDocument } from "../default-content-blocks.js";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("product page pattern", () => {
  it("ships a product detail pattern with a buy box and specs", () => {
    const previous = process.env.JF_ROOT;
    process.env.JF_ROOT = repoRoot;
    try {
      const pattern = loadThemePattern("justflows.default", "product");
      expect(pattern?.id).toBe("product");
      expect(pattern?.title).toMatch(/product/i);
      expect(pattern?.blocks.length).toBeGreaterThan(2);
      const json = readFileSync(
        path.join(repoRoot, "themes/default/patterns/product.json"),
        "utf8",
      );
      expect(json).toContain("Add to cart");
      expect(json).toContain("{{price}}");
      expect(json).toContain("{{sku}}");
      expect(json).toContain("{{attributes}}");
      expect(json).toContain("Specifications");
      expect(json).toContain("justflows.shop.gallery");
      expect(json).toContain("justflows.shop.buy-box");
      expect(json).toContain("product-page-03-product-01.jpg");
    } finally {
      if (previous === undefined) delete process.env.JF_ROOT;
      else process.env.JF_ROOT = previous;
    }
  });

  it("ships mosaic, story, list, and ecommerce storefront patterns", () => {
    const previous = process.env.JF_ROOT;
    process.env.JF_ROOT = repoRoot;
    try {
      expect(loadThemePattern("justflows.default", "product-mosaic")?.id).toBe("product-mosaic");
      expect(loadThemePattern("justflows.default", "product-story")?.id).toBe("product-story");
      expect(loadThemePattern("justflows.default", "product-list")?.id).toBe("product-list");
      const storefront = loadThemePattern("justflows.default", "ecommerce-storefront");
      expect(storefront?.id).toBe("ecommerce-storefront");
      expect(storefront?.title).toMatch(/ecommerce storefront/i);
      expect(storefront?.blocks.length).toBeGreaterThan(3);
      expect(listThemePatterns("justflows.default").find((p) => p.id === "ecommerce-storefront")).toEqual(
        expect.objectContaining({
          title: "Ecommerce storefront",
          requiresBlockTypes: ["justflows.shop.related", "justflows.shop.product-list"],
        }),
      );
      const json = readFileSync(
        path.join(repoRoot, "themes/default/patterns/ecommerce-storefront.json"),
        "utf8",
      );
      expect(json).toContain("image tiles and feature sections");
      expect(json).toContain("justflows.shop.related");
      expect(json).toContain("justflows.shop.product-list");
      expect(json).toContain("home-page-03-hero-image-tile-01.jpg");
      expect(json).toContain("Our Favorites");
      expect(json).toContain("Shop by Category");
      const sanitized = JSON.stringify(sanitizeBlockDocument({ version: 1, blocks: storefront?.blocks ?? [] }));
      expect(sanitized).toContain("jf-storefront-tiles");
      expect(sanitized).toContain("home-page-03-hero-image-tile-01.jpg");
      expect(sanitized).toContain("home-page-03-favorite-01.jpg");
    } finally {
      if (previous === undefined) delete process.env.JF_ROOT;
      else process.env.JF_ROOT = previous;
    }
  });

  it("treats missing or empty block documents as empty", () => {
    expect(isEmptyBlockDocument(undefined)).toBe(true);
    expect(isEmptyBlockDocument({ version: 1, blocks: [] })).toBe(true);
    expect(isEmptyBlockDocument({ version: 1, blocks: [{ type: "core.heading" }] })).toBe(false);
  });
});
