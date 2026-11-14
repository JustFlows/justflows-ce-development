// SPDX-License-Identifier: MIT
import type { BlockNode } from "./types";

/**
 * Saving selected blocks to the site libraries (justflows-ce#298). The routes
 * are limited to administrators and editors; the menu disables these actions
 * for anyone else, and the server refuses them regardless.
 */

async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? fallback;
  } catch {
    return fallback;
  }
}

/** Store the blocks as one reusable block and return its id. */
export async function saveReusableBlocks(name: string, blocks: BlockNode[], fallbackError: string): Promise<string> {
  const res = await fetch("/api/reusable-blocks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() || undefined, blocks }),
  });
  if (!res.ok) throw new Error(await errorOf(res, fallbackError));
  const body = (await res.json()) as { item?: { id: string } };
  if (!body.item?.id) throw new Error(fallbackError);
  return body.item.id;
}

/** Plugin block types a pattern needs, so the library can hide it when one is missing. */
export function requiredPluginTypes(blocks: BlockNode[]): string[] {
  const used = new Set<string>();
  const visit = (items: BlockNode[]) =>
    items.forEach((block) => {
      if (!block.type.startsWith("core.")) used.add(block.type);
      if (block.children) visit(block.children);
    });
  visit(blocks);
  return [...used];
}

export async function saveBlockPattern(
  input: { title: string; description: string; blocks: BlockNode[]; synced: boolean },
  fallbackError: string,
): Promise<void> {
  const res = await fetch("/api/patterns", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title.trim(),
      description: input.description,
      category: "site",
      requiresBlockTypes: requiredPluginTypes(input.blocks),
      blocks: input.blocks,
      synced: input.synced,
    }),
  });
  if (!res.ok) throw new Error(await errorOf(res, fallbackError));
}
