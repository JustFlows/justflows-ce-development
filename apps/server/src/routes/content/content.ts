import { getContentTypeSettings } from "../../lib/content/content-types-db.js";
import { createContentPreview } from "../../lib/content/content-preview.js";
import { rateLimit } from "express-rate-limit";
import { ContentScheduleSchema, ScheduleError, setContentSchedule } from "../../lib/content/content-scheduling-db.js";
import { uniquePermalinkSlug, PermalinkConflictError } from "../../lib/navigation/permalinks-db.js";
import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../../lib/database/db.js";
import { normalizeFields, serializeContentRow } from "../../lib/content/content-api.js";
import { PAGE_HEADER_REF_FIELD, SITE_DEFAULT_HEADER_REF } from "../../lib/rendering/page-header.js";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import {
  applySnapshotToContent,
  archiveThenDeleteWorking,
  getRevisionById,
  getWorkingRevision,
  listRevisions,
  revisionColumn,
  revisionToSnapshot,
  rowToSnapshot,
  serializeEditorContent,
  serializeRevision,
  upsertWorkingRevision,
} from "../../lib/content/content-revisions.js";
import { diffSnapshots, DEFAULT_REVISION_MAX_HISTORY } from "@justflows/content";
import { resolveContentLocale } from "../../lib/i18n/languages-db.js";
import { invalidateContentCache } from "../../lib/content/content-public.js";
import { ContentTermsSchema, getContentTerms, setContentTerms, TaxonomyError } from "../../lib/content/taxonomies-db.js";
import { getRuntimeHooks } from "../../lib/plugins/plugin-runtime.js";
import { isHookAbortError } from "@justflows/core";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { requireCapability, requireSession } from "../../middleware/auth.js";
import { userCan, getEffectiveAccess } from "../../lib/auth/access-policy.js";
import {
  canCreateHere,
  capabilityReach,
  draftReach,
  editorialListFilter,
  isPubliclyPublished,
} from "../../lib/content/content-visibility.js";
import { param } from "../../lib/http/params.js";
import { auditLog } from "../../lib/security/audit-log.js";
import { sendServerError } from "../../lib/http/send-error.js";
import {
  applyDraftUpdate,
  blockLockedBody,
  lockViolationsForWrite,
  contentHookRef,
  createContentEntry,
  CreateContentSchema as CreateSchema,
  hookCtx,
  now,
  PatchContentSchema as PatchSchema,
  publishRow,
  saveWorkingRow,
  slugify,
  trashContentEntry,
  unpublishRow,
  workingRevisionConflict,
  type ContentActor,
} from "../../lib/content/content-write.js";

const router = Router();

function contentResource(row: { type?: unknown; locale?: unknown; author_id?: unknown }) {
  return {
    contentType: String(row.type ?? ""),
    locale: String(row.locale ?? ""),
    ownerId: (row.author_id as string | null) ?? null,
  };
}

/**
 * Published rows need content:read. Unpublished rows need content:update, or
 * content:create when the caller wrote the row. Anything else is hidden so a
 * read-only caller does not learn that the id exists.
 */
async function openContent(
  session: { userId: string; siteId: string; role: string },
  row: Record<string, unknown>,
): Promise<"open" | "hidden" | "forbidden"> {
  const resource = contentResource(row);
  if (!isPubliclyPublished(row)) {
    const canUpdate = await userCan(session, "content:update", resource);
    const canCreateOwn =
      String(row.author_id ?? "") === session.userId &&
      (await userCan(session, "content:create", { ...resource, ownerId: session.userId }));
    if (!canUpdate && !canCreateOwn) return "hidden";
  }
  if (!(await userCan(session, "content:read", resource))) return "forbidden";
  return "open";
}

function sendClosed(res: Response, decision: "hidden" | "forbidden"): void {
  res.status(decision === "hidden" ? 404 : 403).json({
    error: decision === "hidden" ? "Not found" : "Forbidden",
  });
}

/**
 * Revision reads are explicit access. An unpublished row stays hidden until
 * the caller can edit it or is allowed to read its revisions.
 */
async function openRevision(
  session: { userId: string; siteId: string; role: string },
  row: Record<string, unknown>,
): Promise<"open" | "hidden" | "forbidden"> {
  const resource = contentResource(row);
  if (!isPubliclyPublished(row)) {
    const canUpdate = await userCan(session, "content:update", resource);
    const canCreateOwn =
      String(row.author_id ?? "") === session.userId &&
      (await userCan(session, "content:create", { ...resource, ownerId: session.userId }));
    const canRevisions = await userCan(session, "content:revisions:read", resource);
    if (!canUpdate && !canCreateOwn && !canRevisions) return "hidden";
  }
  if (!(await userCan(session, "content:revisions:read", resource))) return "forbidden";
  return "open";
}

const TranslateSchema = z.object({
  locale: z.string().min(2).max(20),
});

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
    const visibilityRequest = { siteId: session.siteId, contentType: type, locale };
    const reach = draftReach(
      capabilityReach(access, "content:update", visibilityRequest),
      canCreateHere(access, visibilityRequest),
    );
    const listed = editorialListFilter({ reach, status, actorId: session.userId });
    if ("error" in listed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const revisionReach = capabilityReach(access, "content:revisions:read", visibilityRequest);
    const revisionSelect =
      revisionReach === "none"
        ? "NULL AS working_revision_id"
        : revisionReach === "own"
          ? "CASE WHEN c.author_id = ? THEN w.id ELSE NULL END AS working_revision_id"
          : "w.id AS working_revision_id";
    const revisionJoin =
      revisionReach === "none"
        ? ""
        : `LEFT JOIN revisions w ON w.content_id = c.id AND w.site_id = c.site_id AND w.${revisionColumn("kind")} = 'working'`;
    let sql = `SELECT c.id, c.type, c.title, c.slug, c.locale, c.translation_group_id, c.excerpt, c.status,
              c.author_id, c.publish_on, c.unpublish_on, c.published_at, c.created_at, c.updated_at, c.version,
              ${revisionSelect}
       FROM content c
       ${revisionJoin}
       WHERE c.site_id = ?`;
    const params: (string | number | boolean | null)[] = [];
    if (revisionReach === "own") params.push(session.userId);
    params.push(session.siteId);

    if (type) {
      sql += " AND c.type = ?";
      params.push(type);
    }
    if (status) {
      if (status === "scheduled") sql += " AND (c.publish_on IS NOT NULL OR c.unpublish_on IS NOT NULL) AND c.trashed_at IS NULL";
      else { sql += " AND c.status = ?"; params.push(status); }
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
      if (status === "scheduled") {
        sql += " AND c.id > ?";
        params.push(cursor);
      } else {
        // The cursor must follow the same tuple as the newest-first sort.
        // UUID order alone is unrelated to the content's update time.
        sql += ` AND (c.updated_at < (SELECT updated_at FROM content WHERE site_id = ? AND id = ?)
          OR (c.updated_at = (SELECT updated_at FROM content WHERE site_id = ? AND id = ?) AND c.id < ?))`;
        params.push(session.siteId, cursor, session.siteId, cursor, cursor);
      }
    }
    if (readScope?.ownership === "self") {
      sql += " AND c.author_id = ?";
      params.push(session.userId);
    }
    sql += listed.sql;
    params.push(...listed.params);

    sql += status === "scheduled" ? " ORDER BY c.id ASC LIMIT ?" : " ORDER BY c.updated_at DESC, c.id DESC LIMIT ?";
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

      const result = await createContentEntry(body.data, session);
      res.status(result.status).json(result.body);
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
      const sourceDecision = await openContent(session, source);
      if (sourceDecision !== "open") {
        sendClosed(res, sourceDecision);
        return;
      }
      const sourceResource = contentResource(source);
      if (
        !(await userCan(session, "content:create", {
          contentType: sourceResource.contentType,
          locale,
          ownerId: session.userId,
        }))
      ) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      /**
       * Stamping a group id writes the source row. That stays forbidden until
       * the caller can update the source, and it happens only after the
       * destination check above.
       */
      if (!source.translation_group_id && !(await userCan(session, "content:update", sourceResource))) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const groupId = source.translation_group_id
        ? String(source.translation_group_id)
        : String(source.id);
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

      if (!source.translation_group_id) {
        await db.run(
          "UPDATE content SET translation_group_id = ?, updated_at = ? WHERE id = ? AND site_id = ?",
          [groupId, now(), id, session.siteId],
        );
      }

      const newId = randomUUID();
      const hooks = getRuntimeHooks();
      const hookCtx = {
        siteId: session.siteId,
        source: "http" as const,
        actor: { userId: session.userId, role: session.role },
      };
      const slug = String(source.slug);
      let parsedBlocks: unknown = source.blocks;
      if (typeof source.blocks === "string") {
        try {
          parsedBlocks = JSON.parse(source.blocks);
        } catch {
          parsedBlocks = { version: 1, blocks: [] };
        }
      }
      let parsedFields: unknown = source.fields ?? {};
      if (typeof source.fields === "string") {
        try {
          parsedFields = JSON.parse(source.fields);
        } catch {
          parsedFields = {};
        }
      }
      const seed = await hooks.applyFilter(
        "content.translationSeed",
        {
          type: String(source.type),
          title: String(source.title),
          excerpt: source.excerpt == null ? null : String(source.excerpt),
          fields: parsedFields,
          blocks: parsedBlocks,
        },
        { siteId: session.siteId, sourceId: String(source.id), locale },
        hookCtx,
      );
      const title = typeof seed?.title === "string" ? seed.title : String(source.title);
      const excerpt = seed?.excerpt == null ? null : String(seed.excerpt);

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

      const { enforceQuota } = await import("../../lib/tenancy/quotas.js");
      const quota = await enforceQuota("content", session.siteId, 1);
      if (quota) {
        res.status(quota.status).json({ error: quota.error, code: quota.code, meter: quota.meter });
        return;
      }

      const blocksValue = JSON.stringify(sanitizeBlockDocument(seed?.blocks ?? parsedBlocks));
      const fieldsValue = JSON.stringify(seed?.fields ?? {});

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
      // Translations share the source's categories and tags, so %category% URLs line up across locales.
      await db.run(
        `INSERT INTO content_terms (content_id, term_id)
         SELECT ?, ct.term_id FROM content_terms ct JOIN terms t ON t.id = ct.term_id
         WHERE ct.content_id = ? AND t.site_id = ?`,
        [newId, String(source.id), session.siteId],
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

router.get("/:id/merge-tags", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT id, type, title, excerpt, translation_group_id, locale, author_id, status, trashed_at, published_at FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [id, session.siteId],
  );
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const decision = await openContent(session, row);
  if (decision !== "open") {
    sendClosed(res, decision);
    return;
  }
  const hooks = getRuntimeHooks();
  const tags = await hooks.applyFilter(
    "content.mergeTags",
    {
      title: String(row.title ?? ""),
      excerpt: row.excerpt == null ? "" : String(row.excerpt),
    },
    {
      siteId: session.siteId,
      contentId: String(row.id),
      type: String(row.type ?? ""),
      title: String(row.title ?? ""),
      excerpt: row.excerpt == null ? null : String(row.excerpt),
      translationGroupId: String(row.translation_group_id ?? row.id),
    },
    { siteId: session.siteId, source: "http" },
  );
  const clean: Record<string, string> = {};
  if (tags && typeof tags === "object") {
    for (const [key, value] of Object.entries(tags)) {
      if (typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) clean[key] = value;
    }
  }
  res.json({ tags: clean });
});

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
  const decision = await openContent(session, row);
  if (decision !== "open") {
    sendClosed(res, decision);
    return;
  }
  const working = (await userCan(session, "content:revisions:read", contentResource(row)))
    ? await getWorkingRevision(id, session.siteId)
    : null;
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
        code: "version_conflict",
        error: `Version conflict: expected ${body.data.expectedVersion}, got ${currentVersion}`,
        expectedVersion: body.data.expectedVersion,
        actualVersion: currentVersion,
      });
      return;
    }

    if (
      (body.data.status === "published" || (body.data.status !== undefined && Boolean(row.publish_on || row.unpublish_on))) &&
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
    if (body.data.blocks !== undefined && !(await userCan(session, "content:locks:manage", contentResource(row)))) {
      const violations = await lockViolationsForWrite(row, body.data.blocks, session.siteId);
      if (violations.length) {
        res.status(403).json(blockLockedBody(violations));
        return;
      }
    }
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

    await applyDraftUpdate(row, body.data, session, res);
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

const scheduleRateLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });

router.post("/:id/preview-link", requireSession, scheduleRateLimit, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  try {
    const db = await getDb();
    const [row] = await db.query<Record<string, unknown>>("SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1", [id, session.siteId]);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const resource = { contentType: String(row.type), locale: String(row.locale), ownerId: row.author_id as string | null };
    if (!(await userCan(session, "content:read", resource)) || !(await userCan(session, "content:update", resource))) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    if (!(await getContentTypeSettings(session.siteId, String(row.type))).preview) {
      res.status(403).json({ error: "Previews are disabled for this content type" }); return;
    }
    const token = createContentPreview({ contentId: id, siteId: session.siteId, version: Number(row.version) });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ url: `/preview/${token}` });
  } catch (err) { sendServerError(res, "content", err); }
});

router.put("/:id/schedule", requireSession, scheduleRateLimit, async (req, res) => {
  const parsed = ContentScheduleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message }); return; }
  const session = req.session!;
  const id = param(req.params.id);
  try {
    const db = await getDb();
    const [row] = await db.query<Record<string, unknown>>("SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1", [id, session.siteId]);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const resource = { contentType: String(row.type), locale: String(row.locale), ownerId: row.author_id as string | null };
    if (!(await userCan(session, "content:publish", resource)) || !(await userCan(session, "content:update", resource))) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    await setContentSchedule(id, session, parsed.data);
    const [next] = await db.query<Record<string, unknown>>("SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1", [id, session.siteId]);
    res.json(serializeEditorContent(next!, await getWorkingRevision(id, session.siteId)));
  } catch (err) {
    if (err instanceof ScheduleError) { res.status(err.status).json({ error: err.message }); return; }
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

async function loadTermsRow(id: string, siteId: string): Promise<Record<string, unknown> | undefined> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT id, type, author_id, locale, status, trashed_at, published_at FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
    [id, siteId],
  );
  return rows[0];
}

router.get("/:id/terms", requireSession, async (req, res) => {
  const session = req.session!;
  try {
    const row = await loadTermsRow(param(req.params.id), session.siteId);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const decision = await openContent(session, row);
    if (decision !== "open") {
      sendClosed(res, decision);
      return;
    }
    res.json({ terms: await getContentTerms(session.siteId, String(row.id)) });
  } catch (err) {
    sendServerError(res, "content", err);
  }
});

router.put("/:id/terms", requireSession, async (req, res) => {
  const session = req.session!;
  const body = z.object({ terms: ContentTermsSchema }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message });
    return;
  }
  try {
    const row = await loadTermsRow(param(req.params.id), session.siteId);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const resource = contentResource(row);
    if (!(await userCan(session, "content:update", resource))) {
      if (!isPubliclyPublished(row)) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const terms = await setContentTerms(session.siteId, { id: String(row.id), type: String(row.type) }, body.data.terms);
    await invalidateContentCache(false, session.siteId);
    res.json({ terms });
  } catch (err) {
    if (err instanceof TaxonomyError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendServerError(res, "content", err);
  }
});

router.get("/:id/revisions", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  try {
    const db = await getDb();
    const existing = await db.query<Record<string, unknown>>(
      "SELECT id, type, locale, author_id, status, trashed_at, published_at FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, session.siteId],
    );
    const row = existing[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const decision = await openRevision(session, row);
    if (decision !== "open") {
      sendClosed(res, decision);
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
    const decision = await openRevision(session, row);
    if (decision !== "open") {
      sendClosed(res, decision);
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
    const existing = await db.query<Record<string, unknown>>(
      "SELECT type, locale, author_id, status, trashed_at, published_at FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, session.siteId],
    );
    const contentRow = existing[0];
    if (!contentRow) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    const decision = await openRevision(session, contentRow);
    if (decision !== "open") {
      sendClosed(res, decision);
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
    if (!(await userCan(session, "content:revisions:restore", contentResource(row)))) {
      if (!isPubliclyPublished(row)) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const revision = await getRevisionById(id, session.siteId, revisionId);
    if (!revision || revision.kind === "working") {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    /**
     * Restoring writes the draft just like a save, so it carries the same
     * concurrency checks: never replace a draft or version the client did
     * not see (justflows-ce#302). Omitted fields keep the old behaviour.
     */
    const liveVersion = Number(row.version ?? 1) || 1;
    const expectedLive = typeof req.body?.expectedVersion === "number" ? req.body.expectedVersion : undefined;
    if (expectedLive !== undefined && expectedLive !== liveVersion) {
      res.status(409).json({
        code: "version_conflict",
        error: `Version conflict: expected ${expectedLive}, got ${liveVersion}`,
        expectedVersion: expectedLive,
        actualVersion: liveVersion,
      });
      return;
    }
    if (String(row.status) === "published") {
      const rawWorking = req.body?.expectedWorkingVersion;
      const expectedWorking =
        typeof rawWorking === "number" && Number.isInteger(rawWorking) && rawWorking >= 0 ? rawWorking : undefined;
      const draftConflict = workingRevisionConflict(await getWorkingRevision(id, session.siteId), expectedWorking);
      if (draftConflict) {
        res.status(409).json(draftConflict);
        return;
      }
    }
    if (!(await userCan(session, "content:locks:manage", contentResource(row)))) {
      const violations = await lockViolationsForWrite(row, revisionToSnapshot(revision).blocks, session.siteId);
      if (violations.length) {
        res.status(403).json(blockLockedBody(violations));
        return;
      }
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
  const rawWorking = req.body?.expectedWorkingVersion;
  const expectedWorkingVersion =
    typeof rawWorking === "number" && Number.isInteger(rawWorking) && rawWorking >= 0 ? rawWorking : undefined;
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
    await publishRow(rows[0], { expectedVersion, expectedWorkingVersion }, session, res);
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
    if (!(await userCan(session, "content:revisions:discard", contentResource(row)))) {
      if (!isPubliclyPublished(row)) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const working = await getWorkingRevision(id, session.siteId);
    if (working) {
      if (row.publish_on) {
        const changed = await db.execute("UPDATE content SET publish_on = NULL, version = version + 1 WHERE id = ? AND site_id = ? AND version = ?", [id, session.siteId, Number(row.version)]);
        if (changed !== 1) { res.status(409).json({ error: "Content changed; reload before discarding" }); return; }
        row.publish_on = null;
        row.version = Number(row.version) + 1;
        await auditLog({ siteId: session.siteId, action: row.unpublish_on ? "content.schedule_changed" : "content.schedule_cancelled", actorId: session.userId, target: id, detail: "Scheduled draft discarded" });
      }
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

  const actor: ContentActor = session;
  const result = await trashContentEntry({ id, ...row }, actor);
  res.status(result.status).json(result.body);
});

export default router;
