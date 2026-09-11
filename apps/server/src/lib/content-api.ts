import type { BlockDocument } from "./types.js";

export interface ContentLiveSnapshotResponse {
  title: string;
  slug: string;
  excerpt: string | null;
  blocks: BlockDocument;
  fields: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

export interface ContentWorkingMeta {
  id: string;
  source: string;
  baseVersion: number;
  updatedAt: string;
  updatedBy: string | null;
  updatedByName: string | null;
}

export interface ContentResponse {
  id: string;
  siteId: string;
  type: string;
  title: string;
  slug: string;
  locale: string;
  translationGroupId: string | null;
  excerpt: string | null;
  status: string;
  blocks: BlockDocument;
  fields: Record<string, unknown>;
  authorId: string | null;
  publishOn?: string | null;
  unpublishOn?: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  hasWorkingRevision: boolean;
  workingRevision: ContentWorkingMeta | null;
  liveChangedSinceWorking: boolean;
  live: ContentLiveSnapshotResponse | null;
}

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export function normalizeBlocks(value: unknown): BlockDocument {
  const parsed = parseJson(value);

  if (Array.isArray(parsed)) {
    return { version: 1, blocks: parsed as BlockDocument["blocks"] };
  }

  if (parsed && typeof parsed === "object" && "blocks" in parsed) {
    const doc = parsed as { version?: number; blocks?: unknown };
    const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
    return { version: 1, blocks: blocks as BlockDocument["blocks"] };
  }

  return { version: 1, blocks: [] };
}

export function normalizeFields(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function toIsoTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

/** Map a raw DB row to a stable JSON shape for the admin UI. */
export function serializeContentRow(row: Record<string, unknown>): ContentResponse {
  return {
    id: String(row.id),
    siteId: String(row.site_id),
    type: String(row.type),
    title: String(row.title),
    slug: String(row.slug),
    locale: String(row.locale ?? "en-US"),
    translationGroupId:
      row.translation_group_id == null ? null : String(row.translation_group_id),
    excerpt: row.excerpt == null ? null : String(row.excerpt),
    status: String(row.status),
    blocks: normalizeBlocks(row.blocks),
    fields: normalizeFields(row.fields),
    authorId: row.author_id == null ? null : String(row.author_id),
    publishOn: toIsoTimestamp(row.publish_on),
    unpublishOn: toIsoTimestamp(row.unpublish_on),
    publishedAt: toIsoTimestamp(row.published_at),
    createdAt: toIsoTimestamp(row.created_at) ?? "",
    updatedAt: toIsoTimestamp(row.updated_at) ?? "",
    version: Number(row.version ?? 1) || 1,
    hasWorkingRevision: Boolean(row.has_working_revision ?? row.working_revision_id),
    workingRevision: null,
    liveChangedSinceWorking: false,
    live: null,
  };
}
