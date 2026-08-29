import { describe, expect, it } from "vitest";
import { listingIsPaid, listingPriceLabel } from "../admin/MarketplacePage";

const shop = {
  id: "justflows.shop",
  name: "Shop",
  description: "Catalog, cart, checkout, and orders.",
  version: "0.1.0",
  downloads: 3400,
  category: "E-commerce",
  type: "plugin" as const,
  tags: [],
  channel: "commercial" as const,
  pricing: { type: "paid" as const, amount: 99, currency: "EUR" },
};

describe("Marketplace listing metadata", () => {
  it("honours registry.free over stale legacy pricing", () => {
    const listing = { ...shop, registry: { free: true, listed: true, comingSoon: true } };

    expect(listingIsPaid(listing)).toBe(false);
    expect(listingPriceLabel(listing)).toBeNull();
  });

  it("uses registry price for a paid listing", () => {
    const listing = {
      ...shop,
      registry: {
        free: false,
        price: { amount: 49, currency: "EUR", interval: "year" as const },
      },
    };

    expect(listingIsPaid(listing)).toBe(true);
    expect(listingPriceLabel(listing)).toMatch(/49/);
    expect(listingPriceLabel(listing)).toContain("/ year");
  });
});
