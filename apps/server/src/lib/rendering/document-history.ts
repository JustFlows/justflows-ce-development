// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { getDb } from "../database/db.js";

/**
 * Version history for site-wide builder documents that have no content
 * revisions of their own: the header library, the footer, widget areas
 * (`template_part`), and theme template overrides (`theme_template`).
 *
 * Each save records the document exactly as written, with the row revision
 * it produced, so the builder can compare and restore earlier versions
 * (justflows-ce#302). Restoring is done by the editor: it loads the old
 * document and saves it through the normal, revision-checked write path.
 */

/** `reusable_block` keys are reusable block ids (justflows-ce#304). */
export const DOCUMENT_HISTORY_KINDS = ["template_part", "theme_template", "reusable_block"] as const;
export type DocumentHistoryKind = (typeof DOCUMENT_HISTORY_KINDS)[number];

/** Versions kept per document; older ones are pruned when a new one is recorded. */
export const DOCUMENT_HISTORY_LIMIT = 30;

export interface DocumentHistoryEntry {
  id: string;
  revision: number;
  state: "draft" | "published";
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
}

export function isDocumentHistoryKind(value: unknown): value is DocumentHistoryKind {
  return typeof value === "string" && (DOCUMENT_HISTORY_KINDS as readonly string[]).includes(value);
}

/** History key for a theme template override: one theme's slug. */
export function themeTemplateHistoryKey(themeId: string, slug: string): string {
  return `${themeId}/${slug}`;
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "");
  return text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
}

/**
 * Record one written version and prune the oldest beyond the limit. Recording
 * is best effort: a failure here must never fail the save it describes.
 */
export async function recordDocumentHistory(input: {
  siteId: string;
  kind: DocumentHistoryKind;
  key: string;
  revision: number;
  state: "draft" | "published";
  doc: unknown;
  actorId?: string | null;
}): Promise<void> {
  try {
    const db = await getDb();
    await db.run(
      `INSERT INTO document_history (id, site_id, doc_kind, doc_key, revision, state, doc, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.siteId,
        input.kind,
        input.key,
        input.revision,
        input.state,
        JSON.stringify(input.doc ?? null),
        input.actorId ?? null,
        nowSql(),
      ],
    );
    /** Bounded prune: find what falls outside the newest N, then delete exactly those ids. */
    const stale = await db.query<{ id: string }>(
      `SELECT id FROM document_history
       WHERE site_id = ? AND doc_kind = ? AND doc_key = ?
       ORDER BY created_at DESC, revision DESC
       LIMIT 100 OFFSET ${DOCUMENT_HISTORY_LIMIT}`,
      [input.siteId, input.kind, input.key],
    );
    if (stale.length > 0) {
      const ids = stale.map((row) => String(row.id));
      await db.run(
        `DELETE FROM document_history WHERE site_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
        [input.siteId, ...ids],
      );
    }
  } catch {
    /** History is a convenience; the document itself is already saved. */
  }
}

/** The newest versions of one document, newest first. */
export async function listDocumentHistory(
  siteId: string,
  kind: DocumentHistoryKind,
  key: string,
): Promise<DocumentHistoryEntry[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT h.id, h.revision, h.state, h.created_at, h.created_by, u.display_name AS created_by_name
     FROM document_history h
     LEFT JOIN users u ON u.id = h.created_by AND u.site_id = h.site_id
     WHERE h.site_id = ? AND h.doc_kind = ? AND h.doc_key = ?
     ORDER BY h.created_at DESC, h.revision DESC
     LIMIT ${DOCUMENT_HISTORY_LIMIT}`,
    [siteId, kind, key],
  );
  return rows.map((row) => ({
    id: String(row.id),
    revision: Number(row.revision) || 0,
    state: row.state === "published" ? "published" : "draft",
    createdAt: iso(row.created_at),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdByName: row.created_by_name == null ? null : String(row.created_by_name),
  }));
}

/** One recorded version's document, scoped to the site and the document it belongs to. */
export async function getDocumentHistoryDoc(
  siteId: string,
  kind: DocumentHistoryKind,
  key: string,
  id: string,
): Promise<unknown | null> {
  const db = await getDb();
  const rows = await db.query<{ doc: unknown }>(
    `SELECT doc FROM document_history WHERE id = ? AND site_id = ? AND doc_kind = ? AND doc_key = ? LIMIT 1`,
    [id, siteId, kind, key],
  );
  const raw = rows[0]?.doc;
  if (raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return raw;
}
