import { describe, expect, it } from "vitest";
import { isEmptyBlockDocument, shouldSeedProductLayout, usesPageBuilderChrome } from "./content-layout";

describe("content layout helpers", () => {
  it("treats product and shop like pages in the builder", () => {
    expect(usesPageBuilderChrome("page")).toBe(true);
    expect(usesPageBuilderChrome("product")).toBe(true);
    expect(usesPageBuilderChrome("shop")).toBe(true);
    expect(usesPageBuilderChrome("post")).toBe(false);
  });

  it("detects an empty block canvas", () => {
    expect(isEmptyBlockDocument({ version: 1, blocks: [] })).toBe(true);
    expect(isEmptyBlockDocument({ version: 1, blocks: [{ type: "core.hero" }] })).toBe(false);
  });

  it("seeds the product layout only on the original locale", () => {
    expect(shouldSeedProductLayout({ type: "product", id: "en", translationGroupId: "en" })).toBe(true);
    expect(shouldSeedProductLayout({ type: "product", id: "nl", translationGroupId: "en" })).toBe(false);
    expect(shouldSeedProductLayout({ type: "page", id: "en", translationGroupId: "en" })).toBe(false);
  });
});
