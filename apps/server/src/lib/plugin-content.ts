// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { PluginContentApi } from "@justflows/sdk";
import {
  ContentTypeFieldsSchema,
  ContentTypeSlugSchema,
  isBuiltinContentTypeSlug,
  normalizeContentTypeSlug,
} from "@justflows/content";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { getDb } from "./db.js";
import { createContentType, getContentTypeBySlug } from "./content-types-db.js";
import { getDefaultLocale } from "./i18n/languages-db.js";
import { clearHomePageIfMatches } from "./home-page.js";
import { clearBlogPageIfMatches } from "./blog-page.js";
import { invalidateContentCache } from "./content-public.js";
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

export function createPluginContentApi(pluginId: string, siteId: string): PluginContentApi {
  return {
    async ensureType(input) {
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
      return deletePluginOwnedContentType(siteId, inputSlug);
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
  for (const row of rows) {
    await clearHomePageIfMatches(siteId, row.id);
    await clearBlogPageIfMatches(siteId, row.id);
  }
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
