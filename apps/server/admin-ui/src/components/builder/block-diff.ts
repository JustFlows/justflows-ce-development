// SPDX-License-Identifier: MIT
import type { BlockNode } from "./types";

/** One block in a change summary. */
export interface BlockChange {
  id: string;
  type: string;
  label?: string;
}

/** What replacing `current` with `version` would do, block by block. */
export interface BlockChangeSummary {
  added: BlockChange[];
  removed: BlockChange[];
  changed: BlockChange[];
  moved: BlockChange[];
}

interface Located {
  node: BlockNode;
  parentId: string | null;
  index: number;
}

function index(blocks: BlockNode[]): Map<string, Located> {
  const out = new Map<string, Located>();
  const walk = (list: BlockNode[], parentId: string | null) => {
    list.forEach((node, i) => {
      if (node && typeof node.id === "string" && !out.has(node.id)) out.set(node.id, { node, parentId, index: i });
      if (Array.isArray(node?.children)) walk(node.children, node.id);
    });
  };
  walk(Array.isArray(blocks) ? blocks : [], null);
  return out;
}

function describe(node: BlockNode): BlockChange {
  return { id: node.id, type: node.type, ...(node.editor?.label ? { label: node.editor.label } : {}) };
}

/**
 * Compare two block trees by stable block id (see docs/BUILDER-DOCUMENT.md):
 * blocks only in `version` would be added, only in `current` removed, the same
 * id with different props or type changed, and a different parent or position
 * moved. Document order of `version` (then `current` for removals).
 */
export function summarizeBlockChanges(current: BlockNode[], version: BlockNode[]): BlockChangeSummary {
  const now = index(current);
  const then = index(version);
  const summary: BlockChangeSummary = { added: [], removed: [], changed: [], moved: [] };
  for (const [id, entry] of then) {
    const before = now.get(id);
    if (!before) {
      summary.added.push(describe(entry.node));
      continue;
    }
    if (
      before.node.type !== entry.node.type ||
      JSON.stringify(before.node.props ?? {}) !== JSON.stringify(entry.node.props ?? {}) ||
      JSON.stringify(before.node.editor ?? null) !== JSON.stringify(entry.node.editor ?? null)
    ) {
      summary.changed.push(describe(entry.node));
    }
    if (before.parentId !== entry.parentId || before.index !== entry.index) summary.moved.push(describe(entry.node));
  }
  for (const [id, entry] of now) {
    if (!then.has(id)) summary.removed.push(describe(entry.node));
  }
  return summary;
}

export function isEmptySummary(summary: BlockChangeSummary): boolean {
  return !summary.added.length && !summary.removed.length && !summary.changed.length && !summary.moved.length;
}
