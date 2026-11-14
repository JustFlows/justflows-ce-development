// SPDX-License-Identifier: MIT

import { getDb } from "../database/db.js";
import { getSiteSetting } from "../settings/site-settings.js";

/**
 * Where block documents reference a shared item: a reusable block (`ref`) or
 * a style preset (`styleRef`), for the impact summaries of justflows-ce#301
 * and #304.
 *
 * Each table is read once with a coarse, bounded `LIKE` on the id after a quote,
 * then every candidate is parsed and walked so only an exact match on the
 * right prop counts. The coarse filter works on every driver: JSON columns
 * are compared as text (PostgreSQL's `jsonb::text` adds spaces after colons,
 * so the needle is only the quoted id), and the exact check happens here.
 */

/** Rows scanned per table at most; usage beyond this is reported as a lower bound. */
export const REFERENCE_SCAN_LIMIT = 500;

export interface ReferencedContent {
  id: string;
  title: string;
  type: string;
  locale: string;
  status: string;
  authorId: string | null;
}

export interface BlockReferenceUsage {
  content: ReferencedContent[];
  templateParts: string[];
  templates: string[];
  menus: string[];
  reusableBlocks: string[];
  patterns: string[];
  /** True when a table had more candidates than were scanned. */
  truncated: boolean;
}

export type ReferenceProp = "ref" | "styleRef";

function jsonText(column: string): string {
  return process.env.DB_DRIVER === "postgres" ? `CAST(${column} AS TEXT)` : `CAST(${column} AS CHAR)`;
}

/** Unwrap a value stored as JSON text, possibly encoded more than once (bounded). */
function parse(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 3 && typeof current === "string"; i++) {
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  return typeof current === "string" ? null : current;
}

/**
 * Whether a stored value holds a block that references `id` through `prop`.
 * For `ref`, only `core.reusable` blocks count. Walks any JSON shape, since
 * documents, header libraries and menus nest blocks differently.
 */
export function mentionsReference(value: unknown, prop: ReferenceProp, id: string, depth = 0): boolean {
  if (depth > 64 || value === null || value === undefined) return false;
  const data = typeof value === "string" ? parse(value) : value;
  if (Array.isArray(data)) return data.some((item) => mentionsReference(item, prop, id, depth + 1));
  if (!data || typeof data !== "object") return false;
  const node = data as Record<string, unknown>;
  const props = node.props as Record<string, unknown> | undefined;
  if (props && typeof props === "object" && props[prop] === id && (prop !== "ref" || node.type === "core.reusable")) return true;
  return Object.values(node).some((child) => typeof child === "object" && mentionsReference(child, prop, id, depth + 1));
}

export async function findBlockReferences(siteId: string, prop: ReferenceProp, id: string): Promise<BlockReferenceUsage> {
  const db = await getDb();
  /**
   * Opening quote plus the id: matches `"cta"` in a JSON column and `\"cta\"`
   * in a document stored as a JSON-encoded string (PostgreSQL content, some
   * MySQL drafts). Coarse on purpose; the exact check below decides.
   */
  const like = `%"${id}%`;
  const limit = REFERENCE_SCAN_LIMIT + 1;
  let truncated = false;
  const capped = <T>(rows: T[]): T[] => {
    if (rows.length > REFERENCE_SCAN_LIMIT) {
      truncated = true;
      return rows.slice(0, REFERENCE_SCAN_LIMIT);
    }
    return rows;
  };

  const contentRows = capped(
    await db.query<{ id: string; title: string; type: string; locale: string; status: string; author_id: string | null; blocks: unknown }>(
      `SELECT id, title, type, locale, status, author_id, blocks FROM content WHERE site_id = ? AND trashed_at IS NULL AND ${jsonText("blocks")} LIKE ? ORDER BY title LIMIT ${limit}`,
      [siteId, like],
    ),
  );
  const content = contentRows
    .filter((row) => mentionsReference(row.blocks, prop, id))
    .map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      type: String(row.type),
      locale: String(row.locale ?? ""),
      status: String(row.status),
      authorId: row.author_id ? String(row.author_id) : null,
    }));

  const parts = capped(
    await db.query<{ part: string; doc: unknown; draft_doc: unknown }>(
      `SELECT part, doc, draft_doc FROM template_parts WHERE site_id = ? AND (${jsonText("doc")} LIKE ? OR ${jsonText("draft_doc")} LIKE ?) ORDER BY part LIMIT ${limit}`,
      [siteId, like, like],
    ),
  );
  const templates = capped(
    await db.query<{ slug: string; doc: unknown; draft_doc: unknown }>(
      `SELECT slug, doc, draft_doc FROM theme_templates WHERE site_id = ? AND (${jsonText("doc")} LIKE ? OR ${jsonText("draft_doc")} LIKE ?) ORDER BY slug LIMIT ${limit}`,
      [siteId, like, like],
    ),
  );
  const menus = capped(
    await db.query<{ slug: string; items: unknown }>(
      `SELECT slug, items FROM menus WHERE site_id = ? AND trashed_at IS NULL AND ${jsonText("items")} LIKE ? ORDER BY slug LIMIT ${limit}`,
      [siteId, like],
    ),
  );
  const reusable = await getSiteSetting<unknown[]>(siteId, "reusable_blocks");
  const patterns = await getSiteSetting<unknown[]>(siteId, "block_patterns");
  const idOf = (item: unknown) => String((item as { id?: unknown })?.id ?? "");

  return {
    content,
    templateParts: parts.filter((row) => mentionsReference(row.doc, prop, id) || mentionsReference(row.draft_doc, prop, id)).map((row) => String(row.part)),
    templates: [...new Set(templates.filter((row) => mentionsReference(row.doc, prop, id) || mentionsReference(row.draft_doc, prop, id)).map((row) => String(row.slug)))],
    menus: menus.filter((row) => mentionsReference(row.items, prop, id)).map((row) => String(row.slug)),
    /** A reusable block's own entry is the source, not a use. */
    reusableBlocks: (Array.isArray(reusable) ? reusable : []).filter((item) => idOf(item) !== id && mentionsReference(item, prop, id)).map(idOf),
    patterns: (Array.isArray(patterns) ? patterns : []).filter((item) => idOf(item) !== id && mentionsReference(item, prop, id)).map(idOf),
    truncated,
  };
}
