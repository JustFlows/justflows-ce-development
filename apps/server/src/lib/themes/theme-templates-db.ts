// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { getDb } from "../database/db.js";
import { DocumentRevisionConflictError, revisionOf } from "../database/document-revision.js";
import { runAllMigrations } from "../database/run-migrations.js";

/**
 * Storage for per-site theme template overrides in the dedicated
 * `theme_templates` table. One row per (site, theme, slug): `doc` is the
 * published block document, `draft_doc` the unpublished working copy (NULL when
 * none). No row means the editor never touched this template, so the theme's
 * own `templates/<slug>.json` (or the built-in view) is used.
 *
 * The document shape is the caller's concern — this layer only reads and writes
 * JSON. See `theme-templates-store.ts`.
 */

/** Run the templates migration if the table doesn't exist yet (idempotent). */
export async function ensureThemeTemplatesTable(): Promise<void> {
  const db = await getDb();
  const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb";
  await runAllMigrations(db, driver);
}

function nowSql(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

interface Row {
  doc: unknown;
  draft_doc: unknown;
  revision?: unknown;
}

async function readRow(siteId: string, themeId: string, slug: string): Promise<Row | null> {
  const db = await getDb();
  const rows = await db.query<Row>(
    "SELECT doc, draft_doc, revision FROM theme_templates WHERE site_id = ? AND theme_id = ? AND slug = ? LIMIT 1",
    [siteId, themeId, slug],
  );
  return rows[0] ?? null;
}

export async function getThemeTemplateDoc<T>(
  siteId: string,
  themeId: string,
  slug: string,
  opts: { draft?: boolean } = {},
): Promise<T | null> {
  const row = await readRow(siteId, themeId, slug);
  if (!row) return null;
  return parseJson<T>(opts.draft ? row.draft_doc : row.doc);
}

/** Both the published doc and the draft doc, in one read. */
export async function getThemeTemplateDocs<T>(
  siteId: string,
  themeId: string,
  slug: string,
): Promise<{ doc: T | null; draft: T | null; revision: number }> {
  const row = await readRow(siteId, themeId, slug);
  return {
    doc: row ? parseJson<T>(row.doc) : null,
    draft: row ? parseJson<T>(row.draft_doc) : null,
    revision: row ? revisionOf(row.revision) : 0,
  };
}

export async function themeTemplateHasDraft(
  siteId: string,
  themeId: string,
  slug: string,
): Promise<boolean> {
  const row = await readRow(siteId, themeId, slug);
  return row?.draft_doc != null && parseJson(row.draft_doc) != null;
}

/** The slugs this site has an override row for (published or draft). */
export async function listOverriddenTemplateSlugs(
  siteId: string,
  themeId: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ slug: string }>(
    "SELECT slug FROM theme_templates WHERE site_id = ? AND theme_id = ? ORDER BY slug",
    [siteId, themeId],
  );
  return rows.map((r) => String(r.slug));
}

/**
 * Write a row and return its new revision. With `expectedRevision` the write
 * only applies when the stored revision still matches (`0` = no row yet), and
 * a mismatch throws {@link DocumentRevisionConflictError} without writing.
 */
async function upsert(
  siteId: string,
  themeId: string,
  slug: string,
  set: { doc?: unknown; draft_doc?: unknown | null },
  expectedRevision?: number,
): Promise<number> {
  if (expectedRevision !== undefined) return conditionalWrite(siteId, themeId, slug, set, expectedRevision);
  const db = await getDb();
  const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb" | undefined;
  const hasDoc = Object.prototype.hasOwnProperty.call(set, "doc");
  const hasDraft = Object.prototype.hasOwnProperty.call(set, "draft_doc");
  const docJson = hasDoc ? JSON.stringify(set.doc ?? {}) : null;
  const draftJson = hasDraft
    ? set.draft_doc == null
      ? null
      : JSON.stringify(set.draft_doc)
    : null;
  const stamp = nowSql();

  if (driver === "postgres") {
    await db.run(
      `INSERT INTO theme_templates (id, site_id, theme_id, slug, doc, draft_doc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, theme_id, slug) DO UPDATE SET
         doc = ${hasDoc ? "EXCLUDED.doc" : "theme_templates.doc"},
         draft_doc = ${hasDraft ? "EXCLUDED.draft_doc" : "theme_templates.draft_doc"},
         revision = theme_templates.revision + 1,
         updated_at = EXCLUDED.updated_at`,
      [randomUUID(), siteId, themeId, slug, docJson ?? "{}", draftJson, stamp, stamp],
    );
    return revisionOf((await readRow(siteId, themeId, slug))?.revision);
  }

  await db.run(
    `INSERT INTO theme_templates (id, site_id, theme_id, slug, doc, draft_doc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       doc = ${hasDoc ? "VALUES(doc)" : "doc"},
       draft_doc = ${hasDraft ? "VALUES(draft_doc)" : "draft_doc"},
       revision = revision + 1,
       updated_at = VALUES(updated_at)`,
    [randomUUID(), siteId, themeId, slug, docJson ?? "{}", draftJson, stamp, stamp],
  );
  return revisionOf((await readRow(siteId, themeId, slug))?.revision);
}

async function conditionalWrite(
  siteId: string,
  themeId: string,
  slug: string,
  set: { doc?: unknown; draft_doc?: unknown | null },
  expectedRevision: number,
): Promise<number> {
  const db = await getDb();
  const hasDoc = Object.prototype.hasOwnProperty.call(set, "doc");
  const hasDraft = Object.prototype.hasOwnProperty.call(set, "draft_doc");
  const draftJson = set.draft_doc == null ? null : JSON.stringify(set.draft_doc);
  const stamp = nowSql();

  if (expectedRevision === 0) {
    const existing = await readRow(siteId, themeId, slug);
    if (existing) throw new DocumentRevisionConflictError(0, revisionOf(existing.revision));
    try {
      await db.run(
        `INSERT INTO theme_templates (id, site_id, theme_id, slug, doc, draft_doc, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [randomUUID(), siteId, themeId, slug, JSON.stringify(hasDoc ? (set.doc ?? {}) : {}), hasDraft ? draftJson : null, stamp, stamp],
      );
    } catch (err) {
      /** Lost an insert race: another editor created the row first. */
      const raced = await readRow(siteId, themeId, slug);
      if (raced) throw new DocumentRevisionConflictError(0, revisionOf(raced.revision));
      throw err;
    }
    return 1;
  }

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (hasDoc) {
    sets.push("doc = ?");
    values.push(JSON.stringify(set.doc ?? {}));
  }
  if (hasDraft) {
    sets.push("draft_doc = ?");
    values.push(draftJson);
  }
  sets.push("revision = revision + 1", "updated_at = ?");
  values.push(stamp);
  const changed = await db.execute(
    `UPDATE theme_templates SET ${sets.join(", ")} WHERE site_id = ? AND theme_id = ? AND slug = ? AND revision = ?`,
    [...values, siteId, themeId, slug, expectedRevision],
  );
  if (changed !== 1) {
    const current = await readRow(siteId, themeId, slug);
    throw new DocumentRevisionConflictError(expectedRevision, current ? revisionOf(current.revision) : 0);
  }
  return expectedRevision + 1;
}

/** Write the working copy without touching the published doc. */
export async function saveThemeTemplateDraft(
  siteId: string,
  themeId: string,
  slug: string,
  doc: unknown,
  expectedRevision?: number,
): Promise<number> {
  return upsert(siteId, themeId, slug, { draft_doc: doc }, expectedRevision);
}

/** Write the published doc without touching the draft. */
export async function saveThemeTemplatePublished(
  siteId: string,
  themeId: string,
  slug: string,
  doc: unknown,
  expectedRevision?: number,
): Promise<number> {
  return upsert(siteId, themeId, slug, { doc }, expectedRevision);
}

/** Publish: write the published doc and drop the leftover draft. */
export async function publishThemeTemplateDoc(
  siteId: string,
  themeId: string,
  slug: string,
  doc: unknown,
  expectedRevision?: number,
): Promise<number> {
  return upsert(siteId, themeId, slug, { doc, draft_doc: null }, expectedRevision);
}

export async function clearThemeTemplateDraftDoc(
  siteId: string,
  themeId: string,
  slug: string,
  expectedRevision?: number,
): Promise<number> {
  return upsert(siteId, themeId, slug, { draft_doc: null }, expectedRevision);
}

/** Drop the override entirely — the template reverts to the theme's own file. */
export async function deleteThemeTemplateRow(
  siteId: string,
  themeId: string,
  slug: string,
): Promise<void> {
  const db = await getDb();
  await db.run("DELETE FROM theme_templates WHERE site_id = ? AND theme_id = ? AND slug = ?", [
    siteId,
    themeId,
    slug,
  ]);
}
