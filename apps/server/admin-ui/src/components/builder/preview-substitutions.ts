/**
 * Blocks the builder canvas deliberately shows differently from the public
 * page (justflows-ce#306), and why. The canvas labels each one, the parity
 * test skips their markup on purpose, and docs/BUILDER-PREVIEW.md lists them.
 * Everything not listed here must match the public renderer.
 *
 * - `site`: shows site data (logo, title, menus, breadcrumbs) that the page
 *   fills in at request time.
 * - `query`: lists content or headings found when the page is served.
 * - `visitor`: depends on the visitor (signed in or not, language, colour
 *   scheme, search input), so the canvas shows a neutral state.
 * - `external`: loads a third-party embed, which the canvas does not run.
 */
export type PreviewSubstitution = "site" | "query" | "visitor" | "external";

export const PREVIEW_SUBSTITUTES: Readonly<Record<string, PreviewSubstitution>> = {
  "core.site-logo": "site",
  "core.site-title": "site",
  "core.site-tagline": "site",
  "core.navigation": "site",
  "core.breadcrumbs": "site",
  "core.content-query": "query",
  "core.table-of-contents": "query",
  "core.search": "visitor",
  "core.account": "visitor",
  "core.auth-form": "visitor",
  "core.auth-links": "visitor",
  "core.language-switcher": "visitor",
  "core.color-scheme": "visitor",
  "core.embed": "external",
};

export function previewSubstitution(type: string): PreviewSubstitution | undefined {
  return PREVIEW_SUBSTITUTES[type];
}
