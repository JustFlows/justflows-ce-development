// SPDX-License-Identifier: MIT
import { canNestBlock } from "@justflows/blocks";
import { findBlockPath, getBlockAtPath } from "./block-tree";
import type { BlockCatalogEntry, BlockNode } from "./types";

/** Which document region a block list belongs to. */
export type DropRegion = "body" | "header";

/** What is being dragged: a new block from the library, or an existing block. */
export interface DropSource {
  type: string;
  /** Set when moving an existing block; null for a new block from the library. */
  blockId: string | null;
}

/** Where it would land: a parent (null = the region root) and an index among its children. */
export interface DropPlacement {
  region: DropRegion;
  parentId: string | null;
  parentType: string | null;
  index: number;
}

export type DropRejection =
  | "nesting"
  | "self"
  | "descendant"
  | "region"
  | "missing";

export type DropVerdict = { ok: true } | { ok: false; reason: DropRejection };

export interface DropRulesInput {
  source: DropSource;
  target: DropPlacement;
  blocks: BlockNode[];
  headerBlocks: BlockNode[];
  catalog: Map<string, BlockCatalogEntry>;
  /** Regions this builder edits. A drop into any other region is refused. */
  regions: ReadonlySet<DropRegion>;
}

function regionOf(id: string, blocks: BlockNode[], headerBlocks: BlockNode[]): DropRegion | null {
  if (findBlockPath(blocks, id)) return "body";
  if (findBlockPath(headerBlocks, id)) return "header";
  return null;
}

function contains(node: BlockNode, id: string): boolean {
  return (node.children ?? []).some((child) => child.id === id || contains(child, id));
}

/**
 * The single decision for every drop on the canvas (justflows-ce#295): may
 * `source` land at `target`? A refused drop never changes the document, and
 * the reason is shown to the author. Rules, in order:
 *
 * 1. The target region must be one this builder edits (`region`). Moving
 *    between the page header slot and the body is allowed when both are edited.
 * 2. A moved block must still exist (`missing`).
 * 3. A block cannot be dropped onto itself (`self`) or into its own subtree
 *    (`descendant`), which would create a cycle.
 * 4. The parent must accept the child type (`nesting`, see `canNestBlock`).
 */
export function evaluateDrop({ source, target, blocks, headerBlocks, catalog, regions }: DropRulesInput): DropVerdict {
  if (!regions.has(target.region)) return { ok: false, reason: "region" };

  if (source.blockId) {
    const from = regionOf(source.blockId, blocks, headerBlocks);
    if (!from) return { ok: false, reason: "missing" };
    if (!regions.has(from)) return { ok: false, reason: "region" };
    if (target.parentId === source.blockId) return { ok: false, reason: "self" };
    const tree = from === "body" ? blocks : headerBlocks;
    const path = findBlockPath(tree, source.blockId);
    const node = path ? getBlockAtPath(tree, path) : null;
    if (!node) return { ok: false, reason: "missing" };
    if (target.parentId && contains(node, target.parentId)) return { ok: false, reason: "descendant" };
  }

  if (!canNestBlock(target.parentType, source.type, (type) => catalog.get(type))) {
    return { ok: false, reason: "nesting" };
  }
  return { ok: true };
}
