import { describe, expect, it } from "vitest";
import {
  BlockPatternSchema,
  PatternSetSchema,
  ThemePatternRegistrationSchema,
} from "../../src/patterns.js";

const paragraph = { id: "copy", type: "core.paragraph", version: 1, props: { text: "Hello" } };

describe("BlockPatternSchema", () => {
  it("defaults the portable format metadata", () => {
    expect(
      BlockPatternSchema.parse({ id: "hero", title: "Hero", blocks: [paragraph] }),
    ).toMatchObject({
      schemaVersion: 1,
      version: "1.0.0",
      category: "sections",
      requiresBlockTypes: [],
    });
  });

  it("accepts editor-only labels and locks but rejects unknown editor keys", () => {
    const labelled = { ...paragraph, editor: { label: "Intro", lock: { move: true } } };
    expect(BlockPatternSchema.safeParse({ id: "hero", title: "Hero", blocks: [labelled] }).success).toBe(true);
    const extra = { ...paragraph, editor: { label: "Intro", selected: true } };
    expect(BlockPatternSchema.safeParse({ id: "hero", title: "Hero", blocks: [extra] }).success).toBe(false);
  });

  it("requires every non-core block type to be declared", () => {
    const result = BlockPatternSchema.safeParse({
      id: "form",
      title: "Form",
      blocks: [{ ...paragraph, type: "acme.forms.contact" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("requiresBlockTypes");
  });

  it("accepts locale-specific copy and blocks", () => {
    expect(
      BlockPatternSchema.safeParse({
        id: "hero",
        title: "Hero",
        blocks: [paragraph],
        locales: { nl: { title: "Hero NL", blocks: [{ ...paragraph, props: { text: "Hallo" } }] } },
      }).success,
    ).toBe(true);
  });
});

describe("pattern distribution schemas", () => {
  it("accepts versioned sets and safe theme registrations", () => {
    expect(
      PatternSetSchema.safeParse({
        schemaVersion: 1,
        patterns: [{ id: "hero", title: "Hero", blocks: [paragraph] }],
      }).success,
    ).toBe(true);
    expect(ThemePatternRegistrationSchema.safeParse("./patterns/hero.json").success).toBe(true);
    expect(ThemePatternRegistrationSchema.safeParse("../hero.json").success).toBe(false);
  });
});
