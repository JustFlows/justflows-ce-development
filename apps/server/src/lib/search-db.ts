// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractPlainText } from "@justflows/blocks";
import { searchTokens, searchHighlight, type SearchQuery } from "@justflows/content";
import type { SearchBackend, SearchDocument } from "@justflows/sdk";
import { getDb } from "./db.js";
import { getRuntimeHooks } from "./plugin-runtime.js";
import { getSiteSetting, setSiteSetting } from "./site-settings.js";
import { serializeContentRow } from "./content-api.js";
import { contentPermalink } from "./permalinks-db.js";

export const SearchSettingsSchema = z.object({
  publicTypes: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .max(60),
    )
    .max(100)
    .default(["page", "post", "product"]),
  queryLogging: z.boolean().default(false),
});
export async function getSearchSettings(siteId: string) {
  return SearchSettingsSchema.parse((await getSiteSetting(siteId, "search")) ?? {});
}
export async function saveSearchSettings(siteId: string, value: unknown) {
  const settings = SearchSettingsSchema.parse(value);
  await setSiteSetting(siteId, "search", settings);
  return settings;
}

/** Only visible text properties are indexed, never arbitrary content fields or form data. */
export function searchBody(value: unknown): string {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "";
    }
  }
  const text: string[] = [];
  const keys = new Set([
    "text",
    "content",
    "html",
    "heading",
    "subheading",
    "title",
    "description",
    "caption",
    "quote",
    "buttonLabel",
  ]);
  let size = 0;
  let visited = 0;
  function visit(node: unknown, depth: number) {
    if (!node || typeof node !== "object" || depth > 30 || size >= 100_000 || ++visited > 10_000)
      return;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (typeof child === "string" && size < 100_000) {
          const part = extractPlainText(child).slice(0, 100_000 - size);
          text.push(part);
          size += part.length;
        } else visit(child, depth + 1);
      }
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      if (keys.has(key) && typeof item === "string") {
        const part = extractPlainText(item).slice(0, 100_000 - size);
        text.push(part);
        size += part.length;
      } else if (["blocks", "children", "props", "items"].includes(key)) visit(item, depth + 1);
    }
  }
  visit(value, 0);
  return text.join(" ");
}
async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Search backend timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function backend(siteId: string): Promise<SearchBackend | null> {
  return withDeadline(
    getRuntimeHooks().applyFilter("search.backend", null, { siteId }, { siteId }),
  );
}

/** Lock the source row so a rebuild cannot overwrite a newer incremental update. */
export async function indexSearchContent(
  siteId: string,
  id: string,
  localOnly = false,
): Promise<void> {
  const db = await getDb();
  let engine: SearchBackend | null = null;
  let externalFailed = false;
  if (!localOnly) {
    try {
      engine = await backend(siteId);
    } catch {
      externalFailed = true;
    }
  }
  await db.transaction(async (tx) => {
    const [row] = await tx.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE site_id = ? AND id = ? FOR UPDATE",
      [siteId, id],
    );
    if (!row) {
      await tx.run("DELETE FROM search_documents WHERE site_id = ? AND content_id = ?", [
        siteId,
        id,
      ]);
      if (engine) {
        try {
          await withDeadline(engine.remove(id, siteId));
        } catch {
          externalFailed = true;
        }
      }
      return;
    }
    const doc: SearchDocument = {
      id,
      siteId,
      locale: String(row.locale),
      type: String(row.type),
      title: String(row.title ?? ""),
      slug: String(row.slug ?? ""),
      summary: extractPlainText(String(row.excerpt ?? "")),
      body: searchBody(row.blocks),
    };
    const values = [id, siteId, doc.title, doc.slug, doc.summary, doc.body];
    const conflict =
      process.env.DB_DRIVER === "postgres"
        ? "ON CONFLICT (content_id) DO UPDATE SET title = EXCLUDED.title, slug = EXCLUDED.slug, summary = EXCLUDED.summary, body = EXCLUDED.body, indexed_at = CURRENT_TIMESTAMP"
        : "ON DUPLICATE KEY UPDATE title = VALUES(title), slug = VALUES(slug), summary = VALUES(summary), body = VALUES(body), indexed_at = CURRENT_TIMESTAMP";
    await tx.run(
      `INSERT INTO search_documents (content_id, site_id, title, slug, summary, body) VALUES (?, ?, ?, ?, ?, ?) ${conflict}`,
      values,
    );
    // External services never receive draft/private/trashed content or working revisions.
    if (engine) {
      try {
        const settings = await getSearchSettings(siteId);
        if (
          row.status === "published" &&
          !row.trashed_at &&
          settings.publicTypes.includes(doc.type) &&
          (!row.published_at || new Date(String(row.published_at)).getTime() <= Date.now())
        )
          await withDeadline(engine.upsert(doc));
        else await withDeadline(engine.remove(id, siteId));
      } catch {
        externalFailed = true;
      }
    }
    if (externalFailed) {
      // Commit the current local document, but leave it eligible for retry.
      await tx.run(
        "UPDATE search_documents SET indexed_at = ? WHERE content_id = ? AND site_id = ?",
        ["1970-01-01 00:00:00", id, siteId],
      );
    }
  });
  if (externalFailed) throw new Error("External search indexing failed");
}

const rebuilding = new Map<string, Promise<number>>();
export function rebuildSearchIndex(
  siteId: string,
  staleOnly = false,
  localOnly = false,
): Promise<number> {
  const existing = rebuilding.get(siteId);
  if (existing) return existing;
  const task = (async () => {
    const db = await getDb();
    let cursor = "";
    let count = 0;
    let failures = 0;
    for (;;) {
      const rows = await db.query<{ id: string }>(
        `SELECT c.id FROM content c LEFT JOIN search_documents d ON d.content_id = c.id
         WHERE c.site_id = ? ${cursor ? "AND c.id > ?" : ""}
         ${staleOnly ? `AND (d.content_id IS NULL OR c.updated_at >= ${process.env.DB_DRIVER === "postgres" ? "date_trunc('second', d.indexed_at)" : "d.indexed_at"})` : ""}
         ORDER BY c.id LIMIT 100`,
        cursor ? [siteId, cursor] : [siteId],
      );
      if (!rows.length) {
        if (failures) throw new Error(`Search rebuild failed for ${failures} entries`);
        return count;
      }
      for (const row of rows) {
        try {
          await indexSearchContent(siteId, row.id, localOnly);
          count++;
        } catch {
          failures++;
        }
      }
      cursor = rows[rows.length - 1]!.id;
    }
  })().finally(() => rebuilding.delete(siteId));
  rebuilding.set(siteId, task);
  return task;
}

let installed = false;
export async function startSearchIndex(siteId: string): Promise<void> {
  if (installed) return;
  installed = true;
  const hooks = getRuntimeHooks();
  for (const event of [
    "content.created",
    "content.updated",
    "content.published",
    "content.unpublished",
    "content.deleted",
  ] as const) {
    hooks.action<{ siteId: string; contentId: string }>(
      event,
      ({ siteId, contentId }) => indexSearchContent(siteId, contentId),
      { id: `core.search.${event}` },
    );
  }
  // A plugin outage must never prevent the host or its local index from booting.
  await rebuildSearchIndex(siteId, true, true);
  if (hooks.has("search.backend")) {
    void rebuildSearchIndex(siteId).catch(() =>
      console.error("[justflows] External search backfill failed"),
    );
  }
  // Repairs writes from import/restore and interrupted or failed hook delivery.
  const timer = setInterval(() => {
    void rebuildSearchIndex(siteId, true).catch(() =>
      console.error("[justflows] Search index reconciliation failed"),
    );
  }, 60_000);
  timer.unref();
}

export interface SearchAccess {
  /** Undefined means public search. Callers must authorize admin access first. */
  admin?: {
    ownerId?: string;
    types?: readonly string[];
    locales?: readonly string[];
    status?: string;
  };
}

export async function searchContent(siteId: string, query: SearchQuery, access: SearchAccess = {}) {
  const started = performance.now();
  const db = await getDb();
  const settings = await getSearchSettings(siteId);
  const tokens = searchTokens(query.q);
  const empty = {
    items: [],
    total: 0,
    page: query.page,
    limit: query.limit,
    hasMore: false,
    backend: "database",
    typoTolerance: false,
  };
  if (!tokens.length) return empty;
  const params: (string | number | boolean | null)[] = [siteId];
  let where = "c.site_id = ? AND c.trashed_at IS NULL";
  const add = (sql: string, value: string) => {
    where += ` AND ${sql}`;
    params.push(value);
  };
  const inList = (column: string, values: readonly string[]) => {
    if (!values.length) {
      where += " AND 1 = 0";
      return;
    }
    where += ` AND ${column} IN (${values.map(() => "?").join(",")})`;
    params.push(...values);
  };
  if (!access.admin) {
    where +=
      " AND c.status = 'published' AND (c.published_at IS NULL OR c.published_at <= CURRENT_TIMESTAMP)";
    inList("c.type", settings.publicTypes);
  } else {
    if (access.admin.ownerId) add("c.author_id = ?", access.admin.ownerId);
    if (access.admin.types) inList("c.type", access.admin.types);
    if (access.admin.locales) inList("c.locale", access.admin.locales);
    if (access.admin.status) add("c.status = ?", access.admin.status);
  }
  if (query.locale) add("c.locale = ?", query.locale);
  if (query.type) add("c.type = ?", query.type);
  if (query.after) add("c.published_at >= ?", query.after);
  if (query.before)
    add(
      "c.published_at < ?",
      new Date(Date.parse(query.before) + 86_400_000).toISOString().slice(0, 10),
    );
  if (query.taxonomy || query.term) {
    where += ` AND EXISTS (SELECT 1 FROM content_terms ct JOIN terms t ON t.id = ct.term_id JOIN taxonomies x ON x.id = t.taxonomy_id WHERE ct.content_id = c.id AND t.site_id = c.site_id AND x.site_id = c.site_id`;
    if (query.taxonomy) {
      where += " AND x.slug = ?";
      params.push(query.taxonomy);
    }
    if (query.term) {
      where += " AND t.slug = ?";
      params.push(query.term);
    }
    where += ")";
  }
  // Admin always uses the local index, including unpublished rows.
  const engine = access.admin ? null : await backend(siteId);
  let rank: string;
  let rankParams: string[];
  if (engine) {
    const ids = [
      ...new Set(
        await withDeadline(
          engine.search({ siteId, q: tokens.join(" "), locale: query.locale ?? "", limit: 1000 }),
        ),
      ),
    ]
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, 1000);
    inList("c.id", ids);
    rank = ids.length
      ? `CASE c.id ${ids.map((_, i) => `WHEN ? THEN ${ids.length - i}`).join(" ")} ELSE 0 END`
      : "0";
    rankParams = ids;
  } else if (process.env.DB_DRIVER === "postgres") {
    const q = tokens.map((token) => `${token}:*`).join(" & ");
    where += " AND d.search_vector @@ to_tsquery('simple', ?)";
    params.push(q);
    rank = "ts_rank(d.search_vector, to_tsquery('simple', ?))";
    rankParams = [q];
  } else {
    const q = tokens.map((t) => `+${t}*`).join(" ");
    where += " AND MATCH(d.title, d.slug, d.summary, d.body) AGAINST (? IN BOOLEAN MODE)";
    params.push(q);
    rank =
      "8 * MATCH(d.title) AGAINST (? IN BOOLEAN MODE) + 4 * MATCH(d.slug) AGAINST (? IN BOOLEAN MODE) + 2 * MATCH(d.summary) AGAINST (? IN BOOLEAN MODE) + MATCH(d.title, d.slug, d.summary, d.body) AGAINST (? IN BOOLEAN MODE)";
    rankParams = [q, q, q, q];
  }
  const from = `FROM content c JOIN search_documents d ON d.content_id = c.id AND d.site_id = c.site_id WHERE ${where}`;
  const [count] = await db.query<{ total: number }>(`SELECT COUNT(*) AS total ${from}`, params);
  const total = Number(count?.total ?? 0);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT c.*, d.summary AS search_summary, d.body AS search_body, ${rank} AS search_rank ${from} ORDER BY search_rank DESC, c.id ASC LIMIT ? OFFSET ?`,
    [...rankParams, ...params, String(query.limit), String((query.page - 1) * query.limit)],
  );
  const items = await Promise.all(
    rows.map(async (row) => {
      const content = serializeContentRow(row);
      const source = String(row.search_summary || row.search_body || "");
      const first = Math.min(
        ...tokens.map((t) => source.toLowerCase().indexOf(t)).filter((n) => n >= 0),
      );
      const start = Number.isFinite(first) ? Math.max(0, first - 60) : 0;
      const excerpt = `${start ? "…" : ""}${source.slice(start, start + 240)}${source.length > start + 240 ? "…" : ""}`;
      return {
        id: content.id,
        type: content.type,
        locale: content.locale,
        title: content.title,
        slug: content.slug,
        status: content.status,
        updatedAt: content.updatedAt,
        publishedAt: content.publishedAt,
        url: await contentPermalink(content),
        excerpt,
        highlights: {
          title: searchHighlight(content.title, query.q),
          excerpt: searchHighlight(excerpt, query.q),
        },
      };
    }),
  );
  if (!access.admin && settings.queryLogging) {
    await db.run(
      "INSERT INTO search_metrics (id, site_id, token_count, result_count, duration_ms) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), siteId, tokens.length, total, Math.round(performance.now() - started)],
    );
  }
  return {
    items,
    total,
    page: query.page,
    limit: query.limit,
    hasMore: query.page * query.limit < total,
    backend: engine?.id ?? "database",
    typoTolerance: engine?.typoTolerance === true,
  };
}
