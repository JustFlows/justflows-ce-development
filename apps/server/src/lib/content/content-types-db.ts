// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import {
  ContentTypeCacheControlSchema,
  NEVER_CACHE_CONTROL,
  contentTypePolicy,
  seedAccountPage,
  BUILTIN_CONTENT_TYPES,
  ContentTypeFieldsSchema,
  isBuiltinContentTypeSlug,
  type ContentFieldDefinition,
} from "@justflows/content";
import { getDb } from "../database/db.js";
import { runAllMigrations } from "../database/run-migrations.js";
import { getSiteId } from "../settings/site-settings.js";

export interface ContentTypeDefinition {
  id: string;
  siteId: string;
  slug: string;
  label: string;
  description: string;
  builtin: boolean;
  fields: ContentFieldDefinition[];
  cacheControl: string | null;
  cacheControlEditable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ContentTypeRow {
  id: string;
  site_id: string;
  slug: string;
  label: string;
  description: string;
  is_builtin: boolean | number | string;
  fields: unknown;
  cache_control?: string | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function toBool(v: boolean | number | string): boolean {
  return v === true || v === 1 || v === "1" || v === "t";
}

function parseFields(raw: unknown): ContentFieldDefinition[] {
  let parsed: unknown = raw;
  if (Buffer.isBuffer(raw)) {
    parsed = JSON.parse(raw.toString("utf8"));
  } else if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const result = ContentTypeFieldsSchema.safeParse(parsed);
  return result.success ? result.data : [];
}

function serialize(row: ContentTypeRow): ContentTypeDefinition {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    slug: String(row.slug),
    label: String(row.label),
    description: String(row.description ?? ""),
    builtin: toBool(row.is_builtin),
    fields: parseFields(row.fields),
    cacheControl: contentTypePolicy(row.slug).cacheable ? row.cache_control ?? null : NEVER_CACHE_CONTROL,
    cacheControlEditable: contentTypePolicy(row.slug).cacheable,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Create content_types if this site was installed before migration 0005. */
export async function ensureContentTypesTable(): Promise<void> {
  const db = await getDb();
  const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb" | undefined;
  if (!driver) return;
  await runAllMigrations(db, driver);
}

export async function ensureBuiltinContentTypes(siteId?: string): Promise<void> {
  const sid = siteId ?? (await getSiteId());
  if (!sid) return;

  await ensureContentTypesTable();
  const db = await getDb();
  const existing = await db.query<{ slug: string }>(
    "SELECT slug FROM content_types WHERE site_id = ?",
    [sid],
  );
  const have = new Set(existing.map((row) => row.slug));
  const timestamp = now();
  const builtinFlag = process.env.DB_DRIVER === "postgres" ? true : 1;

  for (const builtin of BUILTIN_CONTENT_TYPES) {
    if (have.has(builtin.slug)) continue;
    await db.run(
      `INSERT INTO content_types (id, site_id, slug, label, description, is_builtin, fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        sid,
        builtin.slug,
        builtin.label,
        builtin.description,
        builtinFlag,
        JSON.stringify([]),
        timestamp,
        timestamp,
      ],
    );
  }
  const { getDefaultLocale } = await import("../i18n/languages-db.js");
  await seedAccountPage(db, sid, await getDefaultLocale(sid));
}

export async function listContentTypes(siteId?: string): Promise<ContentTypeDefinition[]> {
  const sid = siteId ?? (await getSiteId());
  if (!sid) return [];

  await ensureBuiltinContentTypes(sid);
  const db = await getDb();
  const rows = await db.query<ContentTypeRow>(
    "SELECT * FROM content_types WHERE site_id = ? ORDER BY is_builtin DESC, slug ASC",
    [sid],
  );
  return rows.map(serialize);
}

export async function getContentTypeBySlug(
  slug: string,
  siteId?: string,
): Promise<ContentTypeDefinition | null> {
  const sid = siteId ?? (await getSiteId());
  if (!sid) return null;

  await ensureBuiltinContentTypes(sid);
  const db = await getDb();
  const rows = await db.query<ContentTypeRow>(
    "SELECT * FROM content_types WHERE site_id = ? AND slug = ? LIMIT 1",
    [sid, slug],
  );
  return rows[0] ? serialize(rows[0]) : null;
}

export async function createContentType(
  siteId: string,
  input: { slug: string; label: string; description?: string; fields?: ContentFieldDefinition[]; cacheControl?: string | null },
): Promise<ContentTypeDefinition> {
  if (isBuiltinContentTypeSlug(input.slug)) {
    throw new Error("Cannot recreate a built-in content type");
  }

  const db = await getDb();
  const id = randomUUID();
  const timestamp = now();
  const fields = ContentTypeFieldsSchema.parse(input.fields ?? []);
  const cacheControl = ContentTypeCacheControlSchema.parse(input.cacheControl ?? null);

  await db.run(
    `INSERT INTO content_types (id, site_id, slug, label, description, is_builtin, fields, cache_control, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      siteId,
      input.slug,
      input.label,
      input.description ?? "",
      process.env.DB_DRIVER === "postgres" ? false : 0,
      JSON.stringify(fields),
      cacheControl,
      timestamp,
      timestamp,
    ],
  );

  const created = await getContentTypeBySlug(input.slug, siteId);
  if (!created) throw new Error("Failed to create content type");
  return created;
}

export async function updateContentType(
  siteId: string,
  slug: string,
  patch: { label?: string; description?: string; fields?: ContentFieldDefinition[]; cacheControl?: string | null },
): Promise<ContentTypeDefinition> {
  const existing = await getContentTypeBySlug(slug, siteId);
  if (!existing) throw new Error("Content type not found");

  const db = await getDb();
  const fields: string[] = [];
  const values: (string | number | boolean | null)[] = [];

  if (patch.label !== undefined) {
    fields.push("label = ?");
    values.push(patch.label);
  }
  if (patch.description !== undefined) {
    fields.push("description = ?");
    values.push(patch.description);
  }
  if (patch.fields !== undefined) {
    fields.push("fields = ?");
    values.push(JSON.stringify(ContentTypeFieldsSchema.parse(patch.fields)));
  }

  if (patch.cacheControl !== undefined) {
    if (!existing.cacheControlEditable) throw new Error("This content type must never be cached; Cache-Control is locked");
    fields.push("cache_control = ?");
    values.push(ContentTypeCacheControlSchema.parse(patch.cacheControl));
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now(), siteId, slug);
  await db.run(
    `UPDATE content_types SET ${fields.join(", ")} WHERE site_id = ? AND slug = ?`,
    values,
  );

  if (patch.cacheControl !== undefined && patch.cacheControl !== existing.cacheControl) {
    const { revalidateSelected } = await import("../cache/cache-revalidate.js");
    await revalidateSelected(["pages", "content"]);
    const { purgeCdnCache } = await import("../cdn/cdn-purge.js");
    await purgeCdnCache({ siteId }).catch(() => undefined);
  }

  const updated = await getContentTypeBySlug(slug, siteId);
  if (!updated) throw new Error("Content type not found");
  return updated;
}

export async function deleteContentType(siteId: string, slug: string): Promise<void> {
  const existing = await getContentTypeBySlug(slug, siteId);
  if (!existing) throw new Error("Content type not found");
  if (existing.builtin) throw new Error("Cannot delete a built-in content type");

  const db = await getDb();
  const inUse = await db.query<{ id: string }>(
    "SELECT id FROM content WHERE site_id = ? AND type = ? LIMIT 1",
    [siteId, slug],
  );
  if (inUse[0]) {
    throw new Error("Cannot delete a content type that still has entries");
  }

  await db.run("DELETE FROM content_types WHERE site_id = ? AND slug = ?", [siteId, slug]);
}
