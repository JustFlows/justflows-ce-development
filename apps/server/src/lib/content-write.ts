// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PermalinkConflictError,
  rememberContentPermalink,
  uniquePermalinkSlug,
} from "./permalinks-db.js";
import { getDb } from "./db.js";
import { serializeContentRow } from "./content-api.js";
import {
  applySnapshotToContent,
  archiveThenDeleteWorking,
  deleteRevisionById,
  getWorkingRevision,
  insertHistoricalIfChanged,
  pruneHistoricalForContent,
  revisionToSnapshot,
  rowToSnapshot,
  serializeEditorContent,
  upsertWorkingRevision,
  RevisionConflictError,
} from "./content-revisions.js";
import { snapshotsEqual, type ContentSnapshot } from "@justflows/content";
import { resolveContentLocale } from "./i18n/languages-db.js";
import { invalidateContentCache } from "./content-public.js";
import { getRuntimeHooks } from "./plugin-runtime.js";
import { isHookAbortError } from "@justflows/core";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { defaultBlocksForContentType, isEmptyBlockDocument } from "./default-content-blocks.js";
import { getContentTypeBySlug } from "./content-types-db.js";
import { auditLog } from "./audit-log.js";
import { ContentTypeSlugSchema } from "@justflows/content";

/**
 * Shared content write logic — the single implementation behind both the
 * cookie-authenticated admin routes (`routes/content.ts`) and the federated
 * management API (`routes/manage-api/content.ts`). Capability and scope checks
 * stay with the callers, which supply different actors (a session vs an API
 * key); everything that mutates a row lives here.
 */

export const CreateContentSchema = z.object({
  type: ContentTypeSlugSchema.default("post"),
  title: z.string().min(1),
  slug: z.string().optional(),
  excerpt: z.string().optional(),
  locale: z.string().optional(),
  translationGroupId: z.string().uuid().optional(),
  blocks: z.object({ version: z.literal(1), blocks: z.array(z.unknown()) }).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type CreateContentInput = z.infer<typeof CreateContentSchema>;

export const PatchContentSchema = z
  .object({
    title: z.string().optional(),
    slug: z.string().optional(),
    excerpt: z.string().nullable().optional(),
    blocks: z.unknown().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    expectedVersion: z.number().int().positive().optional(),
    source: z.enum(["manual", "autosave", "import", "api"]).optional(),
  })
  .passthrough();
export type PatchContentInput = z.infer<typeof PatchContentSchema>;

export type ContentActor = { siteId: string; userId: string; role: string };

/** The minimal response surface the row helpers write to (an Express `res`). */
export type WriteResponse = {
  json: (body: unknown) => void;
  status: (code: number) => { json: (body: unknown) => void };
};

async function auditScheduleOverride(row: Record<string, unknown>, actor: ContentActor, preserveExpiry = false): Promise<void> {
  if (!row.publish_on && (preserveExpiry || !row.unpublish_on)) return;
  await auditLog({ siteId: actor.siteId, target: String(row.id), actorId: actor.userId, actorRole: actor.role,
    action: preserveExpiry && row.unpublish_on ? "content.schedule_changed" : "content.schedule_cancelled",
    detail: "Schedule superseded by a manual content transition" });
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 200);
}

export function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export function hookCtx(actor: ContentActor) {
  return {
    siteId: actor.siteId,
    source: "http" as const,
    actor: { userId: actor.userId, role: actor.role },
  };
}

export function translationGroupOf(
  row: { id?: unknown; translation_group_id?: unknown },
  fallbackId: string,
): string {
  return row.translation_group_id ? String(row.translation_group_id) : fallbackId;
}

export function contentHookRef(
  contentId: string,
  siteId: string,
  extras: { type?: string; translationGroupId?: string; lastInTranslationGroup?: boolean } = {},
) {
  return {
    contentId,
    siteId,
    ...(extras.type ? { type: extras.type } : {}),
    ...(extras.translationGroupId ? { translationGroupId: extras.translationGroupId } : {}),
    ...(extras.lastInTranslationGroup !== undefined
      ? { lastInTranslationGroup: extras.lastInTranslationGroup }
      : {}),
  };
}

export function mergeSnapshot(
  base: ContentSnapshot,
  patch: {
    title?: string;
    slug?: string;
    excerpt?: string | null;
    blocks?: unknown;
    fields?: Record<string, unknown>;
  },
): ContentSnapshot {
  return {
    title: patch.title ?? base.title,
    slug: patch.slug ?? base.slug,
    excerpt: patch.excerpt !== undefined ? patch.excerpt : base.excerpt,
    blocks:
      patch.blocks !== undefined
        ? (sanitizeBlockDocument(patch.blocks) as ContentSnapshot["blocks"])
        : base.blocks,
    fields: patch.fields != null ? { ...base.fields, ...patch.fields } : base.fields,
  };
}

export async function saveWorkingRow(
  row: Record<string, unknown>,
  patch: {
    title?: string;
    slug?: string;
    excerpt?: string | null;
    blocks?: unknown;
    fields?: Record<string, unknown>;
    source?: "manual" | "autosave" | "import" | "api";
  },
  actor: ContentActor,
  res: WriteResponse,
): Promise<void> {
  const id = String(row.id);
  const working = await getWorkingRevision(id, actor.siteId);
  const base = working ? revisionToSnapshot(working) : rowToSnapshot(row);
  let proposed = mergeSnapshot(base, patch);
  const hooks = getRuntimeHooks();
  const ctx = hookCtx(actor);
  proposed = await hooks.applyFilter(
    "content.revision",
    proposed,
    { siteId: actor.siteId, contentId: id },
    ctx,
  );
  try {
    await hooks.dispatchGate(
      "content.beforeUpdate",
      { contentId: id, siteId: actor.siteId, revision: proposed, revisionId: working?.id },
      ctx,
    );
  } catch (err) {
    if (isHookAbortError(err)) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  let saved;
  try { saved = await upsertWorkingRevision(row, {
    snapshot: proposed,
    source: patch.source ?? "manual",
    actorId: actor.userId,
    baseVersion: Number(row.version ?? 1) || 1,
  }); } catch (err) {
    if (err instanceof RevisionConflictError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  if (saved) {
    await hooks.dispatchAction(
      "content.revisionSaved",
      { contentId: id, siteId: actor.siteId, revisionId: saved.id, source: saved.source },
      ctx,
    );
  }
  res.json(serializeEditorContent(row, saved));
}

export async function publishRow(
  row: Record<string, unknown>,
  patch: {
    title?: string;
    slug?: string;
    excerpt?: string | null;
    blocks?: unknown;
    fields?: Record<string, unknown>;
    expectedVersion?: number;
  },
  actor: ContentActor,
  res: WriteResponse,
): Promise<void> {
  const id = String(row.id);
  const siteId = actor.siteId;
  const liveVersion = Number(row.version ?? 1) || 1;
  if (patch.expectedVersion != null && patch.expectedVersion !== liveVersion) {
    res.status(409).json({
      error: `Version conflict: expected ${patch.expectedVersion}, got ${liveVersion}`,
      expectedVersion: patch.expectedVersion,
      actualVersion: liveVersion,
    });
    return;
  }

  const working = await getWorkingRevision(id, siteId);
  if (working && String(row.status) === "published" && working.baseVersion !== liveVersion) {
    res.status(409).json({
      error: `Live version changed since this draft was created (live ${liveVersion}, draft base ${working.baseVersion})`,
      expectedVersion: working.baseVersion,
      actualVersion: liveVersion,
    });
    return;
  }

  const base = working ? revisionToSnapshot(working) : rowToSnapshot(row);
  const proposed = mergeSnapshot(base, patch);
  const hooks = getRuntimeHooks();
  const ctx = hookCtx(actor);
  const contentRef = {
    contentId: id,
    siteId,
    revision: proposed,
    revisionId: working?.id,
  };

  try {
    await hooks.dispatchGate("content.beforeUpdate", contentRef, ctx);
    await hooks.dispatchGate("content.beforePublish", contentRef, ctx);
  } catch (err) {
    if (isHookAbortError(err)) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const publishedAt = serializeContentRow(row).publishedAt ?? new Date().toISOString();
  const nextContent = { ...serializeContentRow(row), ...proposed, status: "published", publishedAt };
  try {
    proposed.slug = await uniquePermalinkSlug(nextContent);
    nextContent.slug = proposed.slug;
  } catch (err) {
    if (err instanceof PermalinkConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
  let historicalId: string | null = null;
  historicalId = await insertHistoricalIfChanged(row, actor.userId);

  try {
    const applied = await applySnapshotToContent(id, siteId, proposed, {
      status: "published",
      publishedAt,
      expectedVersion: liveVersion,
    });
    if (!applied) {
      if (historicalId) await deleteRevisionById(historicalId, siteId);
      res.status(409).json({
        error: "Version conflict while publishing",
        expectedVersion: liveVersion,
      });
      return;
    }
    await archiveThenDeleteWorking(row, actor.userId);
  } catch (err) {
    if (historicalId) await deleteRevisionById(historicalId, siteId).catch(() => undefined);
    throw err;
  }

  await auditScheduleOverride(row, actor, true);
  await rememberContentPermalink(serializeContentRow(row), nextContent);
  await pruneHistoricalForContent(id, siteId);
  await invalidateContentCache();
  await hooks.dispatchAction("content.updated", { contentId: id, siteId, type: String(row.type) }, ctx);
  await hooks.dispatchAction("content.published", { contentId: id, siteId, type: String(row.type) }, ctx);
  void auditLog({
    siteId,
    action: "content.published",
    actorId: actor.userId,
    actorRole: actor.role,
    target: id,
  });

  const db = await getDb();
  const next = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, siteId],
  );
  res.json(serializeEditorContent(next[0]!, null));
}

export async function unpublishRow(
  row: Record<string, unknown>,
  patch: {
    title?: string;
    slug?: string;
    excerpt?: string | null;
    blocks?: unknown;
    fields?: Record<string, unknown>;
  },
  actor: ContentActor,
  res: WriteResponse,
): Promise<void> {
  const id = String(row.id);
  const working = await getWorkingRevision(id, actor.siteId);
  const base = working ? revisionToSnapshot(working) : rowToSnapshot(row);
  const proposed = mergeSnapshot(base, patch);
  const applied = await applySnapshotToContent(id, actor.siteId, proposed, {
    status: "draft",
    expectedVersion: Number(row.version ?? 1) || 1,
  });
  if (!applied) {
    res.status(409).json({ error: "Version conflict while unpublishing" });
    return;
  }
  await archiveThenDeleteWorking(row, actor.userId);
  await auditScheduleOverride(row, actor);
  await invalidateContentCache();
  await getRuntimeHooks().dispatchAction(
    "content.unpublished",
    { contentId: id, siteId: actor.siteId },
    hookCtx(actor),
  );
  const db = await getDb();
  const next = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, actor.siteId],
  );
  res.json(serializeEditorContent(next[0]!, null));
}

/** The non-published direct-to-live update path lifted out of `PATCH /:id`. */
export async function applyDraftUpdate(
  row: Record<string, unknown>,
  patch: PatchContentInput,
  actor: ContentActor,
  res: WriteResponse,
): Promise<void> {
  const id = String(row.id);
  const ctx = hookCtx(actor);
  const contentRef = { contentId: id, siteId: actor.siteId, type: String(row.type) };
  const hooks = getRuntimeHooks();
  const proposed = mergeSnapshot(rowToSnapshot(row), patch);
  try {
    await hooks.dispatchGate("content.beforeUpdate", { ...contentRef, revision: proposed }, ctx);
  } catch (err) {
    if (isHookAbortError(err)) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  if (!snapshotsEqual(rowToSnapshot(row), proposed)) {
    await insertHistoricalIfChanged(row, actor.userId);
  }

  const fields: string[] = [];
  const values: (string | number | boolean | null)[] = [];
  if (patch.title !== undefined) {
    fields.push("title = ?");
    values.push(patch.title);
  }
  if (patch.slug !== undefined) {
    fields.push("slug = ?");
    values.push(patch.slug);
  }
  if (patch.excerpt !== undefined) {
    fields.push("excerpt = ?");
    values.push(patch.excerpt);
  }
  if (patch.blocks !== undefined) {
    fields.push("blocks = ?");
    values.push(JSON.stringify(sanitizeBlockDocument(patch.blocks)));
  }
  if (patch.fields !== undefined) {
    fields.push("fields = ?");
    values.push(JSON.stringify(patch.fields));
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
    fields.push("publish_on = NULL", "unpublish_on = NULL");
  }
  if (fields.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  fields.push("updated_at = ?", "version = version + 1");
  values.push(now(), id, actor.siteId, Number(row.version));
  const db = await getDb();
  const changed = await db.execute(`UPDATE content SET ${fields.join(", ")} WHERE id = ? AND site_id = ? AND version = ?`, values);
  if (changed !== 1) { res.status(409).json({ error: "Content changed; reload before saving" }); return; }

  if (patch.status !== undefined) await auditScheduleOverride(row, actor);
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, actor.siteId],
  );
  await hooks.dispatchAction(row.status === "scheduled" && patch.status === undefined ? "content.revisionSaved" : "content.updated", contentRef, ctx);
  res.json(rows[0] ? serializeEditorContent(rows[0], null) : { error: "Not found" });
}

export interface CreateContentResult {
  status: number;
  body: unknown;
}

export async function createContentEntry(
  input: CreateContentInput,
  actor: ContentActor,
): Promise<CreateContentResult> {
  const { type, title, excerpt, blocks, fields } = input;
  const registered = await getContentTypeBySlug(type, actor.siteId);
  if (!registered) {
    return { status: 400, body: { error: `Unknown content type "${type}"` } };
  }
  let slug = input.slug ? slugify(input.slug) : slugify(title);
  const id = randomUUID();
  const locale = await resolveContentLocale(input.locale, actor.siteId);
  try {
    slug = await uniquePermalinkSlug(
      serializeContentRow({
        id,
        site_id: actor.siteId,
        type,
        title,
        slug,
        locale,
        status: "draft",
        created_at: now(),
        author_id: actor.userId,
        fields: fields ?? {},
      }),
    );
  } catch (err) {
    if (err instanceof PermalinkConflictError) return { status: 409, body: { error: err.message } };
    throw err;
  }
  const translationGroupId = input.translationGroupId ?? id;
  const hooks = getRuntimeHooks();
  const ctx = hookCtx(actor);

  try {
    await hooks.dispatchGate(
      "content.beforeCreate",
      {
        input: {
          siteId: actor.siteId,
          type,
          title,
          slug,
          excerpt: excerpt ?? null,
          fields: fields ?? {},
        },
      },
      ctx,
    );
  } catch (err) {
    if (isHookAbortError(err)) return { status: 403, body: { error: err.message } };
    throw err;
  }

  const db = await getDb();
  const blockDoc = isEmptyBlockDocument(blocks) ? await defaultBlocksForContentType(type) : blocks;

  await db.run(
    `INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, excerpt, blocks, fields, status, author_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [
      id,
      actor.siteId,
      type,
      title,
      slug,
      locale,
      translationGroupId,
      excerpt ?? null,
      JSON.stringify(sanitizeBlockDocument(blockDoc)),
      JSON.stringify(fields ?? {}),
      actor.userId,
      now(),
      now(),
    ],
  );

  const rows = await db.query<Record<string, unknown>>("SELECT * FROM content WHERE id = ?", [id]);
  await hooks.dispatchAction(
    "content.created",
    contentHookRef(id, actor.siteId, { type, translationGroupId }),
    ctx,
  );
  return { status: 201, body: serializeContentRow(rows[0]!) };
}

export async function trashContentEntry(
  row: {
    id: string;
    author_id: string | null;
    type: string;
    locale: string;
    translation_group_id: string | null;
  },
  actor: ContentActor,
): Promise<CreateContentResult> {
  const id = row.id;
  const db = await getDb();
  const hooks = getRuntimeHooks();
  const ctx = hookCtx(actor);
  const groupId = translationGroupOf(row, id);
  const siblings = await db.query<{ id: string }>(
    "SELECT id FROM content WHERE site_id = ? AND translation_group_id = ? AND id != ? LIMIT 1",
    [actor.siteId, groupId, id],
  );
  const contentRef = contentHookRef(id, actor.siteId, {
    type: row.type,
    translationGroupId: groupId,
    lastInTranslationGroup: !siblings[0],
  });

  try {
    await hooks.dispatchGate("content.beforeDelete", contentRef, ctx);
  } catch (err) {
    if (isHookAbortError(err)) return { status: 403, body: { error: err.message } };
    throw err;
  }

  const trashedSlug = `${row.type}-trash-${id}`;
  await db.run(
    "UPDATE content SET original_slug = slug, original_status = status, slug = ?, status = 'trashed', publish_on = NULL, unpublish_on = NULL, trashed_at = ?, trashed_by = ?, updated_at = ? WHERE id = ? AND site_id = ?",
    [trashedSlug, now(), actor.userId, now(), id, actor.siteId],
  );
  await invalidateContentCache();
  await hooks.dispatchAction("content.deleted", contentRef, ctx);
  void auditLog({
    siteId: actor.siteId,
    action: "trash.trashed",
    actorId: actor.userId,
    actorRole: actor.role,
    target: id,
    detail: `type=content; contentType=${row.type}`,
  });
  return { status: 200, body: { ok: true } };
}
