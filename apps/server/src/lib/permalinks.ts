// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { ContentResponse } from "./content-api.js";
import { localePath } from "./i18n/locales.js";

export const PERMALINK_PRESETS = {
  plain: "/?p=%id%",
  day: "/%year%/%monthnum%/%day%/%postname%/",
  month: "/%year%/%monthnum%/%postname%/",
  name: "/%postname%/",
  numeric: "/archives/%id%/",
} as const;
export const RESERVED_PERMALINK_SEGMENTS = new Set([
  "admin",
  "preview",
  "search",
  "api",
  "ext",
  "install",
  "login",
  "logout",
  "register",
  "uploads",
  "assets",
  "css-providers",
  "theme.css",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "security.txt",
  ".well-known",
  "justflows-forms",
  "justflows-comments",
  "set-locale",
  "js",
  "css",
  "page",
]);
const TOKENS = new Set(["year", "monthnum", "day", "postname", "category", "author", "id", "type"]);
export function structureError(value: string): string | null {
  if (value === PERMALINK_PRESETS.plain) return null;
  if (!value.startsWith("/") || value.length > 240 || /[?#\\]|\/\/|\.\./.test(value))
    return "Use a local path beginning with / and single path separators.";
  if (value.split("/").some((segment) => segment === "." || segment === ".."))
    return "Dot path segments are not allowed.";
  const tokens = [...value.matchAll(/%([a-z]+)%/g)].map((m) => m[1]!);
  if (tokens.some((t) => !TOKENS.has(t)) || /%/.test(value.replace(/%([a-z]+)%/g, "")))
    return "Unknown permalink token.";
  if (!tokens.includes("postname") && !tokens.includes("id")) return "Include %postname% or %id%.";
  if (!/^[/a-zA-Z0-9_%.-]+$/.test(value)) return "Invalid characters in permalink structure.";
  if (RESERVED_PERMALINK_SEGMENTS.has(value.split("/")[1]!.toLowerCase()))
    return "That path is reserved by Justflows.";
  return null;
}
const base = z
  .string()
  .max(120)
  .regex(/^[a-z0-9]+(?:[-_/][a-z0-9]+)*$/)
  .refine(
    (v) => !RESERVED_PERMALINK_SEGMENTS.has(v.split("/")[0]!),
    "That base is reserved by Justflows.",
  );
export const PermalinkSettingsSchema = z
  .object({
    structure: z.string().superRefine((v, ctx) => {
      const error = structureError(v);
      if (error) ctx.addIssue({ code: "custom", message: error });
    }),
    typeBases: z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), base),
    categoryBase: base,
    tagBase: base,
    taxonomyBases: z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), base),
    trailingSlash: z.enum(["never", "always"]),
  })
  .strict();
export type PermalinkSettings = z.infer<typeof PermalinkSettingsSchema>;
export const DEFAULT_PERMALINK_SETTINGS: PermalinkSettings = {
  structure: "/%postname%/",
  typeBases: {},
  categoryBase: "category",
  tagBase: "tag",
  taxonomyBases: {},
  trailingSlash: "never",
};
export type PermalinkContent = Pick<
  ContentResponse,
  "id" | "slug" | "type" | "locale" | "publishedAt" | "createdAt" | "authorId" | "fields"
> & { permalinkCategory?: string };
export function slashPath(path: string, policy: PermalinkSettings["trailingSlash"]): string {
  const [pathname, query] = path.split("?");
  // Linear trailing-slash trim: a `/\/+$/` regex backtracks quadratically on paths
  // built from request-derived, slash-heavy segments.
  let end = pathname!.length;
  while (end > 0 && pathname!.charCodeAt(end - 1) === 47) end--;
  const clean = pathname!.slice(0, end) || "/";
  return (clean !== "/" && policy === "always" ? `${clean}/` : clean) + (query ? `?${query}` : "");
}
export function permalinkPath(
  content: PermalinkContent,
  settings: PermalinkSettings,
  defaultLocale: string,
): string {
  const date = new Date(content.publishedAt || content.createdAt);
  const validDate = Number.isFinite(date.getTime()) ? date : new Date(0);
  const values: Record<string, string> = {
    year: String(validDate.getUTCFullYear()),
    monthnum: String(validDate.getUTCMonth() + 1).padStart(2, "0"),
    day: String(validDate.getUTCDate()).padStart(2, "0"),
    postname: content.slug,
    id: content.id,
    category: content.permalinkCategory ?? "uncategorized",
    author: content.authorId || "unknown",
    type: content.type,
  };
  const typeBase = Object.hasOwn(settings.typeBases, content.type)
    ? settings.typeBases[content.type]
    : undefined;
  const structure = typeBase
    ? `/${typeBase}/%postname%/`
    : content.type === "post"
      ? settings.structure
      : "/%postname%/";
  const path = structure.replace(/%([a-z]+)%/g, (_, token: string) =>
    encodeURIComponent(values[token]!),
  );
  const [pathname, query] = path.split("?");
  return slashPath(
    localePath(content.locale, pathname!, defaultLocale) + (query ? `?${query}` : ""),
    settings.trailingSlash,
  );
}
