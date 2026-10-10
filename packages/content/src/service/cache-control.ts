// SPDX-License-Identifier: MIT
import { z } from "zod";
import { contentTypePolicy } from "./content-types.js";

export const NEVER_CACHE_CONTROL = "private, no-store";
const flags = new Set(["public", "private", "no-cache", "no-store", "must-revalidate", "proxy-revalidate", "immutable", "no-transform"]);
const durations = new Set(["max-age", "s-maxage", "stale-while-revalidate", "stale-if-error"]);

/** A deliberately bounded subset of Cache-Control; never accepts header injection. */
export function normalizeCacheControl(value: string): string {
  if (!value.trim() || value.length > 512 || /[\r\n\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Cache-Control value");
  const seen = new Set<string>();
  const parts = value.split(",").map(part => {
    const match = /^\s*([a-z-]+)(?:\s*=\s*(\d+))?\s*$/i.exec(part);
    if (!match) throw new Error("Invalid Cache-Control directive");
    const name = match[1]!.toLowerCase(), raw = match[2];
    if (seen.has(name)) throw new Error("Duplicate Cache-Control directive");
    seen.add(name);
    if (flags.has(name) && raw === undefined) return name;
    if (durations.has(name) && raw !== undefined && Number(raw) <= 31536000) return `${name}=${Number(raw)}`;
    throw new Error("Unsupported Cache-Control directive or duration (maximum one year)");
  });
  if (seen.has("public") && seen.has("private")) throw new Error("Cache-Control cannot be both public and private");
  return parts.join(", ");
}

/** null inherits site settings. Private/no-cache/no-store policies bypass shared storage. */
export const ContentTypeCacheControlSchema = z.string().transform((value, ctx) => {
  try { return normalizeCacheControl(value); }
  catch (error) { ctx.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
}).nullable();

export function cacheControlPolicy(value: string) {
  const normalized = normalizeCacheControl(value);
  const directives = new Map(normalized.split(", ").map(part => {
    const [name, seconds] = part.split("="); return [name!, seconds === undefined ? true : Number(seconds)] as const;
  }));
  const ttl = directives.get("s-maxage") ?? directives.get("max-age");
  const shared = !["private", "no-cache", "no-store"].some(key => directives.has(key)) && typeof ttl === "number" && ttl > 0 && directives.get("max-age") !== 0;
  return { header: normalized, shared, ttl: shared ? ttl as number : 0 };
}


/** Stored with content fields so drafts, translations and revisions keep the override. */
export const ContentCacheFieldsSchema = z.record(z.string(), z.unknown()).transform((fields, ctx) => {
  if (fields["cacheControl"] === undefined) return fields;
  const parsed = ContentTypeCacheControlSchema.safeParse(fields["cacheControl"]);
  if (!parsed.success) {
    ctx.addIssue({ code: "custom", path: ["cacheControl"], message: parsed.error.issues[0]?.message ?? "Invalid Cache-Control" });
    return z.NEVER;
  }
  return { ...fields, cacheControl: parsed.data };
});

export function validateContentCacheFields(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  if (!contentTypePolicy(type).cacheable && fields["cacheControl"] != null) throw new Error("This content type must never be cached; Cache-Control is locked");
  return ContentCacheFieldsSchema.parse(fields);
}

/** Mandatory privacy wins; a non-null post override wins over its type default. */
export function effectiveContentCacheControl(type: string, fields: Record<string, unknown>, typeDefault: string | null): string | null {
  if (!contentTypePolicy(type).cacheable) return NEVER_CACHE_CONTROL;
  const value = fields["cacheControl"] ?? typeDefault;
  if (value == null) return null;
  const parsed = ContentTypeCacheControlSchema.safeParse(value);
  // Invalid persisted/plugin values must never enable caching.
  return parsed.success ? parsed.data : NEVER_CACHE_CONTROL;
}
