// SPDX-License-Identifier: MIT
import { canNestBlock, isBlockLocked } from "@justflows/blocks";
import { findBlockPath, getBlockAtPath, insertBlock, removeBlock, updateBlockTree } from "./block-tree";
import type { BlockCatalogEntry, BlockNode } from "./types";

/**
 * Common editing operations (justflows-ce#298): selection, duplicate, delete,
 * group, ungroup, reset style, and paste. Every function here is pure and
 * returns the next block list; the builder applies it as one change, so each
 * operation is one undo step however many blocks it touches.
 */

/** Blocks that only wrap their children, so "ungroup" can dissolve them safely. */
export const UNGROUPABLE_TYPES: ReadonlySet<string> = new Set(["core.group", "core.container"]);
/** What "group" wraps a selection in. */
export const GROUP_TYPE = "core.group";
/** Props that "reset style" clears: generic presentation, never content. */
export const STYLE_PROPS = ["style", "breakpoints", "styleRef"] as const;

/** Selected blocks that share one parent, in document order. */
export interface SiblingSet {
  parentId: string | null;
  parentType: string | null;
  /** Ids in document order. */
  ids: string[];
  /** Index of each id among its siblings, ascending. */
  indices: number[];
  nodes: BlockNode[];
}

/** The selection as siblings of one parent, or null when it spans parents or a block is missing. */
export function siblingSet(blocks: BlockNode[], ids: readonly string[]): SiblingSet | null {
  if (ids.length === 0) return null;
  let parentPath: string | null = null;
  const placed: { index: number; node: BlockNode }[] = [];
  let parent: BlockNode | null = null;
  for (const id of ids) {
    const path = findBlockPath(blocks, id);
    if (!path) return null;
    const key = path.slice(0, -1).join(".");
    if (parentPath === null) {
      parentPath = key;
      parent = path.length > 1 ? getBlockAtPath(blocks, path.slice(0, -1)) : null;
    } else if (key !== parentPath) {
      return null;
    }
    placed.push({ index: path[path.length - 1]!, node: getBlockAtPath(blocks, path)! });
  }
  placed.sort((a, b) => a.index - b.index);
  return {
    parentId: parent?.id ?? null,
    parentType: parent?.type ?? null,
    ids: placed.map((p) => p.node.id),
    indices: placed.map((p) => p.index),
    nodes: placed.map((p) => p.node),
  };
}

export type SelectionRefusal = "parent" | "context";

export interface SelectionResult {
  ids: string[];
  anchor: string | null;
  refused?: SelectionRefusal;
}

/**
 * Add to or extend a selection. Multi-select only spans siblings of one
 * parent in one region: anything else is refused with a reason rather than
 * silently mixing contexts.
 *
 * - `toggle` (Ctrl/Cmd+click): add or remove one block.
 * - `range` (Shift+click): every sibling between the anchor and the block.
 */
export function extendSelection(
  blocks: BlockNode[],
  current: readonly string[],
  anchor: string | null,
  id: string,
  mode: "toggle" | "range",
): SelectionResult {
  const keep: SelectionResult = { ids: [...current], anchor };
  if (!findBlockPath(blocks, id)) return { ...keep, refused: "context" };
  const inRegion = current.filter((c) => findBlockPath(blocks, c));
  if (inRegion.length !== current.length) return { ...keep, refused: "context" };
  if (current.length === 0) return { ids: [id], anchor: id };

  if (mode === "toggle") {
    if (current.includes(id)) {
      const ids = current.filter((c) => c !== id);
      return { ids, anchor: anchor === id ? (ids[ids.length - 1] ?? null) : anchor };
    }
    if (!siblingSet(blocks, [...current, id])) return { ...keep, refused: "parent" };
    return { ids: [...current, id], anchor: id };
  }

  const from = anchor && current.includes(anchor) ? anchor : current[current.length - 1]!;
  const pair = siblingSet(blocks, [from, id]);
  if (!pair) return { ...keep, refused: "parent" };
  const path = findBlockPath(blocks, id)!;
  const siblings = path.length > 1 ? (getBlockAtPath(blocks, path.slice(0, -1))?.children ?? []) : blocks;
  const [lo, hi] = [pair.indices[0]!, pair.indices[pair.indices.length - 1]!];
  return { ids: siblings.slice(lo, hi + 1).map((n) => n.id), anchor: from };
}

/** Every node in these subtrees, depth first. */
function eachNode(nodes: BlockNode[], fn: (node: BlockNode) => void): void {
  for (const node of nodes) {
    fn(node);
    if (node.children?.length) eachNode(node.children, fn);
  }
}

/** A copy with fresh ids and no locks: a copy is a new block owned by whoever made it. */
export function freshCopy(nodes: BlockNode[], makeId: () => string): BlockNode[] {
  return nodes.map((node) => {
    const next: BlockNode = { ...node, id: makeId(), props: { ...node.props } };
    if (node.editor) {
      const { lock: _lock, ...rest } = node.editor;
      if (Object.keys(rest).length > 0) next.editor = rest;
      else delete next.editor;
    }
    if (node.children) next.children = freshCopy(node.children, makeId);
    return next;
  });
}

export function insertBlocksAt(blocks: BlockNode[], parentId: string | null, index: number, nodes: BlockNode[]): BlockNode[] {
  return nodes.reduce((acc, node, i) => insertBlock(acc, parentId, index + i, node), blocks);
}

/** Copies of the selection right after its last block. */
export function duplicateBlocks(
  blocks: BlockNode[],
  ids: readonly string[],
  makeId: () => string,
): { blocks: BlockNode[]; ids: string[] } | null {
  const set = siblingSet(blocks, ids);
  if (!set) return null;
  const copies = freshCopy(set.nodes, makeId);
  const at = set.indices[set.indices.length - 1]! + 1;
  return { blocks: insertBlocksAt(blocks, set.parentId, at, copies), ids: copies.map((c) => c.id) };
}

export function removeBlocks(blocks: BlockNode[], ids: readonly string[]): BlockNode[] {
  return ids.reduce((acc, id) => removeBlock(acc, id), blocks);
}

/** Wrap the selection in a new group at the place of its first block. */
export function groupBlocks(
  blocks: BlockNode[],
  ids: readonly string[],
  makeId: () => string,
): { blocks: BlockNode[]; id: string } | null {
  const set = siblingSet(blocks, ids);
  if (!set) return null;
  const group: BlockNode = { id: makeId(), type: GROUP_TYPE, version: 1, props: {}, children: set.nodes };
  const without = removeBlocks(blocks, set.ids);
  return { blocks: insertBlock(without, set.parentId, set.indices[0]!, group), id: group.id };
}

/** Replace a wrapper with its children, in place. */
export function ungroupBlock(blocks: BlockNode[], id: string): { blocks: BlockNode[]; ids: string[] } | null {
  const set = siblingSet(blocks, [id]);
  if (!set) return null;
  const children = set.nodes[0]!.children ?? [];
  const without = removeBlock(blocks, id);
  return { blocks: insertBlocksAt(without, set.parentId, set.indices[0]!, children), ids: children.map((c) => c.id) };
}

/**
 * Whether a prop holds generic presentation. A block schema may own `style`
 * as a scalar variant (a select); that is content and is never reset.
 */
function isStyleValue(key: (typeof STYLE_PROPS)[number], value: unknown): boolean {
  if (key === "styleRef") return typeof value === "string" && value !== "";
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resetBlockStyles(blocks: BlockNode[], ids: readonly string[]): BlockNode[] {
  return ids.reduce(
    (acc, id) =>
      updateBlockTree(acc, id, (node) => {
        const props = { ...node.props };
        for (const key of STYLE_PROPS) if (isStyleValue(key, props[key])) delete props[key];
        return { ...node, props };
      }),
    blocks,
  );
}

function hasStyle(node: BlockNode): boolean {
  return STYLE_PROPS.some((key) => isStyleValue(key, node.props[key]));
}

/** Lookup for the shared nesting rule. */
export function nestingLookup(catalog: Map<string, BlockCatalogEntry>) {
  return (type: string) => catalog.get(type);
}

/**
 * Where pasted blocks go: right after the selection when its parent accepts
 * them all, else at the end of the selected container, else the region end.
 * Null when no place accepts every pasted block.
 */
export function pasteTarget(
  blocks: BlockNode[],
  selection: readonly string[],
  nodes: BlockNode[],
  catalog: Map<string, BlockCatalogEntry>,
  rootParentType: string | null = null,
): { parentId: string | null; index: number } | null {
  const lookup = nestingLookup(catalog);
  const fits = (parentType: string | null) => nodes.every((n) => canNestBlock(parentType, n.type, lookup));
  const set = siblingSet(blocks, selection);
  if (set) {
    if (fits(set.parentType ?? rootParentType)) return { parentId: set.parentId, index: set.indices[set.indices.length - 1]! + 1 };
    if (set.nodes.length === 1) {
      const container = set.nodes[0]!;
      if (fits(container.type)) return { parentId: container.id, index: (container.children ?? []).length };
    }
  }
  if (fits(rootParentType)) return { parentId: null, index: blocks.length };
  return null;
}

/** The operations offered for a selection. */
export const BLOCK_ACTIONS = [
  "duplicate",
  "copy",
  "cut",
  "paste",
  "delete",
  "group",
  "ungroup",
  "resetStyle",
  "saveReusable",
  "savePattern",
] as const;
export type BlockAction = (typeof BLOCK_ACTIONS)[number];

/** Why an operation is unavailable; each has an explanation in the admin catalogs. */
export type ActionBlocker =
  | "empty"
  | "mixedParents"
  | "lockedRemove"
  | "lockedMove"
  | "lockedEdit"
  | "nesting"
  | "notGroup"
  | "noStyle"
  | "clipboardEmpty"
  | "permission"
  | "unsupported";

export type ActionState = { ok: true } | { ok: false; reason: ActionBlocker };

export interface ActionContext {
  blocks: BlockNode[];
  selection: readonly string[];
  catalog: Map<string, BlockCatalogEntry>;
  /** Parent type of the region root (`null` for a page, a slot type for the header). */
  rootParentType?: string | null;
  /** Whether something is waiting to be pasted. */
  hasClipboard: boolean;
  /** The actor may save to the reusable block and pattern libraries. */
  canSaveLibrary: boolean;
  /** This surface offers saving to the libraries at all. */
  librarySaves: boolean;
}

const OK: ActionState = { ok: true };
const no = (reason: ActionBlocker): ActionState => ({ ok: false, reason });

/**
 * What each operation would do to this selection, and if not, why. The menu
 * and the keyboard shortcuts both ask this, so a disabled item and a refused
 * shortcut always give the same reason.
 */
export function actionStates(ctx: ActionContext): Record<BlockAction, ActionState> {
  const { blocks, selection, catalog } = ctx;
  const lookup = nestingLookup(catalog);
  const set = siblingSet(blocks, selection);
  const out = {} as Record<BlockAction, ActionState>;
  const base: ActionState = selection.length === 0 ? no("empty") : !set ? no("mixedParents") : OK;
  for (const action of BLOCK_ACTIONS) out[action] = base;
  out.paste = ctx.hasClipboard ? OK : no("clipboardEmpty");
  if (!set) return out;

  const subtree: BlockNode[] = [];
  eachNode(set.nodes, (n) => subtree.push(n));
  const removeLocked = subtree.some((n) => isBlockLocked(n, "remove"));
  const moveLocked = set.nodes.some((n) => isBlockLocked(n, "move"));
  const parentType = set.parentType ?? ctx.rootParentType ?? null;

  if (removeLocked) {
    out.delete = no("lockedRemove");
    out.cut = no("lockedRemove");
  }

  if (moveLocked) out.group = no("lockedMove");
  else if (
    !canNestBlock(parentType, GROUP_TYPE, lookup) ||
    !set.nodes.every((n) => canNestBlock(GROUP_TYPE, n.type, lookup))
  ) {
    out.group = no("nesting");
  }

  const only = set.nodes.length === 1 ? set.nodes[0]! : null;
  if (!only || !UNGROUPABLE_TYPES.has(only.type)) out.ungroup = no("notGroup");
  else if (isBlockLocked(only, "remove")) out.ungroup = no("lockedRemove");
  else if ((only.children ?? []).some((c) => isBlockLocked(c, "move"))) out.ungroup = no("lockedMove");
  else if (!(only.children ?? []).every((c) => canNestBlock(parentType, c.type, lookup))) out.ungroup = no("nesting");

  if (set.nodes.some((n) => isBlockLocked(n, "edit"))) out.resetStyle = no("lockedEdit");
  else if (!set.nodes.some(hasStyle)) out.resetStyle = no("noStyle");

  if (!set.nodes.every((n) => canNestBlock(parentType, n.type, lookup))) out.duplicate = no("nesting");

  const library: ActionState = !ctx.librarySaves ? no("unsupported") : !ctx.canSaveLibrary ? no("permission") : OK;
  /** Saving as a reusable block replaces the selection with a reference, which removes the originals. */
  out.saveReusable = library.ok && removeLocked ? no("lockedRemove") : library;
  out.savePattern = library;
  return out;
}
