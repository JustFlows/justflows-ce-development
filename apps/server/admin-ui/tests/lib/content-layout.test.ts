import { describe, expect, it } from "vitest";
import { isEmptyBlockDocument, shouldSeedTypePattern, usesBlockEditor } from "../../src/lib/content-layout";

describe("content layout helpers", () => {
  it("uses the block editor for pages and for types a plugin marks as blocks", () => {
    expect(usesBlockEditor("page", false)).toBe(true);
    expect(usesBlockEditor("post", false)).toBe(false);
    expect(usesBlockEditor("post", true)).toBe(true);
  });

  it("detects an empty block canvas", () => {
    expect(isEmptyBlockDocument({ version: 1, blocks: [] })).toBe(true);
    expect(isEmptyBlockDocument({ version: 1, blocks: [{ type: "core.hero" }] })).toBe(false);
  });

  it("seeds a type pattern only on the original locale", () => {
    expect(shouldSeedTypePattern({ id: "en", translationGroupId: "en" })).toBe(true);
    expect(shouldSeedTypePattern({ id: "nl", translationGroupId: "en" })).toBe(false);
  });
});
