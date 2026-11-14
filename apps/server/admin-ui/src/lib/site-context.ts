// SPDX-License-Identifier: MIT
import type { TemplateDefaults } from "@justflows/blocks";
import type { BlockNode } from "../components/builder/types";
import type { PageHeaderConfig } from "./page-header";

/**
 * A page's surroundings in the builder (justflows-ce#303): the template it
 * renders through and where that template came from, the header it shows,
 * and the footer. Read from `GET /api/templates/resolve?context=1`, drafts
 * included, so the canvas matches the preview a visitor cannot see yet.
 */

export type ContextSource = "override-draft" | "override" | "theme" | "plugin" | "library" | null;

export interface TemplateCandidate {
  slug: string;
  source: ContextSource;
}

export interface SiteContextData {
  template: {
    slug: string;
    source: ContextSource;
    templateDefaults: TemplateDefaults;
    blocks: BlockNode[];
    /** The hierarchy for this content, most specific first; the first with a source is the one shown. */
    candidates: TemplateCandidate[];
  } | null;
  header: { ref: string; config: PageHeaderConfig; source: ContextSource };
  footer: { blocks: BlockNode[]; source: ContextSource };
}

export type SiteRegion = "header" | "template" | "footer";

export async function fetchSiteContext(params: {
  contentType: string;
  slug?: string | null;
  contentId?: string;
  headerRef?: string;
  locale?: string;
}): Promise<SiteContextData | null> {
  const query = new URLSearchParams({ context: "1", contentType: params.contentType, slug: params.slug ?? "" });
  if (params.contentId) query.set("contentId", params.contentId);
  if (params.headerRef) query.set("headerRef", params.headerRef);
  if (params.locale) query.set("locale", params.locale);
  const res = await fetch(`/api/templates/resolve?${query}`);
  if (!res.ok) return null;
  const data = (await res.json()) as Partial<SiteContextData>;
  if (!data || !data.header) return null;
  return {
    template: data.template
      ? {
          slug: data.template.slug,
          source: data.template.source ?? null,
          templateDefaults: data.template.templateDefaults ?? {},
          blocks: Array.isArray(data.template.blocks) ? data.template.blocks : [],
          candidates: Array.isArray(data.template.candidates) ? data.template.candidates : [],
        }
      : null,
    header: data.header,
    footer: { blocks: Array.isArray(data.footer?.blocks) ? data.footer!.blocks : [], source: data.footer?.source ?? null },
  };
}

/**
 * Where to edit a site-wide region. The theme builder opens the right part
 * (and template slug) and offers a way back to the page.
 */
export function siteRegionEditPath(region: SiteRegion, back: string, slug?: string | null): string {
  const params = new URLSearchParams();
  params.set("tab", region === "template" ? "templates" : region);
  if (region === "template" && slug) params.set("slug", slug);
  params.set("back", back);
  return `/admin/themes/customize?${params}`;
}

const RETURN_KEY = "jf-builder-return";

interface BuilderReturn {
  contentId: string;
  selectedId: string | null;
  at: number;
}

/** Remember what was selected before leaving for a site-wide part, so coming back restores it. */
export function rememberBuilderReturn(contentId: string, selectedId: string | null): void {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ contentId, selectedId, at: Date.now() } satisfies BuilderReturn));
  } catch {
    /* storage blocked */
  }
}

/** The selection to restore for this content, consumed once. */
export function takeBuilderReturn(contentId: string): string | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(RETURN_KEY);
    const parsed = JSON.parse(raw) as BuilderReturn;
    if (parsed.contentId !== contentId) return null;
    return parsed.selectedId ?? null;
  } catch {
    return null;
  }
}

/** A `back` link is honoured only when it stays inside the admin. */
export function safeBackPath(raw: string | null): string | null {
  return raw && /^\/admin(\/|$)/.test(raw) && !raw.startsWith("//") ? raw : null;
}
