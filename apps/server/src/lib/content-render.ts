// SPDX-License-Identifier: MIT

import { ensurePluginRuntime, getRuntimeHooks } from "./plugin-runtime.js";

type ContentRenderInput = {
  id: string;
  siteId: string;
  type: string;
  title: string;
  excerpt?: string | null;
  translationGroupId?: string | null;
};

function decodeMustacheEntities(input: string): string {
  if (!input.includes("&#123;") && !input.includes("&#125;")) return input;
  return input.replaceAll("&#123;", "{").replaceAll("&#125;", "}");
}

function filterContext(content: ContentRenderInput) {
  return {
    siteId: content.siteId,
    contentId: content.id,
    type: content.type,
    title: content.title,
    excerpt: content.excerpt ?? null,
    translationGroupId: content.translationGroupId ?? content.id,
  };
}

function hookContext(content: ContentRenderInput) {
  return { siteId: content.siteId, source: "http" as const };
}

function looksTagged(value: string): boolean {
  return value.includes("{{") || value.includes("&#123;");
}

/** Fill `{{tags}}` in block props before HTML render (Shop catalog, and similar). */
export async function applyContentBlocks<T>(blocks: T, content: ContentRenderInput): Promise<T> {
  if (!looksTagged(JSON.stringify(blocks))) return blocks;
  await ensurePluginRuntime();
  return getRuntimeHooks().applyFilter(
    "content.blocks",
    blocks,
    filterContext(content),
    hookContext(content),
  );
}

/** Fill `{{tags}}` in public body HTML after blocks have rendered. */
export async function applyContentRender(
  html: string,
  content: ContentRenderInput,
): Promise<string> {
  const decoded = decodeMustacheEntities(html);
  if (!decoded.includes("{{")) return decoded;
  await ensurePluginRuntime();
  return getRuntimeHooks().applyFilter(
    "content.render",
    decoded,
    filterContext(content),
    hookContext(content),
  );
}
