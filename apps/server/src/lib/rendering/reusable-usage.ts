// SPDX-License-Identifier: MIT

import type { EffectiveAccess } from "../auth/access-policy.js";
import { capabilityReach } from "../content/content-visibility.js";
import { findBlockReferences, type ReferencedContent } from "./block-references.js";

/**
 * Where a reusable block is used (justflows-ce#304), shaped for one viewer.
 *
 * Counts cover everything, so the impact of a publish or delete is never
 * understated. The content list only names entries the viewer may open:
 * published entries they can read, and unpublished ones within their editing
 * reach. The rest are counted in `hiddenContent`, never named.
 */
export interface ReusableUsage {
  total: number;
  contentCount: number;
  /** Content the viewer may see, at most 100. */
  content: Array<Omit<ReferencedContent, "authorId">>;
  hiddenContent: number;
  templateParts: string[];
  templates: string[];
  menus: string[];
  reusableBlocks: string[];
  patterns: string[];
  truncated: boolean;
}

const LIST_LIMIT = 100;

export function canSeeContent(access: EffectiveAccess, siteId: string, userId: string, row: ReferencedContent): boolean {
  const request = { siteId, contentType: row.type, locale: row.locale };
  if (row.status === "published" && capabilityReach(access, "content:read", request) !== "none") return true;
  const reach = capabilityReach(access, "content:update", request);
  return reach === "all" || (reach === "own" && row.authorId === userId);
}

export async function reusableUsageFor(
  siteId: string,
  id: string,
  viewer: { userId: string; access: EffectiveAccess },
): Promise<ReusableUsage> {
  const found = await findBlockReferences(siteId, "ref", id);
  const visible = found.content.filter((row) => canSeeContent(viewer.access, siteId, viewer.userId, row));
  return {
    total:
      found.content.length + found.templateParts.length + found.templates.length + found.menus.length + found.reusableBlocks.length + found.patterns.length,
    contentCount: found.content.length,
    content: visible.slice(0, LIST_LIMIT).map(({ authorId: _author, ...row }) => row),
    hiddenContent: found.content.length - visible.length,
    templateParts: found.templateParts,
    templates: found.templates,
    menus: found.menus,
    reusableBlocks: found.reusableBlocks,
    patterns: found.patterns,
    truncated: found.truncated,
  };
}
