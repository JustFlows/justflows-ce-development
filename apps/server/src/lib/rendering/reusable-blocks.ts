// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { reassignBlockIds, sanitizeBlockDocument } from "@justflows/blocks";
import { getSiteSetting, updateSiteSettingAtomically } from "../settings/site-settings.js";
import type { BlockNode } from "../runtime/types.js";
import { recordDocumentHistory } from "./document-history.js";

/**
 * Reusable blocks (synced content): one saved tree that every `core.reusable`
 * reference renders, resolved at render time.
 *
 * Since justflows-ce#304 an entry has a published tree (`blocks`, what every
 * page renders) and an optional draft. Editing a reusable block in the
 * builder writes the draft; only an explicit publish changes the pages that
 * use it. Previews render the draft. Every save is recorded in the document
 * history, and nesting is checked when saving so a reference cycle or an
 * over-deep chain is refused with a reason instead of rendering nothing.
 */

const KEY = "reusable_blocks";
const MAX_ITEMS = 200;
const MAX_NAME = 120;
/** How deep reusable blocks may reference other reusable blocks. */
export const MAX_REUSABLE_NESTING = 4;

export interface ReusableDraft {
  name: string;
  blocks: BlockNode[];
  updatedAt: string;
}

export interface ReusableBlock {
  id: string;
  name: string;
  /** The published tree. Stored sanitized, so inserting one needs no second pass. */
  blocks: BlockNode[];
  updatedAt: string;
  /** Increases on every publish; the draft builds on this one. */
  revision: number;
  /** Unpublished changes, shown in previews and the editor only. */
  draft?: ReusableDraft;
}

export class ReusableSaveError extends Error {
  constructor(
    message: string,
    readonly code: "cycle" | "too_deep" | "invalid" | "limit" | "revision_conflict" | "not_found",
  ) {
    super(message);
  }
}

function asName(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f<>]/g, " ").trim() : "";
  return (name || fallback).slice(0, MAX_NAME);
}

export function asReusableId(raw: unknown): string {
  const id = typeof raw === "string" ? raw : "";
  /** Ids appear in block props and are matched on read; keep them boring. */
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

function sanitizedBlocks(raw: unknown): BlockNode[] {
  return sanitizeBlockDocument({ version: 1, blocks: raw }).blocks as BlockNode[];
}

function normalize(raw: unknown): ReusableBlock | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = asReusableId(item.id);
  if (!id) return null;
  const name = asName(item.name, id);
  const out: ReusableBlock = {
    id,
    name,
    blocks: sanitizedBlocks(item.blocks),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
    revision: typeof item.revision === "number" && Number.isInteger(item.revision) && item.revision > 0 ? item.revision : 1,
  };
  const draft = item.draft as Record<string, unknown> | undefined;
  if (draft && typeof draft === "object" && Array.isArray(draft.blocks)) {
    out.draft = {
      name: asName(draft.name, name),
      blocks: sanitizedBlocks(draft.blocks),
      updatedAt: typeof draft.updatedAt === "string" ? draft.updatedAt : out.updatedAt,
    };
  }
  return out;
}

function normalizeList(stored: unknown): ReusableBlock[] {
  return Array.isArray(stored) ? stored.map(normalize).filter((item): item is ReusableBlock => item !== null) : [];
}

export async function listReusableBlocks(siteId: string): Promise<ReusableBlock[]> {
  return normalizeList(await getSiteSetting<unknown[]>(siteId, KEY));
}

export async function getReusableBlock(siteId: string, id: string): Promise<ReusableBlock | null> {
  const list = await listReusableBlocks(siteId);
  return list.find((item) => item.id === id) ?? null;
}

/** Ids of the reusable blocks a tree references directly. */
export function referencedReusableIds(blocks: BlockNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: BlockNode[]) => {
    for (const block of list) {
      if (block.type === "core.reusable") {
        const ref = asReusableId((block.props as Record<string, unknown> | undefined)?.["ref"]);
        if (ref) out.add(ref);
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

/**
 * Why a tree may not be saved as reusable block `id`: it would reference
 * itself through any chain (`cycle`), or reference chains deeper than
 * `MAX_REUSABLE_NESTING` (`too_deep`). Both the published and draft trees of
 * other entries count, since either may be published next.
 */
export function reusableNestingProblem(
  id: string,
  blocks: BlockNode[],
  library: Map<string, ReusableBlock>,
): "cycle" | "too_deep" | null {
  const treeOf = (entry: ReusableBlock) => [...entry.blocks, ...(entry.draft?.blocks ?? [])];
  const visit = (refs: Set<string>, depth: number, stack: Set<string>): "cycle" | "too_deep" | null => {
    for (const ref of refs) {
      if (ref === id || stack.has(ref)) return "cycle";
      if (depth >= MAX_REUSABLE_NESTING) return "too_deep";
      const entry = library.get(ref);
      if (!entry) continue;
      const problem = visit(referencedReusableIds(treeOf(entry)), depth + 1, new Set([...stack, ref]));
      if (problem) return problem;
    }
    return null;
  };
  return visit(referencedReusableIds(blocks), 1, new Set([id]));
}

export interface SaveReusableOptions {
  /** Write the draft instead of publishing. A new entry is always published. */
  draft?: boolean;
  /** The revision the editor started from; a different one is a conflict. */
  expectedRevision?: number;
  actorId?: string | null;
}

/**
 * Create or update one entry. Without `draft`, the tree is published at once
 * (the library's original behaviour, kept for older clients and the API).
 * With `draft`, an existing entry keeps rendering its published tree.
 */
export async function saveReusableBlock(
  siteId: string,
  input: { id?: string; name?: string; blocks: unknown },
  opts: SaveReusableOptions = {},
): Promise<ReusableBlock> {
  const id = asReusableId(input.id) || randomUUID();
  const blocks = sanitizedBlocks(input.blocks);
  const now = new Date().toISOString();
  let saved: ReusableBlock | null = null;

  /** Atomic so two editors saving different blocks at once never drop each other's (justflows-ce#302). */
  await updateSiteSettingAtomically<unknown[]>(siteId, KEY, (stored) => {
    const list = normalizeList(stored);
    const current = list.find((item) => item.id === id) ?? null;
    if (opts.expectedRevision !== undefined && (current?.revision ?? 0) !== opts.expectedRevision) {
      throw new ReusableSaveError("This reusable block was published by someone else since you opened it", "revision_conflict");
    }
    const library = new Map(list.map((item) => [item.id, item]));
    const problem = reusableNestingProblem(id, blocks, library);
    if (problem === "cycle") throw new ReusableSaveError("A reusable block cannot contain itself, directly or through another reusable block", "cycle");
    if (problem === "too_deep") {
      throw new ReusableSaveError(`Reusable blocks can be nested at most ${MAX_REUSABLE_NESTING} deep`, "too_deep");
    }
    const without = list.filter((item) => item.id !== id);
    if (!current && without.length >= MAX_ITEMS) {
      throw new ReusableSaveError(`A site may hold at most ${MAX_ITEMS} reusable blocks`, "limit");
    }
    const name = asName(input.name, current?.name ?? id);
    if (current && opts.draft) {
      saved = { ...current, draft: { name, blocks, updatedAt: now } };
    } else {
      saved = { id, name, blocks, updatedAt: now, revision: current ? current.revision + 1 : 1 };
    }
    return [saved, ...without];
  });
  const entry = saved as unknown as ReusableBlock;
  await recordDocumentHistory({
    siteId,
    kind: "reusable_block",
    key: entry.id,
    revision: entry.revision,
    state: entry.draft && opts.draft ? "draft" : "published",
    doc: { version: 1, name: entry.draft && opts.draft ? entry.draft.name : entry.name, blocks: entry.draft && opts.draft ? entry.draft.blocks : entry.blocks },
    actorId: opts.actorId ?? null,
  });
  return entry;
}

/** Publish an entry's draft: every page using it changes. Returns the entry, or null when it has no draft. */
export async function publishReusableDraft(
  siteId: string,
  id: string,
  opts: { expectedRevision?: number; actorId?: string | null } = {},
): Promise<ReusableBlock | null> {
  const current = await getReusableBlock(siteId, id);
  if (!current) throw new ReusableSaveError("Reusable block not found", "not_found");
  if (!current.draft) return null;
  return saveReusableBlock(
    siteId,
    { id, name: current.draft.name, blocks: current.draft.blocks },
    { expectedRevision: opts.expectedRevision ?? current.revision, actorId: opts.actorId },
  );
}

export async function discardReusableDraft(siteId: string, id: string): Promise<void> {
  await updateSiteSettingAtomically<unknown[]>(siteId, KEY, (stored) =>
    normalizeList(stored).map((item) => {
      if (item.id !== id) return item;
      const { draft: _draft, ...rest } = item;
      return rest;
    }),
  );
}

/** Rename without touching the tree or the draft; a name is never rendered. */
export async function renameReusableBlock(siteId: string, id: string, name: string): Promise<ReusableBlock> {
  let renamed: ReusableBlock | null = null;
  await updateSiteSettingAtomically<unknown[]>(siteId, KEY, (stored) =>
    normalizeList(stored).map((item) => {
      if (item.id !== id) return item;
      renamed = { ...item, name: asName(name, item.name), ...(item.draft ? { draft: { ...item.draft, name: asName(name, item.name) } } : {}) };
      return renamed;
    }),
  );
  if (!renamed) throw new ReusableSaveError("Reusable block not found", "not_found");
  return renamed;
}

/** A new, independent entry with the same content and fresh block ids. */
export async function duplicateReusableBlock(siteId: string, id: string, name: string): Promise<ReusableBlock> {
  const source = await getReusableBlock(siteId, id);
  if (!source) throw new ReusableSaveError("Reusable block not found", "not_found");
  const blocks = reassignBlockIds(source.draft?.blocks ?? source.blocks, () => randomUUID());
  return saveReusableBlock(siteId, { name: asName(name, `${source.name} (copy)`), blocks });
}

export async function deleteReusableBlock(siteId: string, id: string): Promise<void> {
  await updateSiteSettingAtomically<unknown[]>(siteId, KEY, (stored) =>
    (Array.isArray(stored) ? stored : []).filter(
      (item) => !(item && typeof item === "object" && (item as { id?: unknown }).id === id),
    ),
  );
}

/**
 * Replace every `core.reusable` placeholder with the tree it points at.
 *
 * Resolved at render rather than copied on insert: that is the whole point of
 * a reusable block, editing the original updates every page using it.
 * References nest at most `MAX_REUSABLE_NESTING` deep and never through an
 * entry already being expanded, so a cycle stored before the save-time check
 * existed renders the outer copy once instead of spinning. Ordinary child
 * nesting does not count towards that limit. A reference to a deleted entry
 * renders nothing. `preview` renders drafts.
 */
export function resolveReusableBlocks(
  blocks: BlockNode[],
  library: Map<string, ReusableBlock>,
  depth = 0,
  opts: { preview?: boolean; stack?: ReadonlySet<string> } = {},
): BlockNode[] {
  const stack = opts.stack ?? new Set<string>();
  const out: BlockNode[] = [];
  for (const block of blocks) {
    if (block.type === "core.reusable") {
      const ref = asReusableId((block.props as Record<string, unknown> | undefined)?.["ref"]);
      const entry = ref ? library.get(ref) : undefined;
      if (entry && depth < MAX_REUSABLE_NESTING && !stack.has(ref)) {
        const tree = opts.preview && entry.draft ? entry.draft.blocks : entry.blocks;
        out.push(...resolveReusableBlocks(tree, library, depth + 1, { ...opts, stack: new Set([...stack, ref]) }));
      }
      continue;
    }
    out.push(
      block.children?.length
        ? { ...block, children: resolveReusableBlocks(block.children, library, depth, { ...opts, stack }) }
        : block,
    );
  }
  return out;
}
