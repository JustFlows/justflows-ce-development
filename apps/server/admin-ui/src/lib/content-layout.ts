export function usesPageBuilderChrome(type: string): boolean {
  return type === "page" || type === "product" || type === "shop";
}

export function isEmptyBlockDocument(blocks: { blocks?: unknown } | null | undefined): boolean {
  return !blocks || !Array.isArray(blocks.blocks) || blocks.blocks.length === 0;
}

/** Seed the product layout only on the original locale, not on empty translations. */
export function shouldSeedProductLayout(item: {
  type?: string;
  id?: string;
  translationGroupId?: string | null;
}): boolean {
  if (item.type !== "product") return false;
  if (!item.id) return true;
  return !item.translationGroupId || item.translationGroupId === item.id;
}

export async function fetchProductPattern(): Promise<{ version: 1; blocks: unknown[] } | null> {
  try {
    const res = await fetch("/api/themes/patterns/product");
    if (!res.ok) return null;
    const data = (await res.json()) as { pattern?: { blocks?: unknown[] } };
    if (!Array.isArray(data.pattern?.blocks) || data.pattern.blocks.length === 0) return null;
    return { version: 1, blocks: data.pattern.blocks };
  } catch {
    return null;
  }
}
