// SPDX-License-Identifier: MIT
import type { RevisionListItem } from "@components/builder/shell/RevisionsDialog";

/**
 * Client for `/api/document-history`: saved versions of the header library,
 * footer, widget areas (`template_part`), and template overrides
 * (`theme_template`, keyed by slug for the active theme).
 */
export type HistoryKind = "template_part" | "theme_template" | "reusable_block";

function query(kind: HistoryKind, key: string): string {
  return `kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`;
}

export async function listDocumentHistory(
  kind: HistoryKind,
  key: string,
  stateLabel: (state: "draft" | "published") => string,
): Promise<RevisionListItem[]> {
  const res = await fetch(`/api/document-history?${query(kind, key)}`);
  const body = (await res.json().catch(() => ({}))) as {
    items?: Array<{ id: string; createdAt: string; createdByName?: string | null; state: "draft" | "published" }>;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return (body.items ?? []).map((item) => ({
    id: item.id,
    createdAt: item.createdAt,
    authorName: item.createdByName ?? null,
    state: stateLabel(item.state),
  }));
}

export async function getDocumentHistoryDoc(kind: HistoryKind, key: string, id: string): Promise<unknown> {
  const res = await fetch(`/api/document-history/${encodeURIComponent(id)}?${query(kind, key)}`);
  const body = (await res.json().catch(() => ({}))) as { doc?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body.doc ?? null;
}

/** The block list inside a stored block document (`{ version, blocks }`). */
export function docBlocks<T>(doc: unknown): T[] {
  const blocks = (doc as { blocks?: unknown } | null)?.blocks;
  return Array.isArray(blocks) ? (blocks as T[]) : [];
}
