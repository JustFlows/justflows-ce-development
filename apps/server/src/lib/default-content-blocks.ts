// SPDX-License-Identifier: MIT

import { sanitizeBlockDocument } from "@justflows/blocks";
import { loadThemePattern } from "./theme-files.js";
import { getActiveTheme, getSiteId, themeInstalledPath } from "./themes-db.js";

export function isEmptyBlockDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const blocks = (value as { blocks?: unknown }).blocks;
  return !Array.isArray(blocks) || blocks.length === 0;
}

/** Default storefront layout for a new product when the theme ships a `product` pattern. */
export async function defaultBlocksForContentType(type: string): Promise<unknown> {
  if (type !== "product") return { version: 1, blocks: [] };
  const siteId = await getSiteId();
  const theme = siteId ? await getActiveTheme(siteId) : null;
  const themeId = theme?.theme_id ?? "justflows.default";
  const pattern = loadThemePattern(themeId, "product", themeInstalledPath(theme));
  if (!pattern?.blocks.length) return { version: 1, blocks: [] };
  return sanitizeBlockDocument({ version: 1, blocks: pattern.blocks });
}
