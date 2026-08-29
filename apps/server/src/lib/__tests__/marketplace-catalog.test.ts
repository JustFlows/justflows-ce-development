// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  filterMarketplaceCatalogBody,
  marketplaceListingIsComingSoon,
  marketplaceListingIsPaid,
} from "../marketplace-catalog.js";

describe("filterMarketplaceCatalogBody", () => {
  it("drops listings the publisher hid", () => {
    const body = JSON.stringify({
      items: [
        { id: "shown.plugin", registry: { listed: true, free: true } },
        { id: "hidden.plugin", registry: { listed: false, free: true } },
        { id: "legacy.plugin" },
      ],
    });
    const next = JSON.parse(filterMarketplaceCatalogBody(body)) as { items: { id: string }[] };
    expect(next.items.map((item) => item.id)).toEqual(["shown.plugin", "legacy.plugin"]);
  });

  it("leaves non-JSON bodies alone", () => {
    expect(filterMarketplaceCatalogBody("not-json")).toBe("not-json");
  });
});

describe("marketplaceListingIsPaid", () => {
  it("uses registry.free when present", () => {
    expect(marketplaceListingIsPaid({ registry: { free: false, listed: true } })).toBe(true);
    expect(marketplaceListingIsPaid({ registry: { free: true } })).toBe(false);
  });
});

describe("marketplaceListingIsComingSoon", () => {
  it("uses registry.comingSoon when present", () => {
    expect(marketplaceListingIsComingSoon({ registry: { comingSoon: true, listed: true } })).toBe(
      true,
    );
    expect(marketplaceListingIsComingSoon({ registry: { comingSoon: false } })).toBe(false);
    expect(marketplaceListingIsComingSoon({})).toBe(false);
  });
});
