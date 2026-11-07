// SPDX-License-Identifier: MIT
import { contentTypePolicy, publicContentTypeSql } from "@justflows/content";
import { getDb } from "../database/db.js";
import { serializeContentRow } from "./content-api.js";
import { getVisibilityScope } from "./visibility-scope.js";
export interface ContentQueryOptions { contentType: string; taxonomy: string; term: string; orderBy: string; order: string; limit: number; offset: number }
/** Bounded, published and discoverable content only, in this site's exact locale. */
export async function queryPublishedContent(siteId: string, locale: string, options: ContentQueryOptions) {
  if (options.contentType && !contentTypePolicy(options.contentType).publiclyDiscoverable) return { items: [], total: 0 };
  const db = await getDb();
  const params: (string | number)[] = [siteId, locale];
  let where = `c.site_id = ? AND c.locale = ? AND c.trashed_at IS NULL AND c.status = 'published' AND (c.published_at IS NULL OR c.published_at <= CURRENT_TIMESTAMP) AND ${publicContentTypeSql("c.type")}`;
  const visible = (await getVisibilityScope(siteId)).sql("c");
  where += ` AND ${visible.sql}`;
  params.push(...visible.params);
  if (options.contentType) { where += ' AND c.type = ?'; params.push(options.contentType); }
  if (options.taxonomy || options.term) {
    where += ' AND EXISTS (SELECT 1 FROM content_terms ct JOIN terms t ON t.id = ct.term_id JOIN taxonomies x ON x.id = t.taxonomy_id WHERE ct.content_id = c.id AND t.site_id = c.site_id AND x.site_id = c.site_id';
    if (options.taxonomy) { where += ' AND x.slug = ?'; params.push(options.taxonomy); }
    if (options.term) { where += ' AND t.slug = ?'; params.push(options.term); }
    where += ')';
  }
  const sort = options.orderBy === 'title' ? 'c.title' : options.orderBy === 'updated' ? 'c.updated_at' : 'c.published_at';
  const direction = options.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit) || 6));
  const offset = Math.min(10000, Math.max(0, Math.trunc(options.offset) || 0));
  const rows = await db.query<Record<string, unknown>>(`SELECT c.* FROM content c WHERE ${where} ORDER BY ${sort} ${direction}, c.id ${direction} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const counts = await db.query<{ total: number }>(`SELECT COUNT(*) AS total FROM content c WHERE ${where}`, params);
  return { items: rows.map(serializeContentRow).filter(item => contentTypePolicy(item.type).publiclyDiscoverable), total: Number(counts[0]?.total ?? 0) };
}
