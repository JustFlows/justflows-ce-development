import { uniquePermalinkSlug, rememberContentPermalink, PermalinkConflictError } from "../lib/permalinks-db.js";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../lib/db.js";
import { normalizeFields, serializeContentRow } from "../lib/content-api.js";
import { PAGE_HEADER_REF_FIELD, SITE_DEFAULT_HEADER_REF } from "../lib/page-header.js";
import { revalidateOnUpdate } from "../lib/cache-revalidate.js";
import {
  applySnapshotToContent,
  archiveThenDeleteWorking,
  deleteRevisionById,
  getRevisionById,
  getWorkingRevision,
  insertHistoricalIfChanged,
  listRevisions,
  pruneHistoricalForContent,
  revisionColumn,
  revisionToSnapshot,
  rowToSnapshot,
  serializeEditorContent,
  serializeRevision,
  upsertWorkingRevision,
} from "../lib/content-revisions.js";
import {
  diffSnapshots,
  snapshotsEqual,
  DEFAULT_REVISION_MAX_HISTORY,
  type ContentSnapshot,
} from "@justflows/content";
import { resolveContentLocale } from "../lib/i18n/languages-db.js";
import { invalidateContentCache } from "../lib/content-public.js";
import { getRuntimeHooks } from "../lib/plugin-runtime.js";
import { isHookAbortError } from "@justflows/core";
import { sanitizeBlockDocument } from "@justflows/blocks";
import {
  defaultBlocksForContentType,
  isEmptyBlockDocument,
} from "../lib/default-content-blocks.js";
import { requireCapability, requireSession } from "../middleware/auth.js";
import { userCan, getEffectiveAccess } from "../lib/access-policy.js";
import { param } from "../lib/params.js";
import { ContentTypeSlugSchema } from "@justflows/content";
import { getContentTypeBySlug } from "../lib/content-types-db.js";
import { auditLog } from "../lib/audit-log.js";
import { sendServerError } from "../lib/send-error.js";

const router = Router();

const CreateSchema = z.object({
  type: ContentTypeSlugSchema.default("post"),
  title: z.string().min(1),
  slug: z.string().optional(),
  excerpt: z.string().optional(),
  locale: z.string().optional(),
  translationGroupId: z.string().uuid().optional(),
  blocks: z.object({ version: z.literal(1), blocks: z.array(z.unknown()) }).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

const PatchSchema = z
  .object({
    title: z.string().optional(),
    slug: z.string().optional(),
    excerpt: z.string().nullable().optional(),
    blocks: z.unknown().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["draft", "published", "archived", "scheduled"]).optional(),
    expectedVersion: z.number().int().positive().optional(),
    source: z.enum(["manual", "autosave", "import", "api"]).optional(),
  })
  .passthrough();

const TranslateSchema = z.object({
  locale: z.string().min(2).max(20),
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 200);
}

function now(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function hookCtx(session: { siteId: string; userId: string; role: string }) {
  return {
    siteId: session.siteId,
    source: "http" as const,
    actor: { userId: session.userId, role: session.role },
  };
}

function translationGroupOf(
  row: { id?: unknown; translation_group_id?: unknown },
  fallbackId: string,
): string {
  return row.translation_group_id ? String(row.translation_group_id) : fallbackId;
}

function contentHookRef(
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

function mergeSnapshot(
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

router.get("/", requireSession, async (req, res) => {
  const session = req.session!;
  const type = req.query.type as string | undefined;
  const status = req.query.status as string | undefined;
  const slug = req.query.slug as string | undefined;
  const locale = req.query.locale as string | undefined;
  const translationGroupId = req.query.translationGroupId as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? "20"), 100);
  const cursor = req.query.cursor as string | undefined;

  try {
    const db = await getDb();
    const access = await getEffectiveAccess(session.userId, session.siteId, session.role, db);
    if (!access.capabilities.includes("content:read")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    // A list has no single resource to check ownership against, so an
    // ownership:"self" scope becomes a query filter instead of a blanket
    // deny — the other scope dimensions (site is implicit; type/locale can
    // be evaluated against the request) still reject outright, matching how
    // a single-resource check behaves.
    const readScope = access.policy.scopes?.["content:read"];
    if (readScope?.contentTypes?.length && (!type || !readScope.contentTypes.includes(type))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (readScope?.locales?.length && (!locale || !readScope.locales.includes(locale))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    let sql = `SELECT c.id, c.type, c.title, c.slug, c.locale, c.translation_group_id, c.excerpt, c.status,
              c.author_id, c.published_at, c.created_at, c.updated_at, c.version,
              w.id AS working_revision_id
       FROM content c
       LEFT JOIN revisions w ON w.content_id = c.id AND w.site_id = c.site_id AND w.${revisionColumn("kind")} = 'working'
       WHERE c.site_id = ?`;
    const params: (string | number | boolean | null)[] = [session.siteId];

    if (type) {
      sql += " AND c.type = ?";
      params.push(type);
    }
    if (status) {
      sql += " AND c.status = ?";
      params.push(status);
    } else {
      sql += " AND c.trashed_at IS NULL";
    }
    if (slug) {
      sql += " AND c.slug = ?";
      params.push(slug);
    }
    if (locale) {
      sql += " AND c.locale = ?";
      params.push(await resolveContentLocale(locale, session.siteId));
    }
    if (translationGroupId) {
      sql += " AND c.translation_group_id = ?";
      params.push(translationGroupId);
    }
    if (cursor) {
      sql += " AND c.id > ?";
      params.push(cursor);
    }
    if (readScope?.ownership === "self") {
      sql += " AND c.author_id = ?";
      params.push(session.userId);
    }

    sql += " ORDER BY c.updated_at DESC LIMIT ?";
    params.push(limit + 1);

    const rows = await db.query<Record<string, unknown>>(sql, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      items: items.map(serializeContentRow),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
      total: items.length,
    });
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

router.post(
  "/",
  requireCapability("content:create", (req) => ({
    contentType: req.body?.type,
    locale: req.body?.locale,
    ownerId: req.session?.userId,
  })),
  async (req, res) => {
    const session = req.session!;

    try {
      const body = CreateSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message });
        return;
      }

      const { type, title, excerpt, blocks, fields } = body.data;
      const registered = await getContentTypeBySlug(type, session.siteId);
      if (!registered) {
        res.status(400).json({ error: `Unknown content type "${type}"` });
        return;
      }
      let slug = body.data.slug ? slugify(body.data.slug) : slugify(title);
      const id = randomUUID();
      const locale = await resolveContentLocale(body.data.locale, session.siteId);
      try {
        slug = await uniquePermalinkSlug(serializeContentRow({ id, site_id: session.siteId, type, title, slug, locale, status: "draft", created_at: now(), author_id: session.userId, fields: fields ?? {} }));
      } catch (err) {
        if (err instanceof PermalinkConflictError) { res.status(409).json({ error: err.message }); return; }
        throw err;
      }
      const translationGroupId = body.data.translationGroupId ?? id;
      const hooks = getRuntimeHooks();
      const hookCtx = {
        siteId: session.siteId,
        source: "http" as const,
        actor: { userId: session.userId, role: session.role },
      };

      try {
        await hooks.dispatchGate(
          "content.beforeCreate",
          {
            input: {
              siteId: session.siteId,
              type,
              title,
              slug,
              excerpt: excerpt ?? null,
              fields: fields ?? {},
            },
          },
          hookCtx,
        );
      } catch (err) {
        if (isHookAbortError(err)) {
          res.status(403).json({ error: err.message });
          return;
        }
        throw err;
      }

      const db = await getDb();
      const blockDoc = isEmptyBlockDocument(blocks)
        ? await defaultBlocksForContentType(type)
        : blocks;

      await db.run(
        `INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, excerpt, blocks, fields, status, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [
          id,
          session.siteId,
          type,
          title,
          slug,
          locale,
          translationGroupId,
          excerpt ?? null,
          JSON.stringify(sanitizeBlockDocument(blockDoc)),
          JSON.stringify(fields ?? {}),
          session.userId,
          now(),
          now(),
        ],
      );

      const rows = await db.query<Record<string, unknown>>("SELECT * FROM content WHERE id = ?", [
        id,
      ]);
      await hooks.dispatchAction(
        "content.created",
        contentHookRef(id, session.siteId, { type, translationGroupId }),
        hookCtx,
      );
      res.status(201).json(serializeContentRow(rows[0]!));
    } catch (err) {
      sendServerError(res, "content", err);
    }
  },
);

router.post(
  "/:id/translate",
  requireCapability("content:create", (req) => ({
    locale: req.body?.locale,
    ownerId: req.session?.userId,
  })),
  async (req, res) => {
    const session = req.session!;
    const id = param(req.params.id);
    const body = TranslateSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message });
      return;
    }

    try {
      const db = await getDb();
      const rows = await db.query<Record<string, unknown>>(
        "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
        [id, session.siteId],
      );
      const source = rows[0];
      if (!source) {
        res.status(404).json({ error: "Not found" });
        return;
      }

      const locale = await resolveContentLocale(body.data.locale, session.siteId);
      const groupId = source.translation_group_id
        ? String(source.translation_group_id)
        : String(source.id);

      if (!source.translation_group_id) {
        await db.run(
          "UPDATE content SET translation_group_id = ?, updated_at = ? WHERE id = ? AND site_id = ?",
          [groupId, now(), id, session.siteId],
        );
      }

      const existing = await db.query<{ id: string }>(
        "SELECT id FROM content WHERE site_id = ? AND translation_group_id = ? AND locale = ? LIMIT 1",
        [session.siteId, groupId, locale],
      );
      if (existing[0]) {
        res.status(409).json({
          error: "A translation for this language already exists",
          contentId: existing[0].id,
        });
        return;
      }

      const newId = randomUUID();
      const hooks = getRuntimeHooks();
      const hookCtx = {
        siteId: session.siteId,
        source: "http" as const,
        actor: { userId: session.userId, role: session.role },
      };
      const isProduct = String(source.type) === "product";
      const title = isProduct ? "" : String(source.title);
      const slug = String(source.slug);
      const excerpt = isProduct || source.excerpt == null ? null : String(source.excerpt);

      try {
        await hooks.dispatchGate(
          "content.beforeCreate",
          {
            input: {
              siteId: session.siteId,
              type: String(source.type),
              title,
              slug,
              excerpt,
              fields: {},
            },
          },
          hookCtx,
        );
      } catch (err) {
        if (isHookAbortError(err)) {
          res.status(403).json({ error: err.message });
          return;
        }
        throw err;
      }

      let parsedBlocks: unknown = source.blocks;
      if (typeof source.blocks === "string") {
        try {
          parsedBlocks = JSON.parse(source.blocks);
        } catch {
          parsedBlocks = { version: 1, blocks: [] };
        }
      }
      const blocksValue = JSON.stringify(sanitizeBlockDocument(parsedBlocks));
      const fieldsValue = isProduct
        ? JSON.stringify({})
        : typeof source.fields === "string"
          ? source.fields
          : JSON.stringify(source.fields ?? {});

      await db.run(
        `INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, excerpt, blocks, fields, status, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [
          newId,
          session.siteId,
          String(source.type),
          title,
          slug,
          locale,
          groupId,
          excerpt,
          blocksValue,
          fieldsValue,
          session.userId,
          now(),
          now(),
        ],
      );

      const created = await db.query<Record<string, unknown>>(
        "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
        [newId, session.siteId],
      );
      await hooks.dispatchAction(
        "content.created",
        contentHookRef(newId, session.siteId, {
          type: String(source.type),
          translationGroupId: groupId,
        }),
        hookCtx,
      );
      res.status(201).json(serializeContentRow(created[0]!));
    } catch (err) {
      sendServerError(res, "content", err);
    }
  },
);

router.get("/:id", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, session.siteId],
  );
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (
    !(await userCan(session, "content:read", {
      contentType: String(row.type),
      locale: String(row.locale),
      ownerId: row.author_id as string | null,
    }))
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const working = await getWorkingRevision(id, session.siteId);
  res.json(serializeEditorContent(row, working));
});

// The middleware only authenticates here — it deliberately does not gate on
// the capability itself. Doing so with no resource would run scopeAllows()
// against an empty resource, and an ownership:"self" scope always fails
// against a resource with no ownerId, 403ing scoped users before the
// handler ever loads the row to find out whether they actually own it. The
// real check runs below once the row (and its real ownerId) is in hand.
router.patch("/:id", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const body = PatchSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message });
    return;
  }

  try {
    const db = await getDb();
    const existing = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
      [id, session.siteId],
    );
    const row = existing[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (
      !(await userCan(session, "content:update", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const currentVersion = Number(row.version ?? 1) || 1;
    if (body.data.expectedVersion != null && body.data.expectedVersion !== currentVersion) {
      res.status(409).json({
        error: `Version conflict: expected ${body.data.expectedVersion}, got ${currentVersion}`,
        expectedVersion: body.data.expectedVersion,
        actualVersion: currentVersion,
      });
      return;
    }

    if (
      body.data.status === "published" &&
      !(await userCan(session, "content:publish", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    if (body.data.slug !== undefined) {
      try {
        body.data.slug = await uniquePermalinkSlug({ ...serializeContentRow(row), slug: slugify(body.data.slug) });
      } catch (err) {
        if (err instanceof PermalinkConflictError) { res.status(409).json({ error: err.message }); return; }
        throw err;
      }
    }
    const ctx = hookCtx(session);
    const contentRef = { contentId: id, siteId: session.siteId, type: String(row.type) };
    const status = String(row.status);
    const wantsPublish = body.data.status === "published";
    const wantsUnpublish =
      status === "published" && body.data.status !== undefined && body.data.status !== "published";

    if (status === "published" && wantsUnpublish) {
      await unpublishRow(row, body.data, session, res);
      return;
    }

    if (wantsPublish) {
      await publishRow(row, body.data, session, res);
      return;
    }

    if (status === "published") {
      await saveWorkingRow(row, body.data, session, res);
      return;
    }

    const hooks = getRuntimeHooks();
    const proposed = mergeSnapshot(rowToSnapshot(row), body.data);
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
      await insertHistoricalIfChanged(row, session.userId);
    }

    const fields: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    if (body.data.title !== undefined) {
      fields.push("title = ?");
      values.push(body.data.title);
    }
    if (body.data.slug !== undefined) {
      fields.push("slug = ?");
      values.push(body.data.slug);
    }
    if (body.data.excerpt !== undefined) {
      fields.push("excerpt = ?");
      values.push(body.data.excerpt);
    }
    if (body.data.blocks !== undefined) {
      fields.push("blocks = ?");
      values.push(JSON.stringify(sanitizeBlockDocument(body.data.blocks)));
    }
    if (body.data.fields !== undefined) {
      fields.push("fields = ?");
      values.push(JSON.stringify(body.data.fields));
    }
    if (body.data.status !== undefined) {
      fields.push("status = ?");
      values.push(body.data.status);
    }
    if (fields.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    fields.push("updated_at = ?", "version = version + 1");
    values.push(now(), id, session.siteId);
    await db.run(`UPDATE content SET ${fields.join(", ")} WHERE id = ? AND site_id = ?`, values);

    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, session.siteId],
    );
    await hooks.dispatchAction("content.updated", contentRef, ctx);
    res.json(rows[0] ? serializeEditorContent(rows[0], null) : { error: "Not found" });
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

const HeaderRefSchema = z.object({ ref: z.string().max(64) });

/**
 * Which header a page renders (see PAGE_HEADER_REF_FIELD). This is page chrome
 * config, not draftable content, so it is written straight to the live row (and
 * any working revision) — never routed through the blocks/revision save, where a
 * no-op snapshot diff can swallow it.
 */
// See the comment on PATCH /:id above — the resource (and its ownerId) is
// only known once the row is loaded, so the capability+scope check happens
// in the handler via userCan(), not in this middleware.
router.put("/:id/header-ref", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const parsed = HeaderRefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message });
    return;
  }
  const raw = parsed.data.ref.trim();
  const ref = raw === SITE_DEFAULT_HEADER_REF ? "" : raw;
  try {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT id, fields, author_id, type, locale FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, session.siteId],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !(await userCan(session, "content:update", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const withRef = (value: unknown): string => {
      const fields = normalizeFields(value);
      if (ref) fields[PAGE_HEADER_REF_FIELD] = ref;
      else delete fields[PAGE_HEADER_REF_FIELD];
      return JSON.stringify(fields);
    };
    await db.run("UPDATE content SET fields = ?, updated_at = ? WHERE id = ? AND site_id = ?", [
      withRef(row.fields),
      now(),
      id,
      session.siteId,
    ]);
    const working = await getWorkingRevision(id, session.siteId);
    if (working) {
      await db.run(
        `UPDATE revisions SET fields = ? WHERE content_id = ? AND site_id = ? AND ${revisionColumn("kind")} = 'working'`,
        [withRef(JSON.stringify(working.fields)), id, session.siteId],
      );
    }
    await invalidateContentCache();
    await revalidateOnUpdate("content");
    res.json({ ok: true, ref: ref || SITE_DEFAULT_HEADER_REF });
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

router.get("/:id/revisions", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  try {
    const db = await getDb();
    const existing = await db.query<{
      id: string;
      type: string;
      locale: string;
      author_id: string | null;
    }>("SELECT id, type, locale, author_id FROM content WHERE id = ? AND site_id = ? LIMIT 1", [
      id,
      session.siteId,
    ]);
    const row = existing[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !(await userCan(session, "content:revisions:read", {
        contentType: row.type,
        locale: row.locale,
        ownerId: row.author_id,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const revisions = await listRevisions(id, session.siteId);
    res.json({
      items: revisions.map((rev) => serializeRevision(rev)),
      maxHistory: DEFAULT_REVISION_MAX_HISTORY,
    });
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

router.get("/:id/revisions/compare", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  try {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, session.siteId],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !(await userCan(session, "content:revisions:read", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const working = await getWorkingRevision(id, session.siteId);
    if (!working) {
      res.json({ changed: false, entries: [] });
      return;
    }
    res.json(diffSnapshots(rowToSnapshot(row), revisionToSnapshot(working)));
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

router.get("/:id/revisions/:revisionId", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const revisionId = param(req.params.revisionId);
  try {
    const db = await getDb();
    const existing = await db.query<{ type: string; locale: string; author_id: string | null }>(
      "SELECT type, locale, author_id FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, session.siteId],
    );
    const contentRow = existing[0];
    if (!contentRow) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    if (
      !(await userCan(session, "content:revisions:read", {
        contentType: contentRow.type,
        locale: contentRow.locale,
        ownerId: contentRow.author_id,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const revision = await getRevisionById(id, session.siteId, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(serializeRevision(revision, { includeBody: true }));
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

// See the comment on PATCH /:id — capability+scope is checked below via
// userCan() once the row's real ownerId is known.
router.post("/:id/revisions/:revisionId/restore", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const revisionId = param(req.params.revisionId);
  try {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
      [id, session.siteId],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !(await userCan(session, "content:revisions:restore", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const revision = await getRevisionById(id, session.siteId, revisionId);
    if (!revision || revision.kind === "working") {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    const ctx = hookCtx(session);
    if (String(row.status) === "published") {
      await upsertWorkingRevision(row, {
        snapshot: revisionToSnapshot(revision),
        source: "manual",
        actorId: session.userId,
        baseVersion: Number(row.version ?? 1) || 1,
      });
    } else {
      await applySnapshotToContent(id, session.siteId, revisionToSnapshot(revision), {
        expectedVersion: Number(row.version ?? 1) || 1,
      });
    }
    await getRuntimeHooks().dispatchAction(
      "content.revisionRestored",
      { contentId: id, siteId: session.siteId, revisionId, actorId: session.userId },
      ctx,
    );
    void auditLog({
      siteId: session.siteId,
      action: "content.revision_restored",
      actorId: session.userId,
      actorRole: session.role,
      target: id,
    });
    const next = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, session.siteId],
    );
    const working = await getWorkingRevision(id, session.siteId);
    res.json(serializeEditorContent(next[0]!, working));
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

// See the comment on PATCH /:id — capability+scope is checked below via
// userCan() once the row's real ownerId is known.
router.post("/:id/publish", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const expectedVersion =
    typeof req.body?.expectedVersion === "number" ? req.body.expectedVersion : undefined;
  try {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
      [id, session.siteId],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !(await userCan(session, "content:publish", {
        contentType: String(rows[0].type),
        locale: String(rows[0].locale),
        ownerId: rows[0].author_id as string | null,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    await publishRow(rows[0], { expectedVersion }, session, res);
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

// See the comment on PATCH /:id — capability+scope is checked below via
// userCan() once the row's real ownerId is known.
router.post("/:id/discard-draft", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  try {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
      [id, session.siteId],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !(await userCan(session, "content:revisions:discard", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const working = await getWorkingRevision(id, session.siteId);
    if (working) {
      await archiveThenDeleteWorking(row, session.userId);
      await getRuntimeHooks().dispatchAction(
        "content.revisionDiscarded",
        { contentId: id, siteId: session.siteId, revisionId: working.id, actorId: session.userId },
        hookCtx(session),
      );
      void auditLog({
        siteId: session.siteId,
        action: "content.revision_discarded",
        actorId: session.userId,
        actorRole: session.role,
        target: id,
      });
    }
    res.json(serializeEditorContent(row, null));
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

// See the comment on PATCH /:id — capability+scope is checked below via
// userCan() once the row's real ownerId is known.
router.delete("/:id", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const db = await getDb();

  const existing = await db.query<{
    author_id: string | null;
    type: string;
    locale: string;
    translation_group_id: string | null;
  }>(
    "SELECT author_id, type, locale, translation_group_id FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
    [id, session.siteId],
  );
  const row = existing[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (
    !(await userCan(session, "content:delete", {
      contentType: row.type,
      locale: row.locale,
      ownerId: row.author_id,
    }))
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const hooks = getRuntimeHooks();
  const hookCtx = {
    siteId: session.siteId,
    source: "http" as const,
    actor: { userId: session.userId, role: session.role },
  };
  const groupId = translationGroupOf(row, id);
  const siblings = await db.query<{ id: string }>(
    "SELECT id FROM content WHERE site_id = ? AND translation_group_id = ? AND id != ? LIMIT 1",
    [session.siteId, groupId, id],
  );
  const contentRef = contentHookRef(id, session.siteId, {
    type: row.type,
    translationGroupId: groupId,
    lastInTranslationGroup: !siblings[0],
  });

  try {
    await hooks.dispatchGate("content.beforeDelete", contentRef, hookCtx);
  } catch (err) {
    if (isHookAbortError(err)) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const trashedSlug = `${row.type}-trash-${id}`;
  await db.run(
    "UPDATE content SET original_slug = slug, original_status = status, slug = ?, status = 'trashed', trashed_at = ?, trashed_by = ?, updated_at = ? WHERE id = ? AND site_id = ?",
    [trashedSlug, now(), session.userId, now(), id, session.siteId],
  );
  await invalidateContentCache();
  await hooks.dispatchAction("content.deleted", contentRef, hookCtx);
  void auditLog({
    siteId: session.siteId,
    action: "trash.trashed",
    actorId: session.userId,
    actorRole: session.role,
    target: id,
    detail: `type=content; contentType=${row.type}`,
  });
  res.json({ ok: true });
});

type SessionActor = { siteId: string; userId: string; role: string };

async function saveWorkingRow(
  row: Record<string, unknown>,
  patch: {
    title?: string;
    slug?: string;
    excerpt?: string | null;
    blocks?: unknown;
    fields?: Record<string, unknown>;
    source?: "manual" | "autosave" | "import" | "api";
  },
  session: SessionActor,
  res: {
    json: (body: unknown) => void;
    status: (code: number) => { json: (body: unknown) => void };
  },
): Promise<void> {
  const id = String(row.id);
  const working = await getWorkingRevision(id, session.siteId);
  const base = working ? revisionToSnapshot(working) : rowToSnapshot(row);
  let proposed = mergeSnapshot(base, patch);
  const hooks = getRuntimeHooks();
  const ctx = hookCtx(session);
  proposed = await hooks.applyFilter(
    "content.revision",
    proposed,
    { siteId: session.siteId, contentId: id },
    ctx,
  );
  try {
    await hooks.dispatchGate(
      "content.beforeUpdate",
      { contentId: id, siteId: session.siteId, revision: proposed, revisionId: working?.id },
      ctx,
    );
  } catch (err) {
    if (isHookAbortError(err)) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const saved = await upsertWorkingRevision(row, {
    snapshot: proposed,
    source: patch.source ?? "manual",
    actorId: session.userId,
    baseVersion: Number(row.version ?? 1) || 1,
  });
  if (saved) {
    await hooks.dispatchAction(
      "content.revisionSaved",
      { contentId: id, siteId: session.siteId, revisionId: saved.id, source: saved.source },
      ctx,
    );
  }
  res.json(serializeEditorContent(row, saved));
}

async function publishRow(
  row: Record<string, unknown>,
  patch: {
    title?: string;
    slug?: string;
    excerpt?: string | null;
    blocks?: unknown;
    fields?: Record<string, unknown>;
    expectedVersion?: number;
  },
  session: SessionActor,
  res: {
    json: (body: unknown) => void;
    status: (code: number) => { json: (body: unknown) => void };
  },
): Promise<void> {
  const id = String(row.id);
  const siteId = session.siteId;
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
  const ctx = hookCtx(session);
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
    if (err instanceof PermalinkConflictError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  let historicalId: string | null = null;
  historicalId = await insertHistoricalIfChanged(row, session.userId);

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
    await archiveThenDeleteWorking(row, session.userId);
  } catch (err) {
    if (historicalId) await deleteRevisionById(historicalId, siteId).catch(() => undefined);
    throw err;
  }

  await rememberContentPermalink(serializeContentRow(row), nextContent);
  await pruneHistoricalForContent(id, siteId);
  await invalidateContentCache();
  await hooks.dispatchAction(
    "content.updated",
    { contentId: id, siteId, type: String(row.type) },
    ctx,
  );
  await hooks.dispatchAction(
    "content.published",
    { contentId: id, siteId, type: String(row.type) },
    ctx,
  );
  void auditLog({
    siteId,
    action: "content.published",
    actorId: session.userId,
    actorRole: session.role,
    target: id,
  });

  const db = await getDb();
  const next = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, siteId],
  );
  res.json(serializeEditorContent(next[0]!, null));
}

async function unpublishRow(
  row: Record<string, unknown>,
  patch: {
    title?: string;
    slug?: string;
    excerpt?: string | null;
    blocks?: unknown;
    fields?: Record<string, unknown>;
  },
  session: SessionActor,
  res: {
    json: (body: unknown) => void;
    status: (code: number) => { json: (body: unknown) => void };
  },
): Promise<void> {
  const id = String(row.id);
  const working = await getWorkingRevision(id, session.siteId);
  const base = working ? revisionToSnapshot(working) : rowToSnapshot(row);
  const proposed = mergeSnapshot(base, patch);
  const applied = await applySnapshotToContent(id, session.siteId, proposed, {
    status: "draft",
    expectedVersion: Number(row.version ?? 1) || 1,
  });
  if (!applied) {
    res.status(409).json({ error: "Version conflict while unpublishing" });
    return;
  }
  await archiveThenDeleteWorking(row, session.userId);
  await invalidateContentCache();
  await getRuntimeHooks().dispatchAction(
    "content.unpublished",
    { contentId: id, siteId: session.siteId },
    hookCtx(session),
  );
  const db = await getDb();
  const next = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, session.siteId],
  );
  res.json(serializeEditorContent(next[0]!, null));
}

export default router;
