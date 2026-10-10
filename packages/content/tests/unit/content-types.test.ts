import { describe, expect, it } from "vitest";
import {
  BUILTIN_CONTENT_TYPES,
  ContentTypeFieldsSchema,
  ContentTypeSlugSchema,
  isBuiltinContentTypeSlug,
  normalizeContentTypeSlug,
} from "../../src/service/content-types.js";

describe("content type slugs", () => {
  it("accepts product-style slugs", () => {
    expect(ContentTypeSlugSchema.parse("product")).toBe("product");
    expect(ContentTypeSlugSchema.parse("case-study")).toBe("case-study");
  });

  it("rejects uppercase, spaces, and leading hyphens", () => {
    expect(ContentTypeSlugSchema.safeParse("Product").success).toBe(false);
    expect(ContentTypeSlugSchema.safeParse("case study").success).toBe(false);
    expect(ContentTypeSlugSchema.safeParse("-nope").success).toBe(false);
  });

  it("normalizes labels into slugs", () => {
    expect(normalizeContentTypeSlug("Case Study")).toBe("case-study");
  });

  it("treats post and page as builtins", () => {
    expect(isBuiltinContentTypeSlug("post")).toBe(true);
    expect(isBuiltinContentTypeSlug("page")).toBe(true);
    expect(isBuiltinContentTypeSlug("product")).toBe(false);
    expect(BUILTIN_CONTENT_TYPES.map((t) => t.slug)).toEqual(["post", "page", "account"]);
  });
});

describe("content type fields", () => {
  it("accepts a text field", () => {
    const parsed = ContentTypeFieldsSchema.parse([
      { key: "sku", label: "SKU", type: "text", required: true },
    ]);
    expect(parsed[0]?.key).toBe("sku");
  });

  it("rejects reserved SEO keys", () => {
    const result = ContentTypeFieldsSchema.safeParse([
      { key: "seoTitle", label: "Title", type: "text", required: false },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate keys", () => {
    const result = ContentTypeFieldsSchema.safeParse([
      { key: "price", label: "Price", type: "number", required: false },
      { key: "price", label: "Cost", type: "number", required: false },
    ]);
    expect(result.success).toBe(false);
  });

  it("requires options on select fields", () => {
    const result = ContentTypeFieldsSchema.safeParse([
      { key: "size", label: "Size", type: "select", required: false },
    ]);
    expect(result.success).toBe(false);
  });
});
