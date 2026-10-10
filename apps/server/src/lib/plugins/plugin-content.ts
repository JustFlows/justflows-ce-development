// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { PluginContentApi, PluginPublishedEntry, PluginPublishedPage } from "@justflows/sdk";
import {
  ContentTypeFieldsSchema,
  ContentTypeSlugSchema,
  isBuiltinContentTypeSlug,
  normalizeContentTypeSlug,
} from "@justflows/content";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { getDb } from "../database/db.js";
import { pluginCallSiteId } from "./request-site.js";
import { serializeContentRow } from "../content/content-api.js";
import { createContentType, getContentTypeBySlug } from "../content/content-types-db.js";
import { getDefaultLocale } from "../i18n/languages-db.js";
import { clearHomePagesIfMatch } from "../content/home-page.js";
import { clearBlogPagesIfMatch } from "../content/blog-page.js";
import { clearErrorPagesIfMatch } from "../rendering/error-pages.js";
import { invalidateContentCache } from "../content/content-public.js";
import { deleteRecordsCreatedBy } from "../content/delete-created-by.js";
import {
  getPluginHostItem,
  PLUGIN_HOST_CONTENT_TYPES_ITEM,
  setPluginHostItem,
} from "./plugin-kv.js";

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 200);
}

/**
 * One entry per translation group: the `locale` version, else whichever other
 * version the query let through (the default-locale original). Keeps the
 * newest-first order of each group's first row.
 */
function preferLocale<T extends { id: string; locale: string; translationGroupId: string | null }>(
  entries: T[],
  locale: string,
): T[] {
  const chosen = new Map<string, T>();
  for (const entry of entries) {
    const group = entry.translationGroupId ?? entry.id;
    const current = chosen.get(group);
    if (!current || (current.locale !== locale && entry.locale === locale)) chosen.set(group, entry);
  }
  return [...chosen.values()];
}

/** Optional expiry timestamp a plugin or import may have stored on a content row. */
function expiryTimestamp(fields: Record<string, unknown>): number | null {
  for (const key of ["expiresAt", "expiryDate", "unpublishAt"]) {
    const raw = fields[key];
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

async function resolveAuthorId(
  siteId: string,
  username: string,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE site_id = ? AND username = ? LIMIT 1",
    [siteId, username],
  );
  return rows[0] ? String(rows[0].id) : null;
}

async function authorNames(siteId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const db = await getDb();
  const rows = await db.query<{ id: string; display_name: string; username: string }>(
    `SELECT id, display_name, username FROM users
     WHERE site_id = ? AND id IN (${unique.map(() => "?").join(", ")})`,
    [siteId, ...unique],
  );
  return new Map(rows.map((row) => [String(row.id), row.display_name || row.username]));
}

/** Published, not scheduled for later, and not expired. */
function liveNow(entry: { publishedAt: string | null; fields: Record<string, unknown> }, now: number): boolean {
  if (entry.publishedAt) {
    const published = Date.parse(entry.publishedAt);
    if (!Number.isNaN(published) && published > now) return false;
  }
  const expiry = expiryTimestamp(entry.fields);
  return expiry === null || expiry > now;
}

export function createPluginContentApi(pluginId: string, activatedSiteId: string): PluginContentApi {
  return {
    async getPublished(query) {
      const siteId = pluginCallSiteId(activatedSiteId);
      const type = query.type.trim();
      const slug = query.slug.trim();
      if (!type || !slug) return null;
      const db = await getDb();
      const defaultLocale = await getDefaultLocale(siteId);
      const rows = await db.query<Record<string, unknown>>(
        "SELECT * FROM content WHERE site_id = ? AND type = ? AND slug = ? AND status = 'published' AND locale = ? LIMIT 1",
        [siteId, type, slug, defaultLocale],
      );
      let row = rows[0] ?? null;
      if (!row) return null;
      // A translation keeps the original's group but may have its own slug.
      const locale = query.locale?.trim();
      const group = row["translation_group_id"] == null ? String(row["id"]) : String(row["translation_group_id"]);
      if (locale && locale !== defaultLocale) {
        const translated = await db.query<Record<string, unknown>>(
          "SELECT * FROM content WHERE site_id = ? AND translation_group_id = ? AND locale = ? AND status = 'published' LIMIT 1",
          [siteId, group, locale],
        );
        if (translated[0] && liveNow(serializeContentRow(translated[0]), Date.now())) row = translated[0];
      }
      const entry = serializeContentRow(row);
      if (!liveNow(entry, Date.now())) return null;
      const names = await authorNames(siteId, entry.authorId ? [entry.authorId] : []);
      const page: PluginPublishedPage = {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        slug: entry.slug,
        locale: entry.locale,
        translationGroupId: entry.translationGroupId ?? entry.id,
        excerpt: entry.excerpt,
        fields: entry.fields,
        authorId: entry.authorId,
        authorName: (entry.authorId && names.get(entry.authorId)) || null,
        publishedAt: entry.publishedAt,
        updatedAt: entry.updatedAt,
        createdAt: entry.createdAt,
        blocks: Array.isArray(entry.blocks?.blocks) ? entry.blocks.blocks : [],
      };
      return page;
    },

    async listPublished(query = {}) {
      const siteId = pluginCallSiteId(activatedSiteId);
      const limit = Math.min(Math.max(Math.floor(query.limit ?? 20), 1), 200);
      const types = (query.types ?? []).map((slug) => slug.trim()).filter(Boolean);
      const authorId =
        query.authorId ??
        (query.authorUsername ? await resolveAuthorId(siteId, query.authorUsername) : undefined);
      if (query.authorUsername && !authorId) return [];

      const db = await getDb();
      const params: (string | number)[] = [siteId];
      let sql = "SELECT * FROM content WHERE site_id = ? AND status = 'published'";
      if (types.length) {
        sql += ` AND type IN (${types.map(() => "?").join(", ")})`;
        params.push(...types);
      }
      const defaultLocale = query.locale && query.fallback ? await getDefaultLocale(siteId) : null;
      if (query.locale && defaultLocale && defaultLocale !== query.locale) {
        sql += " AND locale IN (?, ?)";
        params.push(query.locale, defaultLocale);
      } else if (query.locale) {
        sql += " AND locale = ?";
        params.push(query.locale);
      }
      if (authorId) {
        sql += " AND author_id = ?";
        params.push(authorId);
      }
      // Over-fetch so scheduled/expired rows dropped in JS still leave a full page.
      sql += " ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?";
      params.push(Math.min(limit * 3, 600));

      const rows = await db.query<Record<string, unknown>>(sql, params);
      const now = Date.now();
      const visible = rows
        .map((row) => serializeContentRow(row))
        .filter((entry) => {
          if (!query.includeScheduled && entry.publishedAt) {
            const published = Date.parse(entry.publishedAt);
            if (!Number.isNaN(published) && published > now) return false;
          }
          const expiry = expiryTimestamp(entry.fields);
          return expiry === null || expiry > now;
        });
      const entries = (defaultLocale ? preferLocale(visible, query.locale!) : visible).slice(0, limit);

      const names = await authorNames(
        siteId,
        entries.map((entry) => entry.authorId ?? ""),
      );

      return entries.map<PluginPublishedEntry>((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        slug: entry.slug,
        locale: entry.locale,
        translationGroupId: entry.translationGroupId ?? entry.id,
        excerpt: entry.excerpt,
        fields: entry.fields,
        authorId: entry.authorId,
        authorName: (entry.authorId && names.get(entry.authorId)) || null,
        publishedAt: entry.publishedAt,
        updatedAt: entry.updatedAt,
        createdAt: entry.createdAt,
      }));
    },

    async ensureType(input) {
      const siteId = pluginCallSiteId(activatedSiteId);
      const slug = normalizeContentTypeSlug(ContentTypeSlugSchema.parse(input.slug));
      if (isBuiltinContentTypeSlug(slug)) {
        throw new Error(`Cannot recreate a built-in content type "${slug}"`);
      }
      const existing = await getContentTypeBySlug(slug, siteId);
      if (existing) {
        await rememberPluginContentType(pluginId, siteId, slug);
        return { created: false, id: existing.id, slug: existing.slug };
      }
      const fields = ContentTypeFieldsSchema.parse(input.fields ?? []);
      try {
        const created = await createContentType(siteId, {
          slug,
          label: input.label.trim(),
          description: input.description ?? "",
          fields,
        });
        await rememberPluginContentType(pluginId, siteId, slug);
        return { created: true, id: created.id, slug: created.slug };
      } catch (err) {
        const raced = await getContentTypeBySlug(slug, siteId);
        if (raced) {
          await rememberPluginContentType(pluginId, siteId, slug);
          return { created: false, id: raced.id, slug: raced.slug };
        }
        throw err;
      }
    },

    async ensurePage(input) {
      const siteId = pluginCallSiteId(activatedSiteId);
      const type = normalizeContentTypeSlug(ContentTypeSlugSchema.parse(input.type));
      const registered = await getContentTypeBySlug(type, siteId);
      if (!registered) {
        throw new Error(`Unknown content type "${type}"`);
      }
      const slug = slugify(input.slug || input.title);
      if (!slug) throw new Error("Page slug is required");
      const locale = await getDefaultLocale(siteId);
      const db = await getDb();
      const aliases = (input.aliases ?? [])
        .map((value) => slugify(value))
        .filter((value) => value && value !== slug);

      async function findId(candidate: string): Promise<string | undefined> {
        const rows = await db.query<{ id: string }>(
          "SELECT id FROM content WHERE site_id = ? AND type = ? AND slug = ? AND locale = ? LIMIT 1",
          [siteId, type, candidate, locale],
        );
        return rows[0]?.id;
      }

      let existingId = await findId(slug);
      for (const alias of aliases) {
        if (existingId) break;
        existingId = await findId(alias);
      }

      if (existingId) {
        const timestamp = now();
        try {
          await db.run(
            "UPDATE content SET title = ?, slug = ?, excerpt = ?, updated_at = ? WHERE id = ? AND site_id = ?",
            [input.title, slug, input.excerpt ?? null, timestamp, existingId, siteId],
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/unique|duplicate/i.test(message)) throw err;
          await db.run(
            "UPDATE content SET title = ?, excerpt = ?, updated_at = ? WHERE id = ? AND site_id = ?",
            [input.title, input.excerpt ?? null, timestamp, existingId, siteId],
          );
          await invalidateContentCache();
          return { created: false, id: existingId, slug };
        }
        await invalidateContentCache();
        return { created: false, id: existingId, slug };
      }

      if (input.create === false) {
        return { created: false, id: "", slug };
      }

      const { enforceQuota } = await import("../tenancy/quotas.js");
      const quota = await enforceQuota("content", siteId, 1);
      if (quota) throw new Error(quota.error);

      const status = input.status === "published" ? "published" : "draft";
      const id = randomUUID();
      const timestamp = now();
      try {
        await db.run(
          `INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, excerpt, blocks, fields, status, author_id, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            siteId,
            type,
            input.title,
            slug,
            locale,
            id,
            input.excerpt ?? null,
            JSON.stringify(sanitizeBlockDocument({ version: 1, blocks: [] })),
            JSON.stringify({}),
            status,
            null,
            status === "published" ? timestamp : null,
            timestamp,
            timestamp,
          ],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/unique|duplicate/i.test(message)) {
          const raced = await db.query<{ id: string }>(
            "SELECT id FROM content WHERE site_id = ? AND type = ? AND slug = ? AND locale = ? LIMIT 1",
            [siteId, type, slug, locale],
          );
          if (raced[0]) return { created: false, id: raced[0].id, slug };
        }
        throw err;
      }
      await invalidateContentCache();
      return { created: true, id, slug };
    },

    async deleteType(inputSlug) {
      const siteId = pluginCallSiteId(activatedSiteId);
      return deletePluginOwnedContentType(siteId, inputSlug);
    },

    deleteCreatedBy(userId) {
      return deleteRecordsCreatedBy(pluginCallSiteId(activatedSiteId), userId);
    },
  };
}

export function contentTypeSlugsFromManifest(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)["contentTypes"];
  if (!Array.isArray(raw)) return [];
  const slugs: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const parsed = ContentTypeSlugSchema.safeParse(normalizeContentTypeSlug(item));
    if (!parsed.success || isBuiltinContentTypeSlug(parsed.data)) continue;
    if (!slugs.includes(parsed.data)) slugs.push(parsed.data);
  }
  return slugs;
}

async function rememberPluginContentType(pluginId: string, siteId: string, slug: string): Promise<void> {
  const current = (await getPluginHostItem<string[]>(pluginId, siteId, PLUGIN_HOST_CONTENT_TYPES_ITEM)) ?? [];
  if (current.includes(slug)) return;
  await setPluginHostItem(pluginId, siteId, PLUGIN_HOST_CONTENT_TYPES_ITEM, [...current, slug]);
}

/** Delete every CMS entry of this type, then the type. Refuses built-in slugs. */
export async function deletePluginOwnedContentType(
  siteId: string,
  slugInput: string,
): Promise<{ pages: number; typeDeleted: boolean }> {
  const slug = normalizeContentTypeSlug(ContentTypeSlugSchema.parse(slugInput));
  if (isBuiltinContentTypeSlug(slug)) {
    throw new Error(`Cannot delete a built-in content type "${slug}"`);
  }
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    "SELECT id FROM content WHERE site_id = ? AND type = ?",
    [siteId, slug],
  );
  const contentIds = new Set(rows.map((row) => row.id));
  await clearHomePagesIfMatch(siteId, contentIds);
  await clearBlogPagesIfMatch(siteId, contentIds);
  await clearErrorPagesIfMatch(siteId, contentIds);
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(", ");
    await db.run(
      `DELETE FROM revisions WHERE site_id = ? AND content_id IN (${placeholders})`,
      [siteId, ...rows.map((row) => row.id)],
    );
  }
  await db.run("DELETE FROM content WHERE site_id = ? AND type = ?", [siteId, slug]);
  const existing = await getContentTypeBySlug(slug, siteId);
  let typeDeleted = false;
  if (existing && !existing.builtin) {
    await db.run("DELETE FROM content_types WHERE site_id = ? AND slug = ?", [siteId, slug]);
    typeDeleted = true;
  }
  if (rows.length > 0 || typeDeleted) {
    await invalidateContentCache();
  }
  return { pages: rows.length, typeDeleted };
}
