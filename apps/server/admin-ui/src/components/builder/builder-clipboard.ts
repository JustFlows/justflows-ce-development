// SPDX-License-Identifier: MIT
import { parseBlockClipboard, plainTextToBlocks, serializeBlockClipboard } from "@justflows/blocks";
import { uid } from "../../lib/uid";
import type { BlockNode } from "./types";

/**
 * The builder's side of the block clipboard (justflows-ce#298). Copies go to
 * the system clipboard when the browser allows it, so they paste into another
 * tab or document, and to an in-memory copy, which works where the system
 * clipboard is blocked (no permission, an insecure origin, a test runner).
 */

let memory: string | null = null;

export function writeBlockClipboard(blocks: BlockNode[]): string {
  const text = serializeBlockClipboard(blocks);
  memory = text;
  try {
    void navigator.clipboard?.writeText(text).catch(() => {});
  } catch {
    /* clipboard blocked; the in-memory copy still pastes in this tab */
  }
  return text;
}

/** Whether a paste could find something (the system clipboard can only be checked by reading it). */
export function canPasteBlocks(): boolean {
  return memory !== null || typeof navigator?.clipboard?.readText === "function";
}

/** Clipboard text for a menu paste: the system clipboard when readable, else the in-memory copy. */
export async function readClipboardText(): Promise<string | null> {
  try {
    const text = await navigator.clipboard?.readText();
    if (text) return text;
  } catch {
    /* permission refused or unsupported */
  }
  return memory;
}

export type PasteParse =
  | { ok: true; blocks: BlockNode[]; kind: "blocks" | "text" }
  | { ok: false; reason: "empty" | "too-large" };

/** Builder data becomes blocks; any other text becomes escaped paragraphs. */
export function blocksFromClipboard(text: string | null): PasteParse {
  if (!text || !text.trim()) return { ok: false, reason: "empty" };
  const parsed = parseBlockClipboard(text, uid);
  if (parsed.ok) return { ok: true, blocks: parsed.blocks as BlockNode[], kind: "blocks" };
  if (parsed.reason === "too-large") return { ok: false, reason: "too-large" };
  if (parsed.reason === "empty") return { ok: false, reason: "empty" };
  const paragraphs = plainTextToBlocks(text, uid) as BlockNode[];
  return paragraphs.length ? { ok: true, blocks: paragraphs, kind: "text" } : { ok: false, reason: "empty" };
}

/** Test hook: forget the in-memory copy. */
export function resetBlockClipboard(): void {
  memory = null;
}
