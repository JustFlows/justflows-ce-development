import { describe, expect, it } from "vitest";
import {
  RegistryListingSchema,
  isRegistryListingComingSoon,
  isRegistryListingPaid,
  isRegistryListingVisible,
} from "./registry.js";

describe("RegistryListingSchema", () => {
  it("defaults to a free, listed, non-commercial listing", () => {
    expect(RegistryListingSchema.parse({})).toEqual({
      commercialMarketplace: false,
      listed: true,
      free: true,
      comingSoon: false,
    });
  });

  it("requires a price when the listing is paid", () => {
    const result = RegistryListingSchema.safeParse({ free: false });
    expect(result.success).toBe(false);
  });

  it("rejects a price on a free listing", () => {
    const result = RegistryListingSchema.safeParse({
      free: true,
      price: { amount: 9, currency: "EUR" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a paid listing with ISO currency", () => {
    expect(
      RegistryListingSchema.parse({
        commercialMarketplace: true,
        listed: false,
        comingSoon: true,
        free: false,
        price: { amount: 49, currency: "EUR", interval: "year" },
      }),
    ).toMatchObject({
      commercialMarketplace: true,
      listed: false,
      comingSoon: true,
      free: false,
      price: { amount: 49, currency: "EUR", interval: "year" },
    });
  });
});

describe("registry listing visibility", () => {
  it("hides a listing the publisher set listed false", () => {
    expect(isRegistryListingVisible({ registry: { listed: false } })).toBe(false);
    expect(isRegistryListingVisible({ listed: false })).toBe(false);
    expect(isRegistryListingVisible({ registry: { listed: true } })).toBe(true);
    expect(isRegistryListingVisible({})).toBe(true);
  });

  it("treats free false, pricing.paid, and commercial channel as paid", () => {
    expect(isRegistryListingPaid({ registry: { free: false } })).toBe(true);
    expect(isRegistryListingPaid({ pricing: { type: "paid" } })).toBe(true);
    expect(isRegistryListingPaid({ channel: "commercial" })).toBe(true);
    expect(isRegistryListingPaid({ registry: { free: true } })).toBe(false);
  });

  it("treats comingSoon as announced but not installable", () => {
    expect(isRegistryListingComingSoon({ registry: { comingSoon: true, listed: true } })).toBe(true);
    expect(isRegistryListingComingSoon({ comingSoon: true })).toBe(true);
    expect(isRegistryListingComingSoon({ registry: { comingSoon: false } })).toBe(false);
    expect(isRegistryListingComingSoon({})).toBe(false);
  });
});
