// SPDX-License-Identifier: MIT

import { sanitizeBlockDocument } from "./sanitize-document.js";
import { BLOCK_MAX_DEPTH, reassignBlockIds, type BlockIdFactory } from "./document-contract.js";

/**
 * The builder clipboard (justflows-ce#298). Copied blocks travel as JSON with
 * a format marker, so a paste can tell builder data from ordinary text.
 *
 * Reading is the trust boundary: clipboard text can come from anywhere. A
 * parse runs the same sanitizer as a save, caps size, node count and depth,
 * gives every node a fresh id, and drops lock flags (a copy is a new block
 * owned by whoever pastes it). References to shared items, such as a reusable
 * block's `ref`, are kept on purpose: a pasted reference still points at the
 * same reusable block.
 */

export const BLOCK_CLIPBOARD_FORMAT = "justflows/blocks";
/** Custom MIME type for copy events; `text/plain` carries the same JSON for other browsers and tabs. */
export const BLOCK_CLIPBOARD_MIME = "application/x-justflows-blocks";
export const BLOCK_CLIPBOARD_MAX_CHARS = 1_000_000;
export const BLOCK_CLIPBOARD_MAX_NODES = 1_000;
/** Longest plain text turned into paragraphs on paste. */
export const PLAIN_PASTE_MAX_CHARS = 50_000;

export interface BlockClipboardPayload {
  format: typeof BLOCK_CLIPBOARD_FORMAT;
  version: 1;
  blocks: unknown[];
}

export interface ClipboardBlock {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
  children?: ClipboardBlock[];
  editor?: { label?: string };
}

export function serializeBlockClipboard(blocks: unknown[]): string {
  const payload: BlockClipboardPayload = { format: BLOCK_CLIPBOARD_FORMAT, version: 1, blocks };
  return JSON.stringify(payload);
}

/** Cheap check before parsing: does this text claim to be builder data? */
export function looksLikeBlockClipboard(text: string): boolean {
  return text.length <= BLOCK_CLIPBOARD_MAX_CHARS && text.trimStart().startsWith("{") && text.includes(BLOCK_CLIPBOARD_FORMAT);
}

function countAndDepth(list: unknown[], depth = 1): { nodes: number; depth: number } {
  let nodes = 0;
  let deepest = list.length ? depth : depth - 1;
  for (const raw of list) {
    nodes++;
    const children = (raw as { children?: unknown }).children;
    if (Array.isArray(children) && children.length) {
      const inner = countAndDepth(children, depth + 1);
      nodes += inner.nodes;
      deepest = Math.max(deepest, inner.depth);
    }
  }
  return { nodes, depth: deepest };
}

/** Keep the stored shape, minus lock flags. Nodes without a type are dropped. */
function toClipboardNodes(list: unknown[]): ClipboardBlock[] {
  const out: ClipboardBlock[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    if (typeof node["type"] !== "string" || !node["type"]) continue;
    const block: ClipboardBlock = {
      id: typeof node["id"] === "string" ? node["id"] : "",
      type: node["type"],
      version: typeof node["version"] === "number" ? node["version"] : 1,
      props: (node["props"] as Record<string, unknown>) ?? {},
    };
    if (Array.isArray(node["children"])) block.children = toClipboardNodes(node["children"]);
    const label = (node["editor"] as { label?: unknown } | undefined)?.label;
    if (typeof label === "string" && label) block.editor = { label };
    out.push(block);
  }
  return out;
}

export type BlockClipboardParse =
  | { ok: true; blocks: ClipboardBlock[] }
  | { ok: false; reason: "not-blocks" | "too-large" | "empty" };

/**
 * Turn clipboard text into blocks ready to insert, or say why not.
 * `not-blocks` means the text is not builder data; callers may paste it as text.
 */
export function parseBlockClipboard(text: string, makeId: BlockIdFactory): BlockClipboardParse {
  if (text.length > BLOCK_CLIPBOARD_MAX_CHARS) return { ok: false, reason: "too-large" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-blocks" };
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { format?: unknown }).format !== BLOCK_CLIPBOARD_FORMAT ||
    !Array.isArray((payload as { blocks?: unknown }).blocks)
  ) {
    return { ok: false, reason: "not-blocks" };
  }
  const raw = (payload as { blocks: unknown[] }).blocks;
  const size = countAndDepth(raw.filter((n) => n && typeof n === "object"));
  if (size.nodes > BLOCK_CLIPBOARD_MAX_NODES || size.depth > BLOCK_MAX_DEPTH) return { ok: false, reason: "too-large" };
  const clean = toClipboardNodes(sanitizeBlockDocument({ version: 1, blocks: raw }).blocks);
  if (clean.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, blocks: reassignBlockIds(clean, makeId) };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Ordinary text pasted onto the canvas: one paragraph per blank-line-separated
 * chunk. The text is escaped, never interpreted as markup.
 */
export function plainTextToBlocks(text: string, makeId: BlockIdFactory): ClipboardBlock[] {
  const chunks = text
    .slice(0, PLAIN_PASTE_MAX_CHARS)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(0, BLOCK_CLIPBOARD_MAX_NODES);
  return chunks.map((chunk) => ({
    id: makeId(),
    type: "core.paragraph",
    version: 1,
    props: { text: escapeHtml(chunk).replace(/\n/g, "<br>") },
  }));
}
