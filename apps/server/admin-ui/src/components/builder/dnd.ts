import { canNestBlock } from "@justflows/blocks";
import type { BlockCatalogEntry, BlockNode } from "./types";

export const DND_BLOCK_TYPE = "application/x-justflows-block-type";
export const DND_BLOCK_ID = "application/x-justflows-block-id";

/** Virtual parent for blocks dropped into page header chrome. */
export const HEADER_SLOT_PARENT_TYPE = "core.header";

/**
 * Whether `childType` may be dropped into `parentType`. Delegates to the shared
 * document contract so drag-and-drop, moves, pastes, and server validation all
 * apply the same nesting rules. The header slot is a region root.
 */
export function canDropBlockType(
  parentType: string | null,
  childType: string,
  catalog: Map<string, BlockCatalogEntry>,
): boolean {
  const parent = parentType === HEADER_SLOT_PARENT_TYPE ? null : parentType;
  return canNestBlock(parent, childType, (type) => catalog.get(type));
}

export function libraryTargetParent(
  blocks: BlockNode[],
  selectedId: string | null,
  catalog: Map<string, BlockCatalogEntry>,
): string | null {
  if (!selectedId) return null;

  const find = (list: BlockNode[]): BlockNode | null => {
    for (const b of list) {
      if (b.id === selectedId) return b;
      if (b.children?.length) {
        const nested = find(b.children);
        if (nested) return nested;
      }
    }
    return null;
  };

  const selected = find(blocks);
  if (!selected) return null;

  if (selected.type === "core.columns") {
    return selected.children?.[0]?.id ?? null;
  }

  const meta = catalog.get(selected.type);
  if (meta?.supportsChildren) {
    return selected.id;
  }

  return null;
}

export function getChildCount(blocks: BlockNode[], parentId: string | null): number {
  if (!parentId) return blocks.length;

  const find = (list: BlockNode[]): number | null => {
    for (const b of list) {
      if (b.id === parentId) return (b.children ?? []).length;
      if (b.children?.length) {
        const n = find(b.children);
        if (n !== null) return n;
      }
    }
    return null;
  };

  return find(blocks) ?? 0;
}

export function getParentType(blocks: BlockNode[], parentId: string | null): string | null {
  if (!parentId) return null;

  const find = (list: BlockNode[]): string | null => {
    for (const b of list) {
      if (b.id === parentId) return b.type;
      if (b.children?.length) {
        const t = find(b.children);
        if (t) return t;
      }
    }
    return null;
  };

  return find(blocks);
}
