import { describe, expect, it } from "vitest";
import { applyMergeTags } from "../../src/lib/merge-tags";

describe("applyMergeTags", () => {
  it("replaces known tags and leaves unknown ones", () => {
    expect(applyMergeTags("{{title}} {{missing}}", { title: "Tote" })).toBe("Tote {{missing}}");
  });

  it("returns the input when there are no values", () => {
    expect(applyMergeTags("{{title}}", undefined)).toBe("{{title}}");
  });
});
