export function usesBlockEditor(type: string, editorIsBlocks: boolean): boolean {
  return type === "page" || editorIsBlocks;
}

export function isEmptyBlockDocument(blocks: { blocks?: unknown } | null | undefined): boolean {
  return !blocks || !Array.isArray(blocks.blocks) || blocks.blocks.length === 0;
}

/** Seed a same-named pattern only on the original locale, not on an empty translation. */
export function shouldSeedTypePattern(item: {
  id?: string;
  translationGroupId?: string | null;
}): boolean {
  if (!item.id) return true;
  return !item.translationGroupId || item.translationGroupId === item.id;
}

export async function fetchTypePattern(type: string): Promise<{ version: 1; blocks: unknown[] } | null> {
  if (!/^[a-z][a-z0-9-]{0,59}$/.test(type)) return null;
  try {
    const res = await fetch(`/api/themes/patterns/${encodeURIComponent(type)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { pattern?: { blocks?: unknown[] } };
    if (!Array.isArray(data.pattern?.blocks) || data.pattern.blocks.length === 0) return null;
    return { version: 1, blocks: data.pattern.blocks };
  } catch {
    return null;
  }
}
