// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { getDb } from "../database/db.js";
import { commentPlainText, notifyOnApproval, sanitizeCommentBody } from "./comments-public.js";
import { invalidatePublicPages } from "../cache/public-cache.js";
import { auditLog } from "../security/audit-log.js";
import { trainFromMark } from "./comments-rules.js";

/**
 * Shared comment-moderation logic behind both `routes/comments.ts` (cookie
 * auth) and the federated management API. Callers do the capability check and
 * supply the actor; every read and write lives here.
 */

export const COMMENT_STATUSES = new Set(["pending", "approved", "spam", "trash"]);

export interface ModerationActor {
  siteId: string;
  userId: string;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ModerationResult {
  status: number;
  body: unknown;
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Post pages cache their rendered comment thread; drop it on any change. */
async function bustCommentCache(): Promise<void> {
  await invalidatePublicPages();
}

function auditTrash(actor: ModerationActor, action: "trash.trashed" | "trash.purged", id: string): void {
  void auditLog({
    siteId: actor.siteId,
    action,
    actorId: actor.userId,
    actorRole: actor.role ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    target: id,
    detail: "type=comment",
  });
}

export interface ListCommentsQuery {
  status?: string;
  limit?: number;
  page?: number;
}

export async function listComments(
  siteId: string,
  query: ListCommentsQuery,
): Promise<{ comments: Record<string, unknown>[]; total: number; page: number; limit: number }> {
  const status = COMMENT_STATUSES.has(query.status ?? "") ? (query.status as string) : "pending";
  const limit = Math.min(Math.max(Number(query.limit ?? 30) || 30, 1), 100);
  const page = Math.min(Math.max(Number(query.page ?? 1) || 1, 1), 100_000);
  const offset = (page - 1) * limit;

  const db = await getDb();
  const [rows, countRows] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT c.id, c.parent_id, c.content_id, c.author_name, c.author_email, c.author_url,
              c.body, c.status, c.created_at, c.edited_at,
              c.spam_score, c.spam_reasons, c.held_reason, c.ip_address,
              co.title AS content_title, co.slug AS content_slug
         FROM comments c
         LEFT JOIN content co ON c.content_id = co.id
        WHERE c.site_id = ? AND c.status = ?
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?`,
      [siteId, status, limit, offset],
    ),
    db.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM comments WHERE site_id = ? AND status = ?",
      [siteId, status],
    ),
  ]);
  return { comments: rows, total: Number(countRows[0]?.total ?? 0), page, limit };
}

const STATUS_MAP = {
  approve: "approved",
  pending: "pending",
  spam: "spam",
  trash: "trash",
} as const;

export type ModerationAction = keyof typeof STATUS_MAP;

/** Feed the "mark as spam" training loop from an observed status transition. */
function trainFromTransition(siteId: string, id: string, oldStatus: string, newStatus: string): void {
  if (newStatus === "spam" && oldStatus !== "spam") {
    void trainFromMark(siteId, id, "spam").catch(() => undefined);
  } else if (oldStatus === "spam" && newStatus === "approved") {
    void trainFromMark(siteId, id, "unspam").catch(() => undefined);
  }
}

export async function setCommentStatuses(
  actor: ModerationActor,
  ids: string[],
  action: ModerationAction,
): Promise<ModerationResult> {
  const newStatus = STATUS_MAP[action];
  const db = await getDb();
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += 200) batches.push(ids.slice(offset, offset + 200));
  const priorStatus = new Map<string, string>();
  for (const batch of batches) {
    const rows = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM comments WHERE site_id = ? AND id IN (${batch.map(() => "?").join(", ")})`,
      [actor.siteId, ...batch],
    );
    for (const row of rows) priorStatus.set(row.id, row.status);
  }
  const timestamp = now();
  for (const batch of batches) {
    const placeholders = batch.map(() => "?").join(", ");
    if (newStatus === "trash") {
      await db.run(
        `UPDATE comments SET original_status = status, status = ?, trashed_at = ?, trashed_by = ?, updated_at = ? WHERE site_id = ? AND id IN (${placeholders}) AND status != 'trash'`,
        [newStatus, timestamp, actor.userId, timestamp, actor.siteId, ...batch],
      );
      for (const id of batch) auditTrash(actor, "trash.trashed", id);
    } else {
      await db.run(
        `UPDATE comments SET status = ?, trashed_at = NULL, trashed_by = NULL, updated_at = ? WHERE site_id = ? AND id IN (${placeholders})`,
        [newStatus, timestamp, actor.siteId, ...batch],
      );
      for (const id of batch) {
        const prior = priorStatus.get(id);
        if (prior) trainFromTransition(actor.siteId, id, prior, newStatus);
      }
    }
  }
  if (newStatus === "approved") void notifyOnApproval(actor.siteId, ids).catch(() => undefined);
  await bustCommentCache();
  return { status: 200, body: { ok: true, updated: ids.length } };
}

export async function editComment(
  actor: ModerationActor,
  id: string,
  patch: { body?: string; status?: "pending" | "approved" | "spam" | "trash" },
): Promise<ModerationResult> {
  if (patch.body === undefined && patch.status === undefined) {
    return { status: 400, body: { error: "Nothing to update" } };
  }
  const db = await getDb();
  let priorStatus: string | undefined;
  if (patch.status !== undefined) {
    const priorRows = await db.query<{ status: string }>(
      "SELECT status FROM comments WHERE id = ? AND site_id = ? LIMIT 1",
      [id, actor.siteId],
    );
    priorStatus = priorRows[0]?.status;
  }
  const sets: string[] = ["updated_at = ?"];
  const params: (string | number | null)[] = [now()];
  if (patch.body !== undefined) {
    const clean = sanitizeCommentBody(patch.body);
    if (!commentPlainText(clean)) return { status: 400, body: { error: "Comment body is empty" } };
    sets.push("body = ?", "edited_at = ?");
    params.push(clean, now());
  }
  if (patch.status !== undefined) {
    if (patch.status === "trash") sets.push("original_status = status");
    sets.push("status = ?", "trashed_at = ?", "trashed_by = ?");
    params.push(
      patch.status,
      patch.status === "trash" ? now() : null,
      patch.status === "trash" ? actor.userId : null,
    );
  }
  params.push(id, actor.siteId);
  await db.run(`UPDATE comments SET ${sets.join(", ")} WHERE id = ? AND site_id = ?`, params);

  if (patch.status === "approved") void notifyOnApproval(actor.siteId, [id]).catch(() => undefined);
  await bustCommentCache();
  if (patch.status === "trash") auditTrash(actor, "trash.trashed", id);
  if (patch.status !== undefined && priorStatus) {
    trainFromTransition(actor.siteId, id, priorStatus, patch.status);
  }
  return { status: 200, body: { ok: true } };
}

export async function replyToComment(
  actor: ModerationActor,
  parentId: string,
  body: string,
): Promise<ModerationResult> {
  const db = await getDb();
  const parentRows = await db.query<{ id: string; content_id: string }>(
    "SELECT id, content_id FROM comments WHERE id = ? AND site_id = ? LIMIT 1",
    [parentId, actor.siteId],
  );
  const parent = parentRows[0];
  if (!parent) return { status: 404, body: { error: "Comment not found" } };

  const userRows = await db.query<{ display_name: string; username: string; email: string }>(
    "SELECT display_name, username, email FROM users WHERE id = ? AND site_id = ? LIMIT 1",
    [actor.userId, actor.siteId],
  );
  const u = userRows[0];
  const authorName = (u?.display_name || u?.username || "Moderator").slice(0, 120);
  const clean = sanitizeCommentBody(body);
  if (!commentPlainText(clean)) return { status: 400, body: { error: "Reply is empty" } };

  const id = randomUUID();
  const ts = now();
  await db.run(
    `INSERT INTO comments
       (id, site_id, content_id, parent_id, author_name, author_email, body, status, user_id, notify, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
    [id, actor.siteId, parent.content_id, parent.id, authorName, u?.email ?? null, clean, actor.userId, false, ts, ts],
  );
  void notifyOnApproval(actor.siteId, [id]).catch(() => undefined);
  await bustCommentCache();
  return { status: 200, body: { ok: true, id } };
}

/** Hard-delete comments that are already in the trash. */
export async function purgeTrashedComments(
  actor: ModerationActor,
  ids: string[],
): Promise<ModerationResult> {
  const db = await getDb();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const placeholders = batch.map(() => "?").join(", ");
    await db.run(`DELETE FROM comments WHERE site_id = ? AND id IN (${placeholders}) AND status = 'trash'`,
      [actor.siteId, ...batch]);
    for (const id of batch) auditTrash(actor, "trash.purged", id);
  }
  await bustCommentCache();
  return { status: 200, body: { ok: true, deleted: ids.length } };
}
