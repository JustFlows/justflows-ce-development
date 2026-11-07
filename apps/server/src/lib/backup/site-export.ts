// SPDX-License-Identifier: MIT

import type { DbClient } from "../database/db.js";
import type { PortableBackupData } from "./portable-archive.js";
import { MAX_PORTABLE_MEDIA_BYTES } from "./portable-archive.js";
import { createHash } from "node:crypto";
import { getUploadStore, isSafeUploadKey } from "../media/upload-store.js";

const SITE_TABLES = [
  "sites",
  "users",
  "content",
  "content_visibility",
  "site_settings",
  "media",
  "revisions",
  "taxonomies",
  "terms",
  "menus",
  "comments",
  "languages",
  "content_types",
  "template_parts",
  "theme_designs",
  "theme_templates",
  "redirects",
  "comment_moderation_rules",
  "comment_spam_terms",
] as const;

const SAFE_TABLE_NAMES = new Set<string>(SITE_TABLES);
const SENSITIVE_SETTING_KEY = /(secret|password|credential|private.?key|access.?token|refresh.?token|api.?key)/i;

type QueryClient = Pick<DbClient, "query">;

async function siteRows(db: QueryClient, table: string, siteId: string): Promise<Record<string, unknown>[]> {
  if (!SAFE_TABLE_NAMES.has(table)) throw new Error("Unsupported backup table");
  return db.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${table === "sites" ? "id" : "site_id"} = ?`, [siteId]);
}

/** Read a consistent logical snapshot using one database transaction. */
export async function exportSiteData(
  db: DbClient,
  siteId: string,
  options: { signal?: AbortSignal; progress?: (completed: number, total: number) => void } = {},
): Promise<PortableBackupData> {
  if (options.signal?.aborted) throw new Error("Backup cancelled");
  const data = await db.transaction<PortableBackupData>(async (tx) => {
    const tables: PortableBackupData["tables"] = {};
    for (const table of SITE_TABLES) tables[table] = await siteRows(tx, table, siteId);
    tables.users = (tables.users ?? []).map(({ password_hash: _passwordHash, ...user }) => user);
    tables.site_settings = (tables.site_settings ?? []).filter(
      (row) => !SENSITIVE_SETTING_KEY.test(String(row.key ?? "")),
    );

    tables.content_terms = await tx.query<Record<string, unknown>>(
      "SELECT ct.* FROM content_terms ct INNER JOIN content c ON c.id = ct.content_id WHERE c.site_id = ?",
      [siteId],
    );
    const [plugins, themes] = await Promise.all([
      tx.query<Record<string, unknown>>("SELECT plugin_id, version, status, manifest FROM plugins WHERE site_id = ?", [siteId]),
      tx.query<Record<string, unknown>>("SELECT theme_id, name, version, status, manifest FROM themes WHERE site_id = ?", [siteId]),
    ]);
    return { tables, extensions: { plugins, themes }, files: [] as PortableBackupData["files"] };
  });
  const store = getUploadStore();
  let totalBytes = 0;
  const missing: string[] = [];
  const mediaRows = data.tables.media ?? [];
  options.progress?.(0, mediaRows.length);
  for (const [index, row] of mediaRows.entries()) {
    if (options.signal?.aborted) throw new Error("Backup cancelled");
    if (row.trashed_at) {
      options.progress?.(index + 1, mediaRows.length);
      continue;
    }
    const key = String(row.storage_key ?? "");
    if (!isSafeUploadKey(key) || !key.startsWith(`${siteId}/`)) {
      missing.push(String(row.filename ?? (key || "unknown")));
      continue;
    }
    const bytes = await store.read(key).catch(() => null);
    if (!bytes) {
      missing.push(String(row.filename ?? key));
      continue;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PORTABLE_MEDIA_BYTES) throw new Error("Media exceeds the portable backup size limit");
    data.files.push({
      key,
      mimeType: String(row.mime_type ?? "application/octet-stream"),
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data: bytes.toString("base64"),
    });
    options.progress?.(index + 1, mediaRows.length);
  }
  if (missing.length > 0) {
    throw new Error(`Backup stopped because ${missing.length} media file${missing.length === 1 ? " is" : "s are"} missing`);
  }
  return data;
}
