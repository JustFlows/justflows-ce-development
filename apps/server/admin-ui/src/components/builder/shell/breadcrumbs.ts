// SPDX-License-Identifier: MIT
import { findBlockPath, getBlockAtPath } from "../block-tree";
import type { BlockNode } from "../types";
import type { BuilderCrumb } from "./BuilderShell";

export interface SelectionCrumbsInput {
  selectedId: string | null;
  blocks: BlockNode[];
  headerBlocks: BlockNode[];
  /** Id the builder uses for "the header chrome itself is selected". */
  headerSelectedId: string;
  /** True when the document is the header, so it is the root rather than a region. */
  headerOnly: boolean;
  rootLabel: string;
  headerLabel: string;
  /** Human name for a block type, usually its catalog title. */
  typeLabel: (type: string) => string | undefined;
}

/**
 * The document root, every ancestor of the selection, and the selection
 * itself. A block's editor-only label wins over its type name, so complex
 * documents read the way the author named them.
 */
export function selectionCrumbs(input: SelectionCrumbsInput): BuilderCrumb[] {
  const { selectedId, blocks, headerBlocks, headerSelectedId, headerOnly } = input;
  const out: BuilderCrumb[] = [{ id: null, label: input.rootLabel }];
  if (!selectedId) return out;
  if (selectedId === headerSelectedId) {
    return headerOnly ? out : [...out, { id: headerSelectedId, label: input.headerLabel }];
  }
  const inHeader = Boolean(findBlockPath(headerBlocks, selectedId));
  const tree = inHeader ? headerBlocks : blocks;
  const path = findBlockPath(tree, selectedId);
  if (!path) return out;
  if (inHeader && !headerOnly) out.push({ id: headerSelectedId, label: input.headerLabel });
  for (let depth = 1; depth <= path.length; depth++) {
    const node = getBlockAtPath(tree, path.slice(0, depth));
    if (!node) break;
    out.push({ id: node.id, label: node.editor?.label || input.typeLabel(node.type) || node.type });
  }
  return out;
}
