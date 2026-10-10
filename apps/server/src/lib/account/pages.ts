// SPDX-License-Identifier: MIT

import { getDb } from "../database/db.js";
import { serializeContentRow } from "../content/content-api.js";
import { createContentPermalinkResolver, getPermalinkState } from "../navigation/permalinks-db.js";

/** Private layout records are never read from a shared content cache. */
export async function accountPages(siteId: string) {
  const db = await getDb();
  const rows: Record<string, unknown>[] = [];
  let cursor = "";
  for (;;) {
    const batch = await db.query<Record<string, unknown>>(
      `SELECT id, site_id, type, status, slug, title, locale, translation_group_id, author_id, published_at, created_at, updated_at FROM content
       WHERE site_id = ? AND type = 'account' AND trashed_at IS NULL${cursor ? " AND id > ?" : ""} ORDER BY id LIMIT 200`, cursor ? [siteId, cursor] : [siteId]);
    rows.push(...batch);
    if (batch.length < 200) break;
    cursor = String(batch[batch.length - 1]!.id);
  }
  rows.sort((a, b) => new Date(String(a.created_at)).getTime() - new Date(String(b.created_at)).getTime() || String(a.id).localeCompare(String(b.id)));
  if (!rows.length) return [];
  const state = await getPermalinkState(siteId);
  const aliases = new Map<string, string[]>();
  for (const [url, id] of Object.entries(state.redirects)) {
    const paths = aliases.get(id) ?? []; paths.push(url); aliases.set(id, paths);
  }
  const resolve = await createContentPermalinkResolver(siteId, { state });
  const pages = [];
  for (const row of rows) {
    const content = serializeContentRow(row);
    pages.push({ content, url: await resolve(content), aliases: aliases.get(content.id) ?? [] });
  }
  return pages;
}

export async function accountHomeUrl(siteId: string): Promise<string> {
  const pages = await accountPages(siteId);
  return pages.find(page => page.content.status === "published")?.url ?? "/account";
}

export async function accountPageExclusions(siteId: string) {
  return (await accountPages(siteId)).flatMap(page => {
    return [page.url, ...page.aliases].flatMap(url => {
      const path = url.split("?")[0]!.replace(/\/$/, "");
      return [{ path, match: "exact" as const }, { path: `${path}/page`, match: "prefix" as const }];
    });
  });
}
