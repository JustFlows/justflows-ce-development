// SPDX-License-Identifier: MIT

import { Router, type Request } from "express";
import { ContentScheduleSchema, ScheduleError, setContentSchedule } from "../../lib/content-scheduling-db.js";
import { getDb } from "../../lib/db.js";
import { serializeContentRow } from "../../lib/content-api.js";
import {
  getRevisionById,
  listRevisions,
  revisionColumn,
  serializeRevision,
} from "../../lib/content-revisions.js";
import { resolveContentLocale } from "../../lib/i18n/languages-db.js";
import {
  applyDraftUpdate,
  CreateContentSchema,
  createContentEntry,
  PatchContentSchema,
  publishRow,
  saveWorkingRow,
  trashContentEntry,
  unpublishRow,
  type ContentActor,
} from "../../lib/content-write.js";
import { getEffectiveAccess } from "../../lib/access-policy.js";
import { sendServerError } from "../../lib/send-error.js";
import { badRequest, ensureKeyCan, notFound, paginate, relay, sendJson } from "./envelope.js";

const router = Router();

function actorOf(req: Request): ContentActor {
  const owner = req.apiKeyOwner!;
  return { siteId: owner.siteId, userId: owner.userId, role: owner.role };
}

/** Load a live (non-trashed) content row scoped to the key owner's site. */
async function loadRow(siteId: string, id: string): Promise<Record<string, unknown> | null> {
  const rows = await (
    await getDb()
  ).query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
    [id, siteId],
  );
  return rows[0] ?? null;
}

router.get("/", async (req, res) => {
  const owner = req.apiKeyOwner!;
  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const locale = typeof req.query.locale === "string" ? req.query.locale : undefined;
  if (!(await ensureKeyCan(req, res, "content:read", { contentType: type, locale }))) return;

  try {
    const db = await getDb();
    const access = await getEffectiveAccess(owner.userId, owner.siteId, owner.role, db);
    const readScope = access.policy.scopes?.["content:read"];
    let sql = `SELECT c.id, c.type, c.title, c.slug, c.locale, c.translation_group_id, c.excerpt, c.status,
              c.author_id, c.publish_on, c.unpublish_on, c.published_at, c.created_at, c.updated_at, c.version,
              w.id AS working_revision_id
       FROM content c
       LEFT JOIN revisions w ON w.content_id = c.id AND w.site_id = c.site_id AND w.${revisionColumn("kind")} = 'working'
       WHERE c.site_id = ?`;
    const params: (string | number | null)[] = [owner.siteId];
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
    if (locale) {
      sql += " AND c.locale = ?";
      params.push(await resolveContentLocale(locale, owner.siteId));
    }
    // Scope enforced on the read itself, not only at route entry.
    const keyOwnership = req.apiKey?.scope.ownership;
    if (readScope?.ownership === "self" || keyOwnership === "self") {
      sql += " AND c.author_id = ?";
      params.push(owner.userId);
    }
    sql += " ORDER BY c.updated_at DESC";
    const rows = await db.query<Record<string, unknown>>(sql, params);
    sendJson(req, res, paginate(rows.map(serializeContentRow), req));
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:read", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    sendJson(req, res, serializeContentRow(row));
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.post("/", async (req, res) => {
  const body = CreateContentSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid content");
  if (
    !(await ensureKeyCan(req, res, "content:create", {
      contentType: body.data.type,
      locale: body.data.locale,
      ownerId: req.apiKeyOwner!.userId,
    }))
  )
    return;
  try {
    relay(res, await createContentEntry(body.data, actorOf(req)));
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.patch("/:id", async (req, res) => {
  const body = PatchContentSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid patch");
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    const resource = {
      contentType: String(row.type),
      locale: String(row.locale),
      ownerId: row.author_id as string | null,
    };
    if (!(await ensureKeyCan(req, res, "content:update", resource))) return;
    const wantsPublish = body.data.status === "published";
    const status = String(row.status);
    const wantsUnpublish =
      status === "published" && body.data.status !== undefined && body.data.status !== "published";
    if ((wantsPublish || (body.data.status !== undefined && Boolean(row.publish_on || row.unpublish_on))) && !(await ensureKeyCan(req, res, "content:publish", resource))) return;

    const actor = actorOf(req);
    if (status === "published" && wantsUnpublish) {
      await unpublishRow(row, body.data, actor, res);
      return;
    }
    if (wantsPublish) {
      await publishRow(row, body.data, actor, res);
      return;
    }
    if (status === "published") {
      await saveWorkingRow(row, body.data, actor, res);
      return;
    }
    await applyDraftUpdate(row, body.data, actor, res);
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.put("/:id/schedule", async (req, res) => {
  const parsed = ContentScheduleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "Invalid schedule");
  try {
    const actor = actorOf(req);
    const row = await loadRow(actor.siteId, req.params.id);
    if (!row) return notFound(res);
    const resource = { contentType: String(row.type), locale: String(row.locale), ownerId: row.author_id as string | null };
    if (!(await ensureKeyCan(req, res, "content:publish", resource)) || !(await ensureKeyCan(req, res, "content:update", resource))) return;
    await setContentSchedule(req.params.id, actor, parsed.data);
    sendJson(req, res, serializeContentRow((await loadRow(actor.siteId, req.params.id))!));
  } catch (err) {
    if (err instanceof ScheduleError) { res.status(err.status).json({ error: err.message }); return; }
    sendServerError(res, "manage.content", err);
  }
});

router.post("/:id/publish", async (req, res) => {
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:publish", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    const expectedVersion =
      typeof req.body?.expectedVersion === "number" ? req.body.expectedVersion : undefined;
    await publishRow(row, { expectedVersion }, actorOf(req), res);
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.post("/:id/unpublish", async (req, res) => {
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:publish", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    await unpublishRow(row, {}, actorOf(req), res);
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:delete", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    relay(
      res,
      await trashContentEntry(
        {
          id: String(row.id),
          author_id: (row.author_id as string | null) ?? null,
          type: String(row.type),
          locale: String(row.locale),
          translation_group_id: (row.translation_group_id as string | null) ?? null,
        },
        actorOf(req),
      ),
    );
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.get("/:id/revisions", async (req, res) => {
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:revisions:read", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    const revisions = await listRevisions(String(row.id), req.apiKeyOwner!.siteId);
    sendJson(req, res, paginate(revisions.map((r) => serializeRevision(r)), req));
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.get("/:id/revisions/:revisionId", async (req, res) => {
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:revisions:read", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    const revision = await getRevisionById(
      String(row.id),
      req.apiKeyOwner!.siteId,
      req.params.revisionId,
    );
    if (!revision) return notFound(res, "Revision not found");
    sendJson(req, res, serializeRevision(revision, { includeBody: true }));
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

export default router;
