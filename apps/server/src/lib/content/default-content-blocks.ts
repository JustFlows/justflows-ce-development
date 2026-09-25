// SPDX-License-Identifier: MIT

import { sanitizeBlockDocument } from "@justflows/blocks";
import { loadThemePattern } from "../themes/theme-files.js";
import { getActiveTheme, getSiteId, themeInstalledPath } from "../themes/themes-db.js";
import { ensurePluginRuntime, getPluginLoader, getRuntimeHooks } from "../plugins/plugin-runtime.js";

export function isEmptyBlockDocument(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const blocks = (value as { blocks?: unknown }).blocks;
  return !Array.isArray(blocks) || blocks.length === 0;
}

/**
 * Content types that adopt a same-named pattern as the starting canvas.
 * `post` is the host default. Plugins append their own slugs through
 * `content.patternTypes`.
 */
export async function defaultBlocksForContentType(type: string): Promise<unknown> {
  const siteId = await getSiteId();
  await ensurePluginRuntime();
  const contributed = await getRuntimeHooks().applyFilter(
    "content.patternTypes",
    ["post"],
    { siteId: siteId ?? "" },
    { siteId: siteId ?? "", source: "http" },
  );
  const backed = new Set(
    (Array.isArray(contributed) ? contributed : ["post"]).filter(
      (slug): slug is string => typeof slug === "string" && /^[a-z][a-z0-9-]{0,59}$/.test(slug),
    ),
  );
  if (!backed.has(type)) return { version: 1, blocks: [] };
  const theme = siteId ? await getActiveTheme(siteId) : null;
  const themeId = theme?.theme_id ?? "justflows.default";
  const themePattern = loadThemePattern(themeId, type, themeInstalledPath(theme));
  const blocks = themePattern?.blocks.length
    ? themePattern.blocks
    : pluginPatternById(type)?.blocks;
  if (!blocks?.length) return { version: 1, blocks: [] };
  return sanitizeBlockDocument({ version: 1, blocks });
}

/** A plugin pattern whose id matches a content type, used when the theme has none. */
export function pluginPatternById(id: string) {
  return getPluginLoader()?.patternRegistry.all().find((pattern) => pattern.id === id);
}
