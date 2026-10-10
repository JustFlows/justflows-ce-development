// SPDX-License-Identifier: MIT

import { JobScheduler } from "@justflows/jobs";
import { getDb } from "../database/db.js";
import {
  liveUploadKey,
  trashedUploadKey,
  trashedUploadKeyCandidates,
} from "../media/upload-paths.js";
import { getUploadStore } from "../media/upload-store.js";
import { getSiteSetting } from "../settings/site-settings.js";
import { auditLog } from "../security/audit-log.js";
import { moveVariantDir, removeVariantDir } from "../media/media-responsive.js";

export const TRASH_RETENTION_SETTING = "trash_retention_days";
export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export type TrashType = "content" | "media" | "comment" | "menu";

export interface TrashItem {
  id: string;
  type: TrashType;
  label: string;
  detail: string | null;
  trashedAt: unknown;
  referenced?: boolean;
}

export async function moveMediaStorage(storageKey: string, toTrash: boolean): Promise<void> {
  const live = liveUploadKey(storageKey);
  const trashed = trashedUploadKey(storageKey);
  if (!live || !trashed) throw new Error("Unsafe media storage key");
  const store = getUploadStore();
  if (toTrash) {
    await store.move(live, trashed);
    return;
  }
  // Restore from the site's own trash, then the legacy shared one.
  for (const candidate of trashedUploadKeyCandidates(storageKey)) {
    if (await store.move(candidate, live)) return;
  }
}

function nowSql(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

export async function trashRetentionDays(siteId: string): Promise<number> {
  const configured = await getSiteSetting<number>(siteId, TRASH_RETENTION_SETTING);
  const days = Number(configured ?? DEFAULT_TRASH_RETENTION_DAYS);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : DEFAULT_TRASH_RETENTION_DAYS;
}

/** Load and serialize each reference document once per operation. */
async function mediaReferenceDocuments(siteId: string): Promise<string[]> {
  const db = await getDb();
  // Inspect portable driver values: JSON casting differs between databases.
  const [content, menus] = await Promise.all([
    db.query<{ blocks: unknown; fields: unknown }>(
      "SELECT blocks, fields FROM content WHERE site_id = ?", [siteId],
    ),
    db.query<{ items: unknown }>("SELECT items FROM menus WHERE site_id = ?", [siteId]),
  ]);
  const documents: string[] = [];
  const append = (value: unknown) => documents.push(
    typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
  );
  for (const row of content) { append(row.blocks); append(row.fields); }
  for (const row of menus) append(row.items);
  return documents;
}

function referencesMedia(documents: string[], url: string, storageKey: string): boolean {
  const needles = [url, storageKey].filter(Boolean);
  return documents.some((document) => needles.some((needle) => document.includes(needle)));
}

async function mediaIsReferenced(siteId: string, url: string, storageKey: string): Promise<boolean> {
  if (!url && !storageKey) return false;
  return referencesMedia(await mediaReferenceDocuments(siteId), url, storageKey);
}

export async function listTrash(siteId: string): Promise<TrashItem[]> {
  const db = await getDb();
  const [content, media, comments, menus] = await Promise.all([
    db.query<Record<string, unknown>>(
      "SELECT id, title, type, trashed_at FROM content WHERE site_id = ? AND trashed_at IS NOT NULL",
      [siteId],
    ),
    db.query<Record<string, unknown>>(
      "SELECT id, filename, mime_type, url, storage_key, trashed_at FROM media WHERE site_id = ? AND trashed_at IS NOT NULL",
      [siteId],
    ),
    db.query<Record<string, unknown>>(
      "SELECT id, author_name, body, trashed_at FROM comments WHERE site_id = ? AND trashed_at IS NOT NULL",
      [siteId],
    ),
    db.query<Record<string, unknown>>(
      "SELECT id, name, trashed_at FROM menus WHERE site_id = ? AND trashed_at IS NOT NULL",
      [siteId],
    ),
  ]);
  const documents = media.length ? await mediaReferenceDocuments(siteId) : [];
  const mediaItems = media.map((row) => ({
    id: String(row.id),
    type: "media" as const,
    label: String(row.filename),
    detail: String(row.mime_type),
    trashedAt: row.trashed_at,
    referenced: referencesMedia(documents, String(row.url), String(row.storage_key)),
  }));
  return [
    ...content.map((row) => ({
      id: String(row.id),
      type: "content" as const,
      label: String(row.title),
      detail: String(row.type),
      trashedAt: row.trashed_at,
    })),
    ...mediaItems,
    ...comments.map((row) => ({
      id: String(row.id),
      type: "comment" as const,
      label: `Comment by ${String(row.author_name)}`,
      detail: String(row.body).slice(0, 120),
      trashedAt: row.trashed_at,
    })),
    ...menus.map((row) => ({
      id: String(row.id),
      type: "menu" as const,
      label: String(row.name),
      detail: null,
      trashedAt: row.trashed_at,
    })),
  ].sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
}

export async function restoreTrashItem(siteId: string, type: TrashType, id: string): Promise<void> {
  const db = await getDb();
  if (type === "content" || type === "menu") {
    const table = type === "content" ? "content" : "menus";
    const rows = await db.query<{ original_slug: string | null; slug: string }>(
      `SELECT original_slug, slug FROM ${table} WHERE id = ? AND site_id = ? AND trashed_at IS NOT NULL LIMIT 1`,
      [id, siteId],
    );
    const row = rows[0];
    if (!row) throw new Error("Trash item not found");
    const slug = row.original_slug ?? row.slug;
    const collision = await db.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE site_id = ? AND slug = ? AND id != ? AND trashed_at IS NULL LIMIT 1`,
      [siteId, slug, id],
    );
    if (collision[0]) throw new Error(`The slug \"${slug}\" is already in use`);
    if (type === "content") {
      await db.run(
        "UPDATE content SET slug = ?, original_slug = NULL, status = COALESCE(original_status, 'draft'), original_status = NULL, trashed_at = NULL, trashed_by = NULL, updated_at = ? WHERE id = ? AND site_id = ?",
        [slug, nowSql(), id, siteId],
      );
      await (await import("../search/search-db.js")).indexSearchContent(siteId, id).catch(() => console.error("[justflows] Search index update after trash operation failed"));
    } else {
      await db.run(
        "UPDATE menus SET slug = ?, original_slug = NULL, trashed_at = NULL, trashed_by = NULL WHERE id = ? AND site_id = ?",
        [slug, id, siteId],
      );
    }
    return;
  }
  const table = type === "media" ? "media" : "comments";
  if (type === "comment") {
    await db.run(
      "UPDATE comments SET status = COALESCE(original_status, 'pending'), original_status = NULL, trashed_at = NULL, trashed_by = NULL, updated_at = ? WHERE id = ? AND site_id = ?",
      [nowSql(), id, siteId],
    );
  } else {
    const rows = await db.query<{ storage_key: string }>(
      "SELECT storage_key FROM media WHERE id = ? AND site_id = ? AND trashed_at IS NOT NULL LIMIT 1",
      [id, siteId],
    );
    if (!rows[0]) throw new Error("Trash item not found");
    await moveMediaStorage(rows[0].storage_key, false);
    await moveVariantDir(siteId, id, false).catch(() => undefined);
    await db.run(
      `UPDATE ${table} SET trashed_at = NULL, trashed_by = NULL, updated_at = ? WHERE id = ? AND site_id = ?`,
      [nowSql(), id, siteId],
    );
  }
}

export async function purgeTrashItem(
  siteId: string,
  type: TrashType,
  id: string,
  allowReferencedMedia = false,
): Promise<void> {
  const db = await getDb();
  if (type === "media") {
    const rows = await db.query<{ storage_key: string; url: string }>(
      "SELECT storage_key, url FROM media WHERE id = ? AND site_id = ? AND trashed_at IS NOT NULL LIMIT 1",
      [id, siteId],
    );
    const row = rows[0];
    if (!row) throw new Error("Trash item not found");
    if (!allowReferencedMedia && (await mediaIsReferenced(siteId, row.url, row.storage_key))) {
      throw new Error(
        "This media file is still referenced; confirm permanent deletion to continue",
      );
    }
    await db.run("DELETE FROM media WHERE id = ? AND site_id = ? AND trashed_at IS NOT NULL", [
      id,
      siteId,
    ]);
    const store = getUploadStore();
    for (const key of trashedUploadKeyCandidates(row.storage_key)) await store.delete(key);
    await removeVariantDir(siteId, id).catch(() => undefined);
    return;
  }
  const table = type === "content" ? "content" : type === "comment" ? "comments" : "menus";
  await db.run(`DELETE FROM ${table} WHERE id = ? AND site_id = ? AND trashed_at IS NOT NULL`, [
    id,
    siteId,
  ]);
  if (type === "content") await (await import("../search/search-db.js")).indexSearchContent(siteId, id).catch(() => console.error("[justflows] Search index update after trash operation failed"));
}

export async function purgeExpiredTrash(): Promise<number> {
  const db = await getDb();
  const sites = await db.query<{ id: string }>("SELECT id FROM sites");
  let purged = 0;
  for (const site of sites) {
    const cutoffTime = Date.now() - (await trashRetentionDays(site.id)) * 86_400_000;
    const items = (await listTrash(site.id)).filter(
      (item) => new Date(String(item.trashedAt)).getTime() <= cutoffTime,
    );
    for (const item of items) {
      await purgeTrashItem(site.id, item.type, item.id, true);
      await auditLog({
        siteId: site.id,
        action: "trash.purged",
        target: item.id,
        detail: `type=${item.type}; retention=true`,
      });
      purged++;
    }
  }
  return purged;
}

let scheduler: JobScheduler | null = null;
export function startTrashPurgeJob(): void {
  if (scheduler) return;
  scheduler = new JobScheduler(console);
  scheduler.register({
    name: "trash.purge-expired",
    schedule: "17 3 * * *",
    maxAttempts: 3,
    handler: async () => ({
      success: true,
      message: `Purged ${await purgeExpiredTrash()} expired items`,
    }),
  });
  scheduler.start();
}
