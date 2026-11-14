// SPDX-License-Identifier: MIT

/**
 * A browser-local copy of unsaved builder edits, so a reload, crashed tab, or
 * expired session never loses work that had not reached the server yet.
 *
 * It is a safety net, not a draft store: the server draft stays
 * authoritative, nothing here is ever sent without the author choosing to
 * restore it, and the copy is cleared as soon as the same content is saved.
 * Storage can be unavailable or full; every call degrades to a no-op.
 */

export interface RecoveryContent {
  title: string;
  blocks: unknown;
  fields: Record<string, unknown> | undefined;
}

export interface RecoveryEntry extends RecoveryContent {
  /** When the copy was written, ISO 8601. */
  savedAt: string;
  /** The live version the edits were based on. */
  baseVersion: number | undefined;
}

const PREFIX = "jf-builder-recovery";

export function recoveryKey(userId: string | null | undefined, contentId: string): string {
  return `${PREFIX}:${userId || "anon"}:${contentId}`;
}

function isEntry(value: unknown): value is RecoveryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === "string" && typeof v.savedAt === "string" && "blocks" in v;
}

export function readRecovery(key: string): RecoveryEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRecovery(key: string, content: RecoveryContent, baseVersion: number | undefined): void {
  const entry: RecoveryEntry = { ...content, baseVersion, savedAt: new Date().toISOString() };
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /** Storage blocked or full: the server draft is still the safety net. */
  }
}

export function clearRecovery(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /** Nothing to clear when storage is blocked. */
  }
}

/** Whether a recovered copy holds anything the server version does not. */
export function recoveryDiffers(entry: RecoveryContent, server: RecoveryContent): boolean {
  return (
    entry.title !== server.title ||
    JSON.stringify(entry.blocks ?? null) !== JSON.stringify(server.blocks ?? null) ||
    JSON.stringify(entry.fields ?? {}) !== JSON.stringify(server.fields ?? {})
  );
}
