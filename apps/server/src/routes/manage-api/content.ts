// SPDX-License-Identifier: MIT

import { Router, type Request, type Response } from "express";
import type { UserCapability } from "@justflows/sdk";
import { z } from "zod";
import { ContentScheduleSchema, ScheduleError, setContentSchedule } from "../../lib/content/content-scheduling-db.js";
import { getDb } from "../../lib/database/db.js";
import { normalizeFields, serializeContentRow } from "../../lib/content/content-api.js";
import {
  getRevisionById,
  getWorkingRevision,
  listRevisions,
  revisionColumn,
  serializeRevision,
} from "../../lib/content/content-revisions.js";
import { resolveContentLocale } from "../../lib/i18n/languages-db.js";
import { invalidateContentCache } from "../../lib/content/content-public.js";
import { ContentTermsSchema, getContentTerms, setContentTerms, TaxonomyError } from "../../lib/content/taxonomies-db.js";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { PAGE_HEADER_REF_FIELD, SITE_DEFAULT_HEADER_REF } from "../../lib/rendering/page-header.js";
import {
  applyDraftUpdate,
  blockLockedBody,
  lockViolationsForWrite,
  CreateContentSchema,
  createContentEntry,
  now,
  PatchContentSchema,
  publishRow,
  saveWorkingRow,
  trashContentEntry,
  unpublishRow,
  type ContentActor,
} from "../../lib/content/content-write.js";
import { getEffectiveAccess } from "../../lib/auth/access-policy.js";
import { keyCan } from "../../lib/auth/api-keys.js";
import {
  canCreateHere,
  capabilityReach,
  draftReach,
  editorialListFilter,
  isPubliclyPublished,
  narrowerReach,
  type EditorialReach,
} from "../../lib/content/content-visibility.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { badRequest, ensureKeyCan, forbidden, notFound, paginate, relay, sendJson } from "./envelope.js";

const router = Router();

function actorOf(req: Request): ContentActor {
  const owner = req.apiKeyOwner!;
  return { siteId: owner.siteId, userId: owner.userId, role: owner.role };
}

/**
 * Unpublished rows stay hidden from a key that cannot edit them and did not
 * create them. The response is 404 so the id is not confirmed.
 */
async function hideUnpublished(
  req: Request,
  res: Response,
  row: Record<string, unknown>,
  allow: UserCapability | null = null,
): Promise<boolean> {
  if (isPubliclyPublished(row)) return false;
  const key = req.apiKey;
  const owner = req.apiKeyOwner;
  if (!key || !owner) {
    notFound(res);
    return true;
  }
  const resource = {
    contentType: String(row.type ?? ""),
    locale: String(row.locale ?? ""),
    ownerId: (row.author_id as string | null) ?? null,
  };
  const canUpdate = await keyCan(key, owner, "content:update", resource);
  const canCreateOwn =
    String(row.author_id ?? "") === owner.userId &&
    (await keyCan(key, owner, "content:create", { ...resource, ownerId: owner.userId }));
  const canAllow = allow ? await keyCan(key, owner, allow, resource) : false;
  if (canUpdate || canCreateOwn || canAllow) return false;
  notFound(res);
  return true;
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
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
  const author = typeof req.query.author === "string" ? req.query.author : undefined;
  if (!(await ensureKeyCan(req, res, "content:read", { contentType: type, locale }))) return;

  try {
    const db = await getDb();
    const access = await getEffectiveAccess(owner.userId, owner.siteId, owner.role, db);
    const readScope = access.policy.scopes?.["content:read"];
    const request = { siteId: owner.siteId, contentType: type, locale };
    const key = req.apiKey!;
    const keyCapabilities = key.capabilities ?? [];
    const keyUpdate: EditorialReach = keyCapabilities.includes("content:update")
      ? key.scope.ownership === "self"
        ? "own"
        : "all"
      : "none";
    const reach = draftReach(
      narrowerReach(capabilityReach(access, "content:update", request), keyUpdate),
      canCreateHere(access, request) && keyCapabilities.includes("content:create"),
    );
    const listed = editorialListFilter({ reach, status, actorId: owner.userId });
    if ("error" in listed) return forbidden(res);
    const keyRevisions: EditorialReach = keyCapabilities.includes("content:revisions:read")
      ? key.scope.ownership === "self"
        ? "own"
        : "all"
      : "none";
    const revisionReach = narrowerReach(capabilityReach(access, "content:revisions:read", request), keyRevisions);
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
    const params: (string | number | null)[] = [];
    if (revisionReach === "own") params.push(owner.userId);
    params.push(owner.siteId);
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
    if (search) {
      // Escape LIKE wildcards with `!` (portable across all three engines) so a
      // search for "50%" matches the text literally.
      const pattern = `%${search.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
      sql += " AND (LOWER(c.title) LIKE LOWER(?) ESCAPE '!' OR LOWER(c.slug) LIKE LOWER(?) ESCAPE '!')";
      params.push(pattern, pattern);
    }
    if (author) {
      sql += " AND c.author_id = ?";
      params.push(author);
    }
    // Scope enforced on the read itself, not only at route entry.
    const keyOwnership = req.apiKey?.scope.ownership;
    if (readScope?.ownership === "self" || keyOwnership === "self") {
      sql += " AND c.author_id = ?";
      params.push(owner.userId);
    }
    sql += listed.sql;
    params.push(...listed.params);
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
    if (await hideUnpublished(req, res, row)) return;
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

    if (
      body.data.blocks !== undefined &&
      !(await keyCan(req.apiKey!, req.apiKeyOwner!, "content:locks:manage", resource))
    ) {
      const violations = await lockViolationsForWrite(row, body.data.blocks, req.apiKeyOwner!.siteId);
      if (violations.length) {
        res.status(403).json(blockLockedBody(violations));
        return;
      }
    }
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

const HeaderRefSchema = z.object({ ref: z.string().max(64) });

router.put("/:id/header-ref", async (req, res) => {
  const id = req.params.id;
  const parsed = HeaderRefSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "Invalid header ref");
  const raw = parsed.data.ref.trim();
  const ref = raw === SITE_DEFAULT_HEADER_REF ? "" : raw;
  try {
    const owner = req.apiKeyOwner!;
    const row = await loadRow(owner.siteId, id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:update", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    const withRef = (value: unknown): string => {
      const fields = normalizeFields(value);
      if (ref) fields[PAGE_HEADER_REF_FIELD] = ref;
      else delete fields[PAGE_HEADER_REF_FIELD];
      return JSON.stringify(fields);
    };
    const db = await getDb();
    await db.run("UPDATE content SET fields = ?, updated_at = ? WHERE id = ? AND site_id = ?", [
      withRef(row.fields),
      now(),
      id,
      owner.siteId,
    ]);
    const working = await getWorkingRevision(id, owner.siteId);
    if (working) {
      await db.run(
        `UPDATE revisions SET fields = ? WHERE content_id = ? AND site_id = ? AND ${revisionColumn("kind")} = 'working'`,
        [withRef(working.fields), id, owner.siteId],
      );
    }
    await invalidateContentCache();
    await revalidateOnUpdate("content");
    res.json({ ok: true, ref: ref || SITE_DEFAULT_HEADER_REF });
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.get("/:id/terms", async (req, res) => {
  try {
    const owner = req.apiKeyOwner!;
    const row = await loadRow(owner.siteId, req.params.id);
    if (!row) return notFound(res);
    if (await hideUnpublished(req, res, row)) return;
    if (
      !(await ensureKeyCan(req, res, "content:read", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    sendJson(req, res, { terms: await getContentTerms(owner.siteId, String(row.id)) });
  } catch (err) {
    sendServerError(res, "manage.content", err);
  }
});

router.put("/:id/terms", async (req, res) => {
  const parsed = z.object({ terms: ContentTermsSchema }).safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.issues[0]?.message ?? "Invalid terms");
  try {
    const owner = req.apiKeyOwner!;
    const row = await loadRow(owner.siteId, req.params.id);
    if (!row) return notFound(res);
    if (
      !(await ensureKeyCan(req, res, "content:update", {
        contentType: String(row.type),
        locale: String(row.locale),
        ownerId: row.author_id as string | null,
      }))
    )
      return;
    const terms = await setContentTerms(owner.siteId, { id: String(row.id), type: String(row.type) }, parsed.data.terms);
    await invalidateContentCache(false, owner.siteId);
    res.json({ terms });
  } catch (err) {
    if (err instanceof TaxonomyError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendServerError(res, "manage.content", err);
  }
});

router.get("/:id/revisions", async (req, res) => {
  try {
    const row = await loadRow(req.apiKeyOwner!.siteId, req.params.id);
    if (!row) return notFound(res);
    if (await hideUnpublished(req, res, row, "content:revisions:read")) return;
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
    if (await hideUnpublished(req, res, row, "content:revisions:read")) return;
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
