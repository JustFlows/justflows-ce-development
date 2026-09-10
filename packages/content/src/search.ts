// SPDX-License-Identifier: MIT
import { z } from "zod";

/** Bound all work before passing a visitor query to an index or plugin. */
const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
export const SearchQuerySchema = z
  .object({
    q: z.string().trim().max(200).default(""),
    locale: optionalText(z.string().min(2).max(20)),
    type: optionalText(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .max(60),
    ),
    taxonomy: optionalText(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .max(60),
    ),
    term: optionalText(z.string().max(255)),
    after: optionalText(z.iso.date()),
    before: optionalText(z.iso.date()),
    page: z.coerce.number().int().min(1).max(100).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((v) => !v.after || !v.before || v.after <= v.before, "Invalid date range");
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export function searchTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 12);
}
/** Plain segments, never HTML. Clients must render text, even for matches. */
export function searchHighlight(
  text: string,
  query: string,
): Array<{ text: string; match: boolean }> {
  const tokens = searchTokens(query).sort((a, b) => b.length - a.length);
  if (!tokens.length) return [{ text, match: false }];
  const pattern = new RegExp(`(${tokens.join("|")})`, "giu");
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, match: tokens.some((t) => part.toLowerCase() === t) }));
}
