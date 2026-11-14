// SPDX-License-Identifier: MIT

import { EDITOR_LOCK_FLAGS, type EditorLockFlag } from "./document-contract.js";

/**
 * Block locks as policy (justflows-ce#298). A node's `editor.lock` flags say
 * what an author without the lock-management capability may not do to it:
 *
 * - `move`: it keeps its parent, and its order relative to other move-locked
 *   siblings. Unlocked siblings may be inserted, removed, or reordered around
 *   it; a diff cannot tell "moved the locked block" from "moved its
 *   neighbours", so the editor additionally refuses moving it directly.
 * - `remove`: it stays in the document (deleting an ancestor counts).
 * - `edit`: its type and props stay as they are. Children are their own nodes.
 *
 * Adding, changing, or removing the flags of an existing node is a `lock`
 * violation. New nodes may arrive with locks (a pattern can ship them).
 *
 * The editor applies the same rules so a locked action is disabled with a
 * reason; the server applies them on save so the policy holds for every client.
 */

export type BlockLockRule = EditorLockFlag | "lock";

export interface BlockLockViolation {
  id: string;
  type: string;
  rule: BlockLockRule;
}

interface LockNode {
  id?: unknown;
  type?: unknown;
  props?: unknown;
  children?: unknown;
  editor?: unknown;
}

interface Placed {
  node: LockNode;
  parentId: string | null;
  /** Sibling ids under the same parent, in order. */
  siblings: string[];
}

function asNodes(value: unknown): LockNode[] {
  return Array.isArray(value) ? (value.filter((n) => n && typeof n === "object") as LockNode[]) : [];
}

function index(blocks: unknown): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const walk = (list: LockNode[], parentId: string | null) => {
    const siblings = list.map((n) => (typeof n.id === "string" ? n.id : "")).filter(Boolean);
    for (const node of list) {
      if (typeof node.id === "string" && !out.has(node.id)) out.set(node.id, { node, parentId, siblings });
      walk(asNodes(node.children), typeof node.id === "string" ? node.id : null);
    }
  };
  walk(asNodes(blocks), null);
  return out;
}

/** The lock flags a stored node carries. */
export function blockLockFlags(node: { editor?: unknown } | null | undefined): Set<EditorLockFlag> {
  const lock = (node?.editor as { lock?: unknown } | undefined)?.lock;
  const out = new Set<EditorLockFlag>();
  if (!lock || typeof lock !== "object") return out;
  for (const flag of EDITOR_LOCK_FLAGS) if ((lock as Record<string, unknown>)[flag] === true) out.add(flag);
  return out;
}

export function isBlockLocked(node: { editor?: unknown } | null | undefined, flag: EditorLockFlag): boolean {
  return blockLockFlags(node).has(flag);
}

/** Key-order independent JSON, so a re-serialized but unchanged prop object compares equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameFlags(a: Set<EditorLockFlag>, b: Set<EditorLockFlag>): boolean {
  return a.size === b.size && [...a].every((flag) => b.has(flag));
}

/**
 * Every lock that `after` breaks relative to `before`. Both are block lists in
 * the stored shape; pass them through `sanitizeBlockDocument` first so the
 * comparison sees what would be stored.
 */
export function blockLockViolations(before: unknown, after: unknown): BlockLockViolation[] {
  const was = index(before);
  const now = index(after);
  const out: BlockLockViolation[] = [];
  for (const [id, prior] of was) {
    const flags = blockLockFlags(prior.node);
    const current = now.get(id);
    const type = typeof prior.node.type === "string" ? prior.node.type : "";
    if (current && !sameFlags(flags, blockLockFlags(current.node))) out.push({ id, type, rule: "lock" });
    if (flags.size === 0) continue;
    if (!current) {
      if (flags.has("remove")) out.push({ id, type, rule: "remove" });
      continue;
    }
    if (flags.has("edit") && (current.node.type !== prior.node.type || stable(current.node.props) !== stable(prior.node.props))) {
      out.push({ id, type, rule: "edit" });
    }
    if (flags.has("move")) {
      if (current.parentId !== prior.parentId) {
        out.push({ id, type, rule: "move" });
        continue;
      }
      /** Order among the move-locked siblings both versions share. */
      const pinned = (s: string) => current.siblings.includes(s) && isBlockLocked(was.get(s)?.node, "move");
      const beforeOrder = prior.siblings.filter(pinned);
      const afterOrder = current.siblings.filter((s) => beforeOrder.includes(s));
      if (beforeOrder.indexOf(id) !== afterOrder.indexOf(id)) out.push({ id, type, rule: "move" });
    }
  }
  return out;
}
