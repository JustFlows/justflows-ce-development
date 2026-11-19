// SPDX-License-Identifier: MIT

import {
  isRegistryListingBeta,
  isRegistryListingComingSoon,
  isRegistryListingPaid,
  isRegistryListingVisible,
} from "@justflows/sdk";

/**
 * An unlisted, free, released listing on the commercial Marketplace that the
 * registry serves only to the authenticated justflows.com platform (the same
 * rule the registry applies). Other sites never receive these listings.
 */
function isPlatformOnlyListing(listing: unknown): boolean {
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) return false;
  const registry = (listing as { registry?: unknown }).registry;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return false;
  const row = registry as Record<string, unknown>;
  return (
    row["commercialMarketplace"] === true &&
    row["listed"] === false &&
    row["free"] === true &&
    row["comingSoon"] !== true &&
    row["beta"] !== true
  );
}

/** Drop publisher-hidden listings from a marketplace catalogue JSON body. */
export function filterMarketplaceCatalogBody(body: string): string {
  try {
    const data: unknown = JSON.parse(body);
    if (!data || typeof data !== "object" || Array.isArray(data)) return body;
    const record = data as { items?: unknown };
    if (!Array.isArray(record.items)) return body;
    return JSON.stringify({
      ...record,
      items: record.items.filter((item) => marketplaceListingIsVisible(item)),
    });
  } catch {
    return body;
  }
}

export function marketplaceListingIsPaid(listing: unknown): boolean {
  return isRegistryListingPaid(listing);
}

/**
 * Listed by its publisher, or a platform-only listing while this install is
 * the justflows.com platform (`JUSTFLOWS_PLATFORM_INSTALL_TOKEN` set).
 */
export function marketplaceListingIsVisible(listing: unknown): boolean {
  if (isRegistryListingVisible(listing)) return true;
  return Boolean(process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN?.trim()) && isPlatformOnlyListing(listing);
}

export function marketplaceListingIsComingSoon(listing: unknown): boolean {
  return isRegistryListingComingSoon(listing);
}

export function marketplaceListingIsBeta(listing: unknown): boolean {
  return isRegistryListingBeta(listing);
}

/** Site setting that lets administrators install `registry.beta` listings. */
export const MARKETPLACE_ALLOW_BETA_SETTING = "marketplace_allow_beta";
