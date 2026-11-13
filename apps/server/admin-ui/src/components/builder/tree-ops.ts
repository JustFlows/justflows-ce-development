// SPDX-License-Identifier: MIT
import { findBlockPath, getBlockAtPath, moveBlockTo } from "./block-tree";
import { evaluateDrop, type DropRegion, type DropRejection } from "./drop-rules";
import type { BlockCatalogEntry, BlockNode } from "./types";

/** Keyboard structural moves from the navigator (justflows-ce#296). */
export type TreeMove = "up" | "down" | "indent" | "outdent";

export type TreeMoveResult =
  | { ok: true; blocks: BlockNode[]; parentId: string | null; index: number }
  | { ok: false; reason: DropRejection | "edge"; parentType?: string | null };

interface Located {
  node: BlockNode;
  parentId: string | null;
  parentType: string | null;
  siblings: BlockNode[];
  index: number;
}

function locate(blocks: BlockNode[], id: string): Located | null {
  const path = findBlockPath(blocks, id);
  if (!path) return null;
  const node = getBlockAtPath(blocks, path);
  if (!node) return null;
  const parent = path.length > 1 ? getBlockAtPath(blocks, path.slice(0, -1)) : null;
  return {
    node,
    parentId: parent?.id ?? null,
    parentType: parent?.type ?? null,
    siblings: parent ? (parent.children ?? []) : blocks,
    index: path[path.length - 1]!,
  };
}

/**
 * Compute a keyboard move without touching the input. Every destination is
 * checked with the same rules as a canvas drop, so the keyboard can never do
 * what dragging could not.
 *
 * - `up` / `down`: swap with the previous or next sibling.
 * - `indent`: become the last child of the previous sibling.
 * - `outdent`: leave the parent and sit right after it.
 */
export function planTreeMove(
  blocks: BlockNode[],
  id: string,
  move: TreeMove,
  catalog: Map<string, BlockCatalogEntry>,
): TreeMoveResult {
  const at = locate(blocks, id);
  if (!at) return { ok: false, reason: "missing" };
  /** `index` is the slot passed to moveBlockTo; `finalIndex` is where the block ends up. */
  const check = (parentId: string | null, parentType: string | null, index: number, finalIndex = index): TreeMoveResult => {
    const verdict = evaluateDrop({
      source: { type: at.node.type, blockId: id },
      target: { region: "body", parentId, parentType, index },
      blocks,
      headerBlocks: [],
      catalog,
      regions: new Set<DropRegion>(["body"]),
    });
    if (!verdict.ok) return { ...verdict, parentType };
    return { ok: true, blocks: moveBlockTo(blocks, id, parentId, index), parentId, index: finalIndex };
  };

  if (move === "up") {
    if (at.index === 0) return { ok: false, reason: "edge" };
    return check(at.parentId, at.parentType, at.index - 1);
  }
  if (move === "down") {
    if (at.index >= at.siblings.length - 1) return { ok: false, reason: "edge" };
    /** moveBlockTo counts the slot after the removal, so skipping one sibling needs index + 2. */
    return check(at.parentId, at.parentType, at.index + 2, at.index + 1);
  }
  if (move === "indent") {
    const previous = at.siblings[at.index - 1];
    if (!previous) return { ok: false, reason: "edge" };
    return check(previous.id, previous.type, (previous.children ?? []).length);
  }
  if (!at.parentId) return { ok: false, reason: "edge" };
  const parent = locate(blocks, at.parentId);
  if (!parent) return { ok: false, reason: "missing" };
  return check(parent.parentId, parent.parentType, parent.index + 1);
}

/** A container a block could move into, for the "Move to…" chooser. */
export interface MoveDestination {
  parentId: string | null;
  parentType: string | null;
  depth: number;
}

/**
 * Every container (and the region root) the block may move into as its last
 * child, in document order. The block's own subtree is never offered.
 */
export function moveDestinations(
  blocks: BlockNode[],
  id: string,
  catalog: Map<string, BlockCatalogEntry>,
): MoveDestination[] {
  const at = locate(blocks, id);
  if (!at) return [];
  const out: MoveDestination[] = [];
  const ok = (parentId: string | null, parentType: string | null, index: number) =>
    evaluateDrop({
      source: { type: at.node.type, blockId: id },
      target: { region: "body", parentId, parentType, index },
      blocks,
      headerBlocks: [],
      catalog,
      regions: new Set<DropRegion>(["body"]),
    }).ok;
  if (ok(null, null, blocks.length) && at.parentId !== null) out.push({ parentId: null, parentType: null, depth: 0 });
  const walk = (list: BlockNode[], depth: number) => {
    for (const node of list) {
      if (node.id === id) continue;
      if (node.id !== at.parentId && ok(node.id, node.type, (node.children ?? []).length)) {
        out.push({ parentId: node.id, parentType: node.type, depth: depth + 1 });
      }
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out;
}

/** One visible row of the navigator. */
export interface TreeRow {
  node: BlockNode;
  depth: number;
  /** 1-based position among siblings and the sibling count, for aria-posinset/setsize. */
  position: number;
  setSize: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  /** True when this row matched the search (ancestors shown only for context are false). */
  match: boolean;
}

const TEXT_PROPS = ["text", "title", "heading", "label", "caption", "alt", "buttonLabel", "name"] as const;

/** Plain text a block shows, for search: its text-like props with markup removed. */
export function blockSearchText(node: BlockNode): string {
  const parts: string[] = [];
  for (const key of TEXT_PROPS) {
    const value = node.props?.[key];
    if (typeof value === "string") parts.push(value.replace(/<[^>]*>/g, " "));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Flatten the document into visible rows. Collapsed branches are skipped. With
 * a query, only matching rows and their ancestors are shown, expanded, so a
 * match inside a collapsed branch is still revealed.
 */
export function flattenTree(
  blocks: BlockNode[],
  expanded: ReadonlySet<string>,
  query: string,
  label: (node: BlockNode) => string,
): TreeRow[] {
  const q = query.trim().toLowerCase();
  const matches = new Set<string>();
  const keep = new Set<string>();
  if (q) {
    const visit = (list: BlockNode[], ancestors: string[]): void => {
      for (const node of list) {
        const haystack = `${label(node)} ${node.type} ${node.editor?.label ?? ""} ${blockSearchText(node)}`.toLowerCase();
        if (haystack.includes(q)) {
          matches.add(node.id);
          keep.add(node.id);
          for (const id of ancestors) keep.add(id);
        }
        if (node.children?.length) visit(node.children, [...ancestors, node.id]);
      }
    };
    visit(blocks, []);
  }

  const rows: TreeRow[] = [];
  const walk = (list: BlockNode[], depth: number, parentId: string | null) => {
    const shown = q ? list.filter((node) => keep.has(node.id)) : list;
    shown.forEach((node, i) => {
      const hasChildren = Boolean(node.children?.length);
      const isOpen = hasChildren && (q ? true : expanded.has(node.id));
      rows.push({
        node,
        depth,
        position: i + 1,
        setSize: shown.length,
        parentId,
        hasChildren,
        expanded: isOpen,
        match: q ? matches.has(node.id) : false,
      });
      if (isOpen) walk(node.children!, depth + 1, node.id);
    });
  };
  walk(blocks, 1, null);
  return rows;
}

/** Ids of every ancestor of `id`, outermost first, so the navigator can reveal it. */
export function ancestorIds(blocks: BlockNode[], id: string): string[] {
  const path = findBlockPath(blocks, id);
  if (!path) return [];
  const out: string[] = [];
  for (let depth = 1; depth < path.length; depth++) {
    const node = getBlockAtPath(blocks, path.slice(0, depth));
    if (node) out.push(node.id);
  }
  return out;
}

/** Badges for a row: what an author should know about a block at a glance. */
export type TreeBadge = "reusable" | "hidden" | "locked" | "unavailable" | "dynamic";

export function treeBadges(node: BlockNode, catalog: Map<string, BlockCatalogEntry>): TreeBadge[] {
  const out: TreeBadge[] = [];
  if (node.type === "core.reusable") out.push("reusable");
  if (Array.isArray(node.props?.devices) && (node.props.devices as unknown[]).length > 0) out.push("hidden");
  if (node.editor?.lock && Object.keys(node.editor.lock).length > 0) out.push("locked");
  if (!catalog.has(node.type)) out.push("unavailable");
  else if (node.type.startsWith("core.post-") || catalog.get(node.type)?.category === "dynamic") out.push("dynamic");
  return out;
}

/** A drop zone that closes a sibling list: "at the end of this parent". */
export interface EndZone {
  parentId: string | null;
  index: number;
  depth: number;
}

/**
 * For each row index, the end-of-list drop zones that follow it. A row whose
 * children are shown has none (its children follow); otherwise every level
 * that ends after this row gets a zone, innermost first.
 */
export function endZonesAfter(rows: TreeRow[]): Map<number, EndZone[]> {
  const out = new Map<number, EndZone[]>();
  const lastAt: TreeRow[] = [];
  rows.forEach((row, i) => {
    lastAt[row.depth] = row;
    if (row.expanded && row.hasChildren) return;
    const nextDepth = rows[i + 1]?.depth ?? 0;
    const zones: EndZone[] = [];
    for (let depth = row.depth; depth > nextDepth; depth--) {
      const last = lastAt[depth];
      if (last) zones.push({ parentId: last.parentId, index: last.setSize, depth });
    }
    if (zones.length) out.set(i, zones);
  });
  return out;
}
