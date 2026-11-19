// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  filterMarketplaceCatalogBody,
  marketplaceListingIsBeta,
  marketplaceListingIsComingSoon,
  marketplaceListingIsPaid,
} from "../../../src/lib/extensions/marketplace-catalog.js";

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

  it("shows platform-only listings to the justflows.com platform only", () => {
    const saved = process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
    const platformOnly = { commercialMarketplace: true, listed: false, free: true };
    const body = JSON.stringify({
      items: [
        { id: "platform.only", registry: platformOnly },
        { id: "platform.paid", registry: { ...platformOnly, free: false } },
        { id: "platform.beta", registry: { ...platformOnly, beta: true } },
        { id: "hidden.plugin", registry: { listed: false, free: true } },
      ],
    });
    const ids = () =>
      (JSON.parse(filterMarketplaceCatalogBody(body)) as { items: { id: string }[] }).items.map((item) => item.id);
    try {
      delete process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
      expect(ids()).toEqual([]);
      process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN = "platform-secret";
      expect(ids()).toEqual(["platform.only"]);
    } finally {
      if (saved === undefined) delete process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
      else process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN = saved;
    }
  });

  it("leaves non-JSON bodies alone", () => {
    expect(filterMarketplaceCatalogBody("not-json")).toBe("not-json");
  });
});

describe("marketplaceListingIsPaid", () => {
  it("uses registry.free when present", () => {
    expect(marketplaceListingIsPaid({ registry: { free: false, listed: true } })).toBe(true);
    expect(marketplaceListingIsPaid({ registry: { free: true } })).toBe(false);
    expect(
      marketplaceListingIsPaid({
        channel: "commercial",
        pricing: { type: "paid", amount: 99, currency: "EUR" },
        registry: { free: true },
      }),
    ).toBe(false);
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

describe("marketplaceListingIsBeta", () => {
  it("uses registry.beta when present", () => {
    expect(marketplaceListingIsBeta({ registry: { beta: true, listed: true } })).toBe(true);
    expect(marketplaceListingIsBeta({ registry: { beta: false } })).toBe(false);
    expect(marketplaceListingIsBeta({})).toBe(false);
  });
});
