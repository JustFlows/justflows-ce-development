import { z } from "zod";

export const RegistryPriceSchema = z.object({
  /** Major units, e.g. 49 for €49. */
  amount: z.number().positive().finite().max(1_000_000),
  /** ISO 4217, e.g. EUR. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Price currency must be an ISO 4217 code, e.g. EUR"),
  interval: z.enum(["once", "month", "year"]).default("once"),
});

/**
 * Listing controls the plugin registry / Marketplace reads from `justflows.json`.
 *
 * Two gates decide whether a site admin sees the plugin:
 * 1. `commercialMarketplace` — internal: live on the commercial Justflows marketplace.
 * 2. `listed` — publisher visibility. Internal approval does not show it unless this is true.
 *
 * `comingSoon` keeps a listed plugin visible but not installable.
 */
export const RegistryListingSchema = z
  .object({
    commercialMarketplace: z.boolean().default(false),
    listed: z.boolean().default(true),
    free: z.boolean().default(true),
    comingSoon: z.boolean().default(false),
    price: RegistryPriceSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.free) {
      if (value.price !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["price"],
          message: "Omit price when the listing is free",
        });
      }
      return;
    }
    if (!value.price) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "Paid listings must declare price.amount and price.currency",
      });
    }
  });

export type RegistryPrice = z.infer<typeof RegistryPriceSchema>;
export type RegistryListing = z.infer<typeof RegistryListingSchema>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Publisher hide flag. Missing `listed` stays visible so older listings keep working. */
export function isRegistryListingVisible(listing: unknown): boolean {
  const row = asRecord(listing);
  if (!row) return false;
  if (row["listed"] === false) return false;
  const registry = asRecord(row["registry"]);
  if (registry && registry["listed"] === false) return false;
  return true;
}

/** Paid catalogue item — registry.free, legacy pricing.type, or commercial channel. */
export function isRegistryListingPaid(listing: unknown): boolean {
  const row = asRecord(listing);
  if (!row) return false;
  const registry = asRecord(row["registry"]);
  if (registry && registry["free"] === false) return true;
  const pricing = asRecord(row["pricing"]);
  if (pricing && pricing["type"] === "paid") return true;
  return row["channel"] === "commercial";
}

/** Announced but not installable. Missing `comingSoon` stays installable. */
export function isRegistryListingComingSoon(listing: unknown): boolean {
  const row = asRecord(listing);
  if (!row) return false;
  if (row["comingSoon"] === true) return true;
  const registry = asRecord(row["registry"]);
  return Boolean(registry && registry["comingSoon"] === true);
}
