import { describe, expect, it } from "vitest";
import { applyMergeTags, catalogPreviewTags } from "./product-tags";

describe("catalogPreviewTags", () => {
  it("fills {{price}} from sale or regular amount", () => {
    const values = catalogPreviewTags(
      {
        sku: "sku001",
        barcode: "1",
        regularAmount: "10.00",
        saleAmount: "8.00",
        taxClass: "",
        type: "simple",
        visibility: "public",
        stock: 20,
        trackInventory: true,
        weight: "",
        weightUnit: "kg",
        length: "",
        width: "",
        height: "",
        dimensionUnit: "cm",
        attributes: [],
      },
      { title: "Tee", excerpt: "Soft." },
    );
    expect(applyMergeTags("{{title}} {{price}} {{sku}} {{stock}}", values)).toBe("Tee 8.00 sku001 20");
  });
});
