// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import {
  DEFAULT_REVISION_MAX_HISTORY,
  REVISION_PRUNE_BATCH,
  snapshotsEqual,
  selectHistoricalIdsToPrune,
  visibleHistoricalRevisions,
  type ContentSnapshot,
  type RevisionKind,
  type RevisionSource,
} from "@justflows/content";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { getDb, type DbClient } from "./db.js";
import {
  normalizeBlocks,
  normalizeFields,
  serializeContentRow,
  toIsoTimestamp,
  type ContentResponse,
  type ContentWorkingMeta,
} from "./content-api.js";
import { getSiteSetting } from "./site-settings.js";

export const REVISION_MAX_HISTORY_SETTING = "revisions.max_history";

/** Quote identifiers that are reserved on MySQL/MariaDB (`source`, `kind`). */
export function revisionColumn(name: string): string {
  return process.env.DB_DRIVER === "postgres" ? name : `\`${name}\``;
}

function kindCol(): string {
  return revisionColumn("kind");
}

function sourceCol(): string {
  return revisionColumn("source");
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export interface StoredRevision {
  id: string;
  contentId: string;
  siteId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  locale: string | null;
  translationGroupId: string | null;
  blocks: ContentSnapshot["blocks"];
  fields: Record<string, unknown>;
  version: number;
  baseVersion: number;
  kind: RevisionKind;
  source: RevisionSource;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  authorName: string | null;
}

function asSource(value: unknown): RevisionSource {
  if (value === "autosave" || value === "import" || value === "api" || value === "manual") {
    return value;
  }
  return "manual";
}

function asKind(value: unknown): RevisionKind {
  if (value === "working" || value === "autosave" || value === "historical") return value;
  return "historical";
}

function sanitizedBlocks(input: unknown): ContentSnapshot["blocks"] {
  return sanitizeBlockDocument(input) as ContentSnapshot["blocks"];
}

export function revisionToSnapshot(rev: StoredRevision): ContentSnapshot {
  return {
    title: rev.title,
    slug: rev.slug,
    excerpt: rev.excerpt,
    blocks: rev.blocks,
    fields: rev.fields,
  };
}

export function rowToSnapshot(row: Record<string, unknown>): ContentSnapshot {
  return {
    title: String(row.title ?? ""),
    slug: String(row.slug ?? ""),
    excerpt: row.excerpt == null ? null : String(row.excerpt),
    blocks: sanitizedBlocks(normalizeBlocks(row.blocks)),
    fields: normalizeFields(row.fields),
  };
}

export function parseRevisionRow(row: Record<string, unknown>): StoredRevision {
  return {
    id: String(row.id),
    contentId: String(row.content_id),
    siteId: String(row.site_id),
    title: String(row.title),
    slug: String(row.slug ?? ""),
    excerpt: row.excerpt == null ? null : String(row.excerpt),
    locale: row.locale == null ? null : String(row.locale),
    translationGroupId: row.translation_group_id == null ? null : String(row.translation_group_id),
    blocks: sanitizedBlocks(normalizeBlocks(row.blocks)),
    fields: normalizeFields(row.fields),
    version: Number(row.version ?? 1) || 1,
    baseVersion: Number(row.base_version ?? 1) || 1,
    kind: asKind(row.kind),
    source: asSource(row.source),
    createdAt: toIsoTimestamp(row.created_at) ?? "",
    createdBy: row.created_by == null ? null : String(row.created_by),
    updatedAt: toIsoTimestamp(row.updated_at) ?? toIsoTimestamp(row.created_at) ?? "",
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
    authorName: row.author_name == null ? null : String(row.author_name),
  };
}

function overlayRow(row: Record<string, unknown>, working: StoredRevision): Record<string, unknown> {
  return {
    ...row,
    title: working.title,
    slug: working.slug,
    excerpt: working.excerpt,
    blocks: JSON.stringify(working.blocks),
    fields: JSON.stringify(working.fields),
    updated_at: working.updatedAt,
  };
}

export function serializeEditorContent(
  liveRow: Record<string, unknown>,
  working: StoredRevision | null,
): ContentResponse {
  const live = serializeContentRow(liveRow);
  if (!working || live.status !== "published") {
    return {
      ...live,
      hasWorkingRevision: false,
      workingRevision: null,
      liveChangedSinceWorking: false,
      live: null,
    };
  }

  const overlay = serializeContentRow(overlayRow(liveRow, working));
  const meta: ContentWorkingMeta = {
    id: working.id,
    source: working.source,
    baseVersion: working.baseVersion,
    updatedAt: working.updatedAt,
    updatedBy: working.updatedBy,
    updatedByName: working.authorName,
  };
  return {
    ...overlay,
    status: live.status,
    publishedAt: live.publishedAt,
    createdAt: live.createdAt,
    version: live.version,
    hasWorkingRevision: true,
    workingRevision: meta,
    liveChangedSinceWorking: working.baseVersion !== live.version,
    live: {
      title: live.title,
      slug: live.slug,
      excerpt: live.excerpt,
      blocks: live.blocks,
      fields: live.fields,
      version: live.version,
      updatedAt: live.updatedAt,
    },
  };
}

export async function getWorkingRevision(
  contentId: string,
  siteId: string,
  db?: Pick<DbClient, "query">,
): Promise<StoredRevision | null> {
  const client = db ?? (await getDb());
  const rows = await client.query<Record<string, unknown>>(
    `SELECT r.*, u.display_name AS author_name
     FROM revisions r
     LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.created_by)
     WHERE r.content_id = ? AND r.site_id = ? AND r.${kindCol()} = 'working'
     LIMIT 1`,
    [contentId, siteId],
  );
  return rows[0] ? parseRevisionRow(rows[0]) : null;
}

export async function overlayWorkingOnRow(
  row: Record<string, unknown>,
  preview: boolean,
): Promise<Record<string, unknown>> {
  if (!preview) return row;
  const working = await getWorkingRevision(String(row.id), String(row.site_id));
  if (!working) return row;
  return overlayRow(row, working);
}

export async function listRevisions(
  contentId: string,
  siteId: string,
): Promise<StoredRevision[]> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT r.*, u.display_name AS author_name
     FROM revisions r
     LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.created_by)
     WHERE r.content_id = ? AND r.site_id = ?
     ORDER BY r.created_at DESC`,
    [contentId, siteId],
  );
  const parsed = rows.map(parseRevisionRow);
  const pending = parsed.filter((row) => row.kind !== "historical");
  return [...pending, ...visibleHistoricalRevisions(parsed)];
}

export async function getRevisionById(
  contentId: string,
  siteId: string,
  revisionId: string,
): Promise<StoredRevision | null> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT r.*, u.display_name AS author_name
     FROM revisions r
     LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.created_by)
     WHERE r.id = ? AND r.content_id = ? AND r.site_id = ?
     LIMIT 1`,
    [revisionId, contentId, siteId],
  );
  return rows[0] ? parseRevisionRow(rows[0]) : null;
}

export interface UpsertWorkingInput {
  snapshot: ContentSnapshot;
  source: RevisionSource;
  actorId: string | null;
  baseVersion: number;
}

export async function upsertWorkingRevision(
  liveRow: Record<string, unknown>,
  input: UpsertWorkingInput,
): Promise<StoredRevision | null> {
  const contentId = String(liveRow.id);
  const siteId = String(liveRow.site_id);
  const live = rowToSnapshot(liveRow);
  const db = await getDb();
  const existing = await getWorkingRevision(contentId, siteId, db);

  if (existing) {
    await insertHistoricalIfChanged(liveRow, input.actorId, revisionToSnapshot(existing));
  } else {
    await insertHistoricalIfChanged(liveRow, input.actorId, live);
  }

  if (snapshotsEqual(live, input.snapshot)) {
    if (existing) {
      await db.run(
        `DELETE FROM revisions WHERE id = ? AND content_id = ? AND site_id = ? AND ${kindCol()} = 'working'`,
        [existing.id, contentId, siteId],
      );
    }
    return null;
  }

  const stamp = nowSql();
  if (existing) {
    const changed = await db.execute(
      `UPDATE revisions
       SET title = ?, slug = ?, excerpt = ?, locale = ?, translation_group_id = ?,
           blocks = ?, fields = ?, version = ?, base_version = ?, ${sourceCol()} = ?,
           updated_at = ?, updated_by = ?
       WHERE id = ? AND content_id = ? AND site_id = ? AND ${kindCol()} = 'working' AND version = ?`,
      [
        input.snapshot.title,
        input.snapshot.slug,
        input.snapshot.excerpt ?? null,
        liveRow.locale == null ? null : String(liveRow.locale),
        liveRow.translation_group_id == null ? null : String(liveRow.translation_group_id),
        JSON.stringify(input.snapshot.blocks),
        JSON.stringify(input.snapshot.fields),
        existing.version + 1,
        input.baseVersion,
        input.source,
        stamp,
        input.actorId,
        existing.id,
        contentId,
        siteId,
        existing.version,
      ],
    );
    if (changed !== 1) throw new RevisionConflictError();
    return (await getWorkingRevision(contentId, siteId, db)) ?? existing;
  }

  const id = randomUUID();
  await db.run(
    `INSERT INTO revisions (
       id, content_id, site_id, title, slug, excerpt, locale, translation_group_id,
       blocks, fields, version, base_version, ${kindCol()}, ${sourceCol()}, created_by, created_at,
       updated_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'working', ?, ?, ?, ?, ?)`,
    [
      id,
      contentId,
      siteId,
      input.snapshot.title,
      input.snapshot.slug,
      input.snapshot.excerpt ?? null,
      liveRow.locale == null ? null : String(liveRow.locale),
      liveRow.translation_group_id == null ? null : String(liveRow.translation_group_id),
      JSON.stringify(input.snapshot.blocks),
      JSON.stringify(input.snapshot.fields),
      input.baseVersion,
      input.source,
      input.actorId,
      stamp,
      input.actorId,
      stamp,
    ],
  );
  return (await getWorkingRevision(contentId, siteId, db)) ?? null;
}

export async function insertHistoricalSnapshot(
  liveRow: Record<string, unknown>,
  actorId: string | null,
  snapshot: ContentSnapshot = rowToSnapshot(liveRow),
  client?: Pick<DbClient, "run">,
): Promise<string> {
  const db = client ?? await getDb();
  const id = randomUUID();
  const stamp = nowSql();
  await db.run(
    `INSERT INTO revisions (
       id, content_id, site_id, title, slug, excerpt, locale, translation_group_id,
       blocks, fields, version, base_version, ${kindCol()}, ${sourceCol()}, created_by, created_at,
       updated_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'historical', 'manual', ?, ?, ?, ?)`,
    [
      id,
      String(liveRow.id),
      String(liveRow.site_id),
      snapshot.title,
      snapshot.slug,
      snapshot.excerpt ?? null,
      liveRow.locale == null ? null : String(liveRow.locale),
      liveRow.translation_group_id == null ? null : String(liveRow.translation_group_id),
      JSON.stringify(snapshot.blocks),
      JSON.stringify(snapshot.fields),
      Number(liveRow.version ?? 1) || 1,
      Number(liveRow.version ?? 1) || 1,
      actorId,
      stamp,
      actorId,
      stamp,
    ],
  );
  return id;
}

async function latestHistorical(
  contentId: string,
  siteId: string,
): Promise<StoredRevision | null> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT r.*, u.display_name AS author_name
     FROM revisions r
     LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.created_by)
     WHERE r.content_id = ? AND r.site_id = ? AND r.${kindCol()} = 'historical'
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [contentId, siteId],
  );
  return rows[0] ? parseRevisionRow(rows[0]) : null;
}

/** Store a restore point unless it matches the newest historical row. */
export async function insertHistoricalIfChanged(
  liveRow: Record<string, unknown>,
  actorId: string | null,
  snapshot: ContentSnapshot = rowToSnapshot(liveRow),
): Promise<string | null> {
  const contentId = String(liveRow.id);
  const siteId = String(liveRow.site_id);
  const latest = await latestHistorical(contentId, siteId);
  if (latest && snapshotsEqual(revisionToSnapshot(latest), snapshot)) return null;
  const id = await insertHistoricalSnapshot(liveRow, actorId, snapshot);
  await pruneHistoricalForContent(contentId, siteId);
  return id;
}

export async function archiveThenDeleteWorking(
  liveRow: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  const contentId = String(liveRow.id);
  const siteId = String(liveRow.site_id);
  const working = await getWorkingRevision(contentId, siteId);
  if (working) {
    await insertHistoricalIfChanged(liveRow, actorId, revisionToSnapshot(working));
  }
  await deleteWorkingRevision(contentId, siteId);
}

export async function deleteWorkingRevision(contentId: string, siteId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    `DELETE FROM revisions WHERE content_id = ? AND site_id = ? AND ${kindCol()} = 'working'`,
    [contentId, siteId],
  );
}

export async function deleteRevisionById(id: string, siteId: string): Promise<void> {
  const db = await getDb();
  await db.run("DELETE FROM revisions WHERE id = ? AND site_id = ?", [id, siteId]);
}

export async function applySnapshotToContent(
  contentId: string,
  siteId: string,
  snapshot: ContentSnapshot,
  extras: { status?: string; publishedAt?: string | null; expectedVersion: number },
): Promise<boolean> {
  const db = await getDb();
  const fields = [
    "title = ?",
    "slug = ?",
    "excerpt = ?",
    "blocks = ?",
    "fields = ?",
    "updated_at = ?",
    "version = version + 1",
  ];
  const values: (string | number | boolean | null)[] = [
    snapshot.title,
    snapshot.slug,
    snapshot.excerpt,
    JSON.stringify(snapshot.blocks),
    JSON.stringify(snapshot.fields),
    nowSql(),
  ];
  if (extras.status) {
    fields.push("status = ?");
    values.push(extras.status);
    fields.push("publish_on = NULL");
    if (extras.status !== "published") fields.push("unpublish_on = NULL");
  }
  if (extras.publishedAt !== undefined) {
    fields.push("published_at = COALESCE(published_at, ?)");
    values.push(extras.publishedAt);
  }
  values.push(contentId, siteId, extras.expectedVersion);
  const affected = await db.execute(
    `UPDATE content SET ${fields.join(", ")} WHERE id = ? AND site_id = ? AND version = ?`,
    values,
  );
  return affected === 1;
}

export async function maxHistoryForSite(siteId: string): Promise<number> {
  const stored = await getSiteSetting<unknown>(siteId, REVISION_MAX_HISTORY_SETTING);
  const n = typeof stored === "number" ? stored : Number(stored);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REVISION_MAX_HISTORY;
  return Math.floor(n);
}

export async function pruneHistoricalForContent(
  contentId: string,
  siteId: string,
  maxHistory?: number,
): Promise<number> {
  const db = await getDb();
  const raw = maxHistory ?? (await maxHistoryForSite(siteId));
  const limit = raw < 1 ? DEFAULT_REVISION_MAX_HISTORY : raw;
  const rows = await db.query<{ id: string; created_at: string }>(
    `SELECT id, created_at FROM revisions
     WHERE content_id = ? AND site_id = ? AND ${kindCol()} = 'historical'
     ORDER BY created_at DESC`,
    [contentId, siteId],
  );
  const drop = selectHistoricalIdsToPrune(
    rows.map((r) => ({ id: String(r.id), createdAt: toIsoTimestamp(r.created_at) ?? "" })),
    limit,
  );
  if (drop.length === 0) return 0;
  for (const id of drop.slice(0, REVISION_PRUNE_BATCH)) {
    await db.run(
      `DELETE FROM revisions WHERE id = ? AND site_id = ? AND ${kindCol()} = 'historical'`,
      [id, siteId],
    );
  }
  return Math.min(drop.length, REVISION_PRUNE_BATCH);
}

export async function pruneHistoricalBatch(): Promise<number> {
  const db = await getDb();
  const contents = await db.query<{ id: string; site_id: string }>(
    `SELECT DISTINCT content_id AS id, site_id FROM revisions WHERE ${kindCol()} = 'historical' LIMIT ?`,
    [REVISION_PRUNE_BATCH],
  );
  let removed = 0;
  for (const row of contents) {
    removed += await pruneHistoricalForContent(String(row.id), String(row.site_id));
  }
  return removed;
}

export function serializeRevision(rev: StoredRevision, opts: { includeBody?: boolean } = {}) {
  const summary = {
    id: rev.id,
    contentId: rev.contentId,
    siteId: rev.siteId,
    title: rev.title,
    slug: rev.slug,
    excerpt: rev.excerpt,
    locale: rev.locale,
    translationGroupId: rev.translationGroupId,
    version: rev.version,
    baseVersion: rev.baseVersion,
    kind: rev.kind,
    source: rev.source,
    createdAt: rev.createdAt,
    createdBy: rev.createdBy,
    updatedAt: rev.updatedAt,
    updatedBy: rev.updatedBy,
    authorName: rev.authorName,
  };
  if (!opts.includeBody) return summary;
  return { ...summary, blocks: rev.blocks, fields: rev.fields };
}

export class RevisionConflictError extends Error {
  constructor() { super("The working revision changed while saving; reload and try again"); }
}
