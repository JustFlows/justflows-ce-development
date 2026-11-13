// SPDX-License-Identifier: MIT

import { sanitizeBlockDocument } from "@justflows/blocks";
import {
  clearTemplatePartDraftDoc,
  getTemplatePartDoc,
  getTemplatePartDocs,
  publishTemplatePartDoc,
  saveTemplatePartDraft,
  saveTemplatePartPublished,
} from "./template-parts-db.js";
import type { BlockNode } from "../runtime/types.js";

/**
 * Template parts: chrome that is the same on every page and is edited as
 * blocks rather than as a template file.
 *
 * Stored in the dedicated `template_parts` table (see `template-parts-db.ts`),
 * one row per site per part, with a published `doc` and an optional `draft_doc`.
 * The header has its own richer document and lives in `site-header.ts`; the
 * footer is a plain block document handled here.
 */
export const TEMPLATE_PARTS = ["footer"] as const;
export type TemplatePart = (typeof TEMPLATE_PARTS)[number];

export function isTemplatePart(value: unknown): value is TemplatePart {
  return typeof value === "string" && (TEMPLATE_PARTS as readonly string[]).includes(value);
}

interface FooterDoc {
  version: 1;
  blocks?: unknown;
}

export async function getTemplatePart(
  siteId: string,
  part: TemplatePart,
  draft = false,
): Promise<BlockNode[]> {
  const stored = await getTemplatePartDoc<FooterDoc>(siteId, part, { draft });
  if (!stored) return [];
  return sanitizeBlockDocument({ version: 1, blocks: stored.blocks }).blocks as BlockNode[];
}

export async function saveTemplatePart(
  siteId: string,
  part: TemplatePart,
  blocks: unknown,
  draft = false,
): Promise<BlockNode[]> {
  const sanitized = sanitizeBlockDocument({ version: 1, blocks });
  const doc = { version: 1 as const, blocks: sanitized.blocks };
  if (draft) await saveTemplatePartDraft(siteId, part, doc);
  else await saveTemplatePartPublished(siteId, part, doc);
  return sanitized.blocks as BlockNode[];
}

/**
 * Save a template part as a draft or publish it, with an optional revision
 * check. Returns the stored blocks and the row's new revision; a stale
 * `expectedRevision` throws `DocumentRevisionConflictError`.
 */
export async function writeTemplatePart(
  siteId: string,
  part: TemplatePart,
  blocks: unknown,
  opts: { draft: boolean; expectedRevision?: number },
): Promise<{ blocks: BlockNode[]; revision: number }> {
  const sanitized = sanitizeBlockDocument({ version: 1, blocks });
  const doc = { version: 1 as const, blocks: sanitized.blocks };
  const revision = opts.draft
    ? await saveTemplatePartDraft(siteId, part, doc, opts.expectedRevision)
    : await publishTemplatePartDoc(siteId, part, doc, opts.expectedRevision);
  return { blocks: sanitized.blocks as BlockNode[], revision };
}

/** The part row's current revision, or 0 when it has never been saved. */
export async function getTemplatePartRevision(siteId: string, part: TemplatePart): Promise<number> {
  return (await getTemplatePartDocs(siteId, part)).revision;
}

export async function clearTemplatePartDraft(siteId: string, part: TemplatePart): Promise<void> {
  await clearTemplatePartDraftDoc(siteId, part);
}

/**
 * Publish a template part: write the published copy and drop the leftover
 * draft. Without clearing it, a stale draft — even an older one from a
 * previous session — keeps outranking the freshly published version in
 * preview (see getEffectiveTemplatePart), making Publish look like a no-op.
 */
export async function publishTemplatePart(
  siteId: string,
  part: TemplatePart,
  blocks: unknown,
): Promise<BlockNode[]> {
  const sanitized = sanitizeBlockDocument({ version: 1, blocks });
  await publishTemplatePartDoc(siteId, part, { version: 1, blocks: sanitized.blocks });
  return sanitized.blocks as BlockNode[];
}

/**
 * The published part, falling back to the draft only in preview.
 *
 * An empty part is not "no footer" — it means the site never customised one,
 * and the layout keeps its built-in menu and credit line.
 */
export async function getEffectiveTemplatePart(
  siteId: string,
  part: TemplatePart,
  preview: boolean,
): Promise<BlockNode[]> {
  if (preview) {
    const draft = await getTemplatePart(siteId, part, true);
    if (draft.length > 0) return draft;
  }
  return getTemplatePart(siteId, part, false);
}
