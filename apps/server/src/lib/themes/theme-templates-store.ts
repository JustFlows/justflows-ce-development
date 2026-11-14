// SPDX-License-Identifier: MIT

/**
 * The editing + resolution layer for theme templates, sitting between the
 * `theme_templates` table ({@link theme-templates-db.ts}), the theme's own
 * `templates/*.json` files ({@link theme-files.ts}), and the public renderer.
 *
 * Resolution for a request (see {@link resolveEffectiveTemplate}) walks the
 * template hierarchy candidate list and, per slug, prefers a per-site override
 * over the theme's file — so a theme's `single-post.json` still beats a site's
 * customised `single`, exactly like WordPress.
 */

import { sanitizeBlockDocument, sanitizeTemplateDefaults, type TemplateDefaults } from "@justflows/blocks";
import {
  clearThemeTemplateDraftDoc,
  deleteThemeTemplateRow,
  getThemeTemplateDoc,
  getThemeTemplateDocs,
  listOverriddenTemplateSlugs,
  publishThemeTemplateDoc,
  saveThemeTemplateDraft,
  saveThemeTemplatePublished,
  themeTemplateHasDraft,
} from "./theme-templates-db.js";
import { listThemeTemplateSlugs, loadThemeTemplate, loadThemeTemplateDoc } from "./theme-files.js";
import { templateCandidates, type TemplateQuery } from "../rendering/template-hierarchy.js";
import { loadPluginTemplate } from "../plugins/plugin-templates.js";
import type { BlockNode } from "../runtime/types.js";
import { recordDocumentHistory, themeTemplateHistoryKey } from "../rendering/document-history.js";

const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function isTemplateSlug(value: unknown): value is string {
  return typeof value === "string" && TEMPLATE_SLUG_RE.test(value);
}

interface StoredTemplateDoc {
  version: 1;
  blocks?: unknown;
  /** Style defaults for the content this template wraps, by block type (justflows-ce#301). */
  templateDefaults?: unknown;
}

/** A template as the editor and renderer see it. */
export interface TemplateDocView {
  blocks: BlockNode[];
  templateDefaults?: TemplateDefaults;
}

function toBlocks(doc: StoredTemplateDoc | null): BlockNode[] | null {
  if (!doc) return null;
  return sanitizeBlockDocument({ version: 1, blocks: doc.blocks }).blocks as BlockNode[];
}

function toView(doc: StoredTemplateDoc | null): TemplateDocView | null {
  if (!doc) return null;
  const defaults = sanitizeTemplateDefaults(doc.templateDefaults);
  return { blocks: toBlocks(doc)!, ...(defaults ? { templateDefaults: defaults } : {}) };
}

/** A per-site override as a document (published, or the draft), or null when none. */
export async function getStoredTemplateDoc(
  siteId: string,
  themeId: string,
  slug: string,
  draft = false,
): Promise<TemplateDocView | null> {
  return toView(await getThemeTemplateDoc<StoredTemplateDoc>(siteId, themeId, slug, { draft }));
}

/** A per-site override's blocks (published, or the draft), or null when none. */
export async function getStoredTemplate(
  siteId: string,
  themeId: string,
  slug: string,
  draft = false,
): Promise<BlockNode[] | null> {
  return toBlocks(await getThemeTemplateDoc<StoredTemplateDoc>(siteId, themeId, slug, { draft }));
}

export async function getStoredTemplateDocs(
  siteId: string,
  themeId: string,
  slug: string,
): Promise<{
  published: BlockNode[] | null;
  draft: BlockNode[] | null;
  publishedDefaults?: TemplateDefaults;
  draftDefaults?: TemplateDefaults;
}> {
  const { doc, draft } = await getThemeTemplateDocs<StoredTemplateDoc>(siteId, themeId, slug);
  const publishedDefaults = sanitizeTemplateDefaults(doc?.templateDefaults);
  const draftDefaults = sanitizeTemplateDefaults(draft?.templateDefaults);
  return {
    published: toBlocks(doc),
    draft: toBlocks(draft),
    ...(publishedDefaults ? { publishedDefaults } : {}),
    ...(draftDefaults ? { draftDefaults } : {}),
  };
}

/**
 * Save a template override as a draft or publish it, with an optional
 * revision check. Returns the stored blocks and the row's new revision; a
 * stale `expectedRevision` throws `DocumentRevisionConflictError`.
 */
export async function writeStoredTemplate(
  siteId: string,
  themeId: string,
  slug: string,
  blocks: unknown,
  opts: { draft: boolean; expectedRevision?: number; actorId?: string | null; templateDefaults?: unknown },
): Promise<{ blocks: BlockNode[]; revision: number; templateDefaults?: TemplateDefaults }> {
  const sanitized = sanitizeBlockDocument({ version: 1, blocks });
  /** A save that says nothing about defaults keeps the ones already stored (older clients). */
  let templateDefaults: TemplateDefaults | undefined;
  if (opts.templateDefaults === undefined) {
    const current = await getThemeTemplateDocs<StoredTemplateDoc>(siteId, themeId, slug);
    templateDefaults = sanitizeTemplateDefaults((current.draft ?? current.doc)?.templateDefaults);
  } else {
    templateDefaults = sanitizeTemplateDefaults(opts.templateDefaults);
  }
  const doc = { version: 1 as const, blocks: sanitized.blocks, ...(templateDefaults ? { templateDefaults } : {}) };
  const revision = opts.draft
    ? await saveThemeTemplateDraft(siteId, themeId, slug, doc, opts.expectedRevision)
    : await publishThemeTemplateDoc(siteId, themeId, slug, doc, opts.expectedRevision);
  await recordDocumentHistory({
    siteId,
    kind: "theme_template",
    key: themeTemplateHistoryKey(themeId, slug),
    revision,
    state: opts.draft ? "draft" : "published",
    doc,
    actorId: opts.actorId,
  });
  return { blocks: sanitized.blocks as BlockNode[], revision, ...(templateDefaults ? { templateDefaults } : {}) };
}

/** The override row's current revision, or 0 when the site has none. */
export async function getStoredTemplateRevision(siteId: string, themeId: string, slug: string): Promise<number> {
  return (await getThemeTemplateDocs(siteId, themeId, slug)).revision;
}

export async function saveStoredTemplate(
  siteId: string,
  themeId: string,
  slug: string,
  blocks: unknown,
  draft = false,
): Promise<BlockNode[]> {
  const sanitized = sanitizeBlockDocument({ version: 1, blocks });
  const doc = { version: 1 as const, blocks: sanitized.blocks };
  const revision = draft
    ? await saveThemeTemplateDraft(siteId, themeId, slug, doc)
    : await saveThemeTemplatePublished(siteId, themeId, slug, doc);
  await recordDocumentHistory({
    siteId,
    kind: "theme_template",
    key: themeTemplateHistoryKey(themeId, slug),
    revision,
    state: draft ? "draft" : "published",
    doc,
  });
  return sanitized.blocks as BlockNode[];
}

export async function publishStoredTemplate(
  siteId: string,
  themeId: string,
  slug: string,
  blocks: unknown,
): Promise<BlockNode[]> {
  const sanitized = sanitizeBlockDocument({ version: 1, blocks });
  const doc = { version: 1 as const, blocks: sanitized.blocks };
  const revision = await publishThemeTemplateDoc(siteId, themeId, slug, doc);
  await recordDocumentHistory({
    siteId,
    kind: "theme_template",
    key: themeTemplateHistoryKey(themeId, slug),
    revision,
    state: "published",
    doc,
  });
  return sanitized.blocks as BlockNode[];
}

export async function clearStoredTemplateDraft(
  siteId: string,
  themeId: string,
  slug: string,
): Promise<void> {
  await clearThemeTemplateDraftDoc(siteId, themeId, slug);
}

/** Drop the override — the template reverts to the theme's own file. */
export async function resetStoredTemplate(
  siteId: string,
  themeId: string,
  slug: string,
): Promise<void> {
  await deleteThemeTemplateRow(siteId, themeId, slug);
}

export interface TemplateSlotStatus {
  slug: string;
  /** The theme ships `templates/<slug>.json`. */
  inTheme: boolean;
  /** The site has a published override row. */
  customised: boolean;
  /** The site has an unpublished draft for this slug. */
  hasDraft: boolean;
}

/**
 * Every template slug relevant to this theme/site: the theme's own files plus
 * any slug the site has overridden even if the theme has no such file.
 */
export async function listTemplateSlots(
  siteId: string,
  themeId: string,
  installedPath: string | null,
): Promise<TemplateSlotStatus[]> {
  const inThemeSlugs = new Set(listThemeTemplateSlugs(themeId, installedPath));
  const overridden = new Set(await listOverriddenTemplateSlugs(siteId, themeId));
  const slugs = [...new Set([...inThemeSlugs, ...overridden])].sort();

  return Promise.all(
    slugs.map(async (slug) => ({
      slug,
      inTheme: inThemeSlugs.has(slug),
      customised: overridden.has(slug),
      hasDraft: overridden.has(slug) ? await themeTemplateHasDraft(siteId, themeId, slug) : false,
    })),
  );
}

export interface ResolvedTemplate {
  slug: string;
  blocks: BlockNode[];
  source: "override" | "theme" | "plugin";
  /** Style defaults the template gives the content it wraps (justflows-ce#301). */
  templateDefaults?: TemplateDefaults;
}

/**
 * The template to render for a request: per-slug, a site override (its draft in
 * preview) beats the theme's file, which beats an active plugin's template
 * (`manifest.templates`); the first candidate slug with any of them wins.
 * `null` means no template anywhere — the caller falls back to the built-in view.
 */
export async function resolveEffectiveTemplate(
  siteId: string | null,
  themeId: string,
  installedPath: string | null,
  query: TemplateQuery,
  preview: boolean,
): Promise<ResolvedTemplate | null> {
  for (const slug of templateCandidates(query)) {
    if (siteId) {
      if (preview) {
        const draft = await getStoredTemplateDoc(siteId, themeId, slug, true);
        if (draft?.blocks.length) return { slug, source: "override", ...draft };
      }
      const published = await getStoredTemplateDoc(siteId, themeId, slug, false);
      if (published?.blocks.length) return { slug, source: "override", ...published };
    }
    const themeDoc = loadThemeTemplateDoc(themeId, slug, installedPath);
    if (themeDoc?.blocks.length) return { slug, source: "theme", ...themeDoc };
    const pluginBlocks = await loadPluginTemplate(slug);
    if (pluginBlocks?.length) return { slug, blocks: pluginBlocks, source: "plugin" };
  }
  return null;
}
