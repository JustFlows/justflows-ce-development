// SPDX-License-Identifier: MIT

/**
 * WordPress-style template hierarchy for Justflows themes.
 *
 * A public request resolves to an ordered list of candidate template slugs,
 * most-specific first, always ending in `index`. The renderer walks the list
 * and uses the first template the active theme actually ships
 * (`themes/<theme>/templates/<slug>.json`), falling back to a built-in default
 * when the theme provides none. This mirrors
 * https://developer.wordpress.org/themes/templates/template-hierarchy/ but the
 * template body is a Justflows block document (`{ blocks: [...] }`), not PHP.
 *
 * This module is intentionally pure — no filesystem, no database — so the
 * hierarchy is unit-testable on its own. `theme-templates.ts` does the file
 * lookups; `public-site.ts` builds the {@link TemplateQuery} from the request.
 */

/** Every template slot a theme may define, coarsest fallbacks last. */
export const TEMPLATE_SLOTS = [
  "front-page",
  "home",
  "single",
  "page",
  "singular",
  "archive",
  "search",
  "404",
  "index",
] as const;

export type TemplateSlot = (typeof TEMPLATE_SLOTS)[number];

/** Site-editable template parts (chrome shared across templates). */
export const TEMPLATE_PART_SLOTS = ["header", "footer"] as const;
export type TemplatePartSlot = (typeof TEMPLATE_PART_SLOTS)[number];

/**
 * What is being rendered. Built by `public-site.ts` from the resolved route.
 *
 * - `home`      — the site root (`/`). `frontPageKind` says whether a static
 *                 page or the blog index sits there.
 * - `singular`  — one content row (page, post, or a custom content type).
 * - `archive`   — a list view for a content type (not yet routed; reserved).
 * - `search`    — public search results, filters, and pagination.
 * - `notFound`  — nothing matched the URL.
 */
export type TemplateQuery =
  | { kind: "home"; frontPageKind: "page" | "posts"; slug?: string }
  | { kind: "singular"; contentType: string; slug: string }
  | { kind: "archive"; contentType: string }
  | { kind: "search" }
  | { kind: "notFound" };

/** Keep a slug safe to interpolate into a filename: lowercase, `[a-z0-9-]`. */
function slugSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function dedupe(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * The ordered candidate template slugs for a request, most specific first and
 * always ending in `index`. A `page` content type resolves through `page`; any
 * other type through `single`; both share the `singular` fallback.
 */
export function templateCandidates(query: TemplateQuery): string[] {
  switch (query.kind) {
    case "home": {
      if (query.frontPageKind === "page") {
        const slug = query.slug ? slugSegment(query.slug) : "";
        return dedupe(["front-page", slug ? `page-${slug}` : "", "page", "singular", "index"]);
      }
      return dedupe(["front-page", "home", "index"]);
    }
    case "singular": {
      const type = slugSegment(query.contentType);
      const slug = slugSegment(query.slug);
      if (type === "page") {
        return dedupe([slug ? `page-${slug}` : "", "page", "singular", "index"]);
      }
      return dedupe([
        type && slug ? `single-${type}-${slug}` : "",
        type ? `single-${type}` : "",
        "single",
        "singular",
        "index",
      ]);
    }
    case "archive": {
      const type = slugSegment(query.contentType);
      return dedupe([type ? `archive-${type}` : "", "archive", "index"]);
    }
    case "search":
      return dedupe(["search", "index"]);
    case "notFound":
      return dedupe(["404", "index"]);
  }
}

/** The single most-specific slug for a request — used for labels/telemetry. */
export function primaryTemplateSlug(query: TemplateQuery): string {
  return templateCandidates(query)[0] ?? "index";
}
