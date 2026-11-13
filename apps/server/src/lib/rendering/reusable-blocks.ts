// SPDX-License-Identifier: MIT

import { sanitizeBlockDocument } from "@justflows/blocks";
import { getSiteSetting, updateSiteSettingAtomically } from "../settings/site-settings.js";
import type { BlockNode } from "../runtime/types.js";

const KEY = "reusable_blocks";
const MAX_ITEMS = 200;
const MAX_NAME = 120;

export interface ReusableBlock {
  id: string;
  name: string;
  /** The saved tree. Stored sanitized, so inserting one needs no second pass. */
  blocks: BlockNode[];
  updatedAt: string;
}

function asName(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  return (name || fallback).slice(0, MAX_NAME);
}

function asId(raw: unknown): string {
  const id = typeof raw === "string" ? raw : "";
  // Ids appear in block props and are matched on read; keep them boring.
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

function normalize(raw: unknown): ReusableBlock | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = asId(item.id);
  if (!id) return null;
  const sanitized = sanitizeBlockDocument({ version: 1, blocks: item.blocks });
  return {
    id,
    name: asName(item.name, id),
    blocks: sanitized.blocks as BlockNode[],
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

export async function listReusableBlocks(siteId: string): Promise<ReusableBlock[]> {
  const stored = await getSiteSetting<unknown[]>(siteId, KEY);
  if (!Array.isArray(stored)) return [];
  return stored.map(normalize).filter((item): item is ReusableBlock => item !== null);
}

export async function getReusableBlock(siteId: string, id: string): Promise<ReusableBlock | null> {
  const list = await listReusableBlocks(siteId);
  return list.find((item) => item.id === id) ?? null;
}

/** Create or replace one entry. Returns the stored form, ids and all. */
export async function saveReusableBlock(
  siteId: string,
  input: { id?: string; name?: string; blocks: unknown },
): Promise<ReusableBlock> {
  const id = asId(input.id) || crypto.randomUUID();
  const entry = normalize({ id, name: input.name, blocks: input.blocks, updatedAt: new Date().toISOString() });
  if (!entry) throw new Error("Invalid reusable block");

  /** Atomic so two editors saving different blocks at once never drop each other's (justflows-ce#302). */
  await updateSiteSettingAtomically<unknown[]>(siteId, KEY, (stored) => {
    const list = Array.isArray(stored) ? stored.map(normalize).filter((item): item is ReusableBlock => item !== null) : [];
    const without = list.filter((item) => item.id !== id);
    if (without.length >= MAX_ITEMS) throw new Error(`A site may hold at most ${MAX_ITEMS} reusable blocks`);
    return [entry, ...without];
  });
  return entry;
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
 * Resolved at render rather than copied on insert — that is the whole point of
 * a reusable block: editing the original updates every page using it. Nesting
 * is bounded so one that references itself cannot spin.
 */
export function resolveReusableBlocks(
  blocks: BlockNode[],
  library: Map<string, ReusableBlock>,
  depth = 0,
): BlockNode[] {
  if (depth > 4) return [];
  const out: BlockNode[] = [];
  for (const block of blocks) {
    if (block.type === "core.reusable") {
      const ref = asId((block.props as Record<string, unknown> | undefined)?.["ref"]);
      const entry = ref ? library.get(ref) : undefined;
      if (entry) out.push(...resolveReusableBlocks(entry.blocks, library, depth + 1));
      continue;
    }
    out.push(
      block.children?.length
        ? { ...block, children: resolveReusableBlocks(block.children, library, depth + 1) }
        : block,
    );
  }
  return out;
}
