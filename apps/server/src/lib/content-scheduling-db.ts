// SPDX-License-Identifier: MIT

import { enqueueWebhookEvent } from "./webhooks.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JobScheduler } from "@justflows/jobs";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { getDb } from "./db.js";
import { serializeContentRow, toIsoTimestamp } from "./content-api.js";
import {
  getWorkingRevision,
  insertHistoricalSnapshot,
  revisionColumn,
  revisionToSnapshot,
  rowToSnapshot,
} from "./content-revisions.js";
import { getRuntimeHooks } from "./plugin-runtime.js";
import { invalidateContentCache } from "./content-public.js";
import { rememberContentPermalink, uniquePermalinkSlug } from "./permalinks-db.js";
import { auditLog } from "./audit-log.js";
import type { ContentActor } from "./content-write.js";

export const ContentScheduleSchema = z
  .object({
    publishOn: z.iso.datetime({ offset: true }).nullable(),
    unpublishOn: z.iso.datetime({ offset: true }).nullable(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type ContentScheduleInput = z.infer<typeof ContentScheduleSchema>;

export function scheduleError(
  input: ContentScheduleInput,
  status: string,
  time = Date.now(),
): string | null {
  if (input.publishOn && Date.parse(input.publishOn) <= time)
    return "Publish on must be in the future";
  if (input.unpublishOn && Date.parse(input.unpublishOn) <= time)
    return "Unpublish on must be in the future";
  if (
    input.publishOn &&
    input.unpublishOn &&
    Date.parse(input.unpublishOn) <= Date.parse(input.publishOn)
  )
    return "Unpublish on must be after Publish on";
  if (!input.publishOn && input.unpublishOn && status !== "published")
    return "Unpublish on requires published content or a publish date";
  return null;
}

function sqlTime(value: string | Date): string {
  const iso = new Date(value).toISOString();
  // postgres serializes inferred TIMESTAMPTZ parameters through Date; keep Z.
  return process.env.DB_DRIVER === "postgres" ? iso : iso.slice(0, 19).replace("T", " ");
}

export class ScheduleError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Schedule metadata changes never dispatch publication hooks. The saved draft is published when due. */
export async function setContentSchedule(
  id: string,
  actor: ContentActor,
  input: ContentScheduleInput,
): Promise<void> {
  const db = await getDb();
  const action = await db.transaction(async (tx) => {
    const [row] = await tx.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL FOR UPDATE",
      [id, actor.siteId],
    );
    if (!row) throw new ScheduleError(404, "Content not found");
    if (Number(row.version) !== input.expectedVersion)
      throw new ScheduleError(409, "Content changed; reload before scheduling");
    const error = scheduleError(input, String(row.status));
    if (error) throw new ScheduleError(400, error);
    const nextStatus =
      row.status === "published" ? "published" : input.publishOn ? "scheduled" : "draft";
    await tx.run(
      "UPDATE content SET publish_on = ?, unpublish_on = ?, schedule_actor_id = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND site_id = ?",
      [
        input.publishOn ? sqlTime(input.publishOn) : null,
        input.unpublishOn ? sqlTime(input.unpublishOn) : null,
        input.publishOn || input.unpublishOn ? actor.userId : null,
        nextStatus,
        sqlTime(new Date()),
        id,
        actor.siteId,
      ],
    );
    // Metadata does not change the live snapshot, so a valid working draft remains valid.
    await tx.run(
      `UPDATE revisions SET base_version = base_version + 1 WHERE content_id = ? AND site_id = ? AND ${revisionColumn("kind")} = 'working' AND base_version = ?`,
      [id, actor.siteId, input.expectedVersion],
    );
    return !input.publishOn && !input.unpublishOn
      ? ("content.schedule_cancelled" as const)
      : row.publish_on || row.unpublish_on
        ? ("content.schedule_changed" as const)
        : ("content.schedule_set" as const);
  });
  await auditLog({
    siteId: actor.siteId,
    action,
    actorId: actor.userId,
    actorRole: actor.role,
    target: id,
    detail: JSON.stringify({ publishOn: input.publishOn, unpublishOn: input.unpublishOn }),
  });
}

/** Decide from persisted deadlines, including a complete window missed while offline. */
export function dueTransition(
  row: Record<string, unknown>,
  time: number,
): "publish" | "unpublish" | "expire" | null {
  if (row.trashed_at || row.status === "trashed") return null;
  const publish = toIsoTimestamp(row.publish_on);
  const unpublish = toIsoTimestamp(row.unpublish_on);
  if (unpublish && Date.parse(unpublish) <= time)
    return row.status === "published" ? "unpublish" : "expire";
  if (
    publish &&
    Date.parse(publish) <= time &&
    ["published", "scheduled"].includes(String(row.status))
  )
    return "publish";
  return null;
}

/** Row locks serialize workers; snapshot, deadline removal and event commit together. */
export async function transitionScheduledContent(
  id: string,
  siteId: string,
  time = new Date(),
): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? FOR UPDATE",
      [id, siteId],
    );
    if (!row) return false;
    const transition = dueTransition(row, time.getTime());
    if (!transition) return false;
    const actorId = row.schedule_actor_id == null ? null : String(row.schedule_actor_id);
    const working = await getWorkingRevision(id, siteId, tx);
    if (
      transition === "publish" &&
      working &&
      row.status === "published" &&
      working.baseVersion !== Number(row.version)
    ) {
      throw new ScheduleError(409, "Scheduled revision conflicts with the live version");
    }
    const snapshot = working ? revisionToSnapshot(working) : rowToSnapshot(row);
    snapshot.blocks = sanitizeBlockDocument(snapshot.blocks) as typeof snapshot.blocks;
    const before = serializeContentRow(row);
    const after = {
      ...before,
      ...snapshot,
      status: transition === "publish" ? "published" : "draft",
      publishedAt:
        transition === "publish" ? (before.publishedAt ?? time.toISOString()) : before.publishedAt,
    };
    if (transition === "publish") {
      const hooks = getRuntimeHooks();
      const ref = { contentId: id, siteId, revision: snapshot, revisionId: working?.id };
      await hooks.dispatchGate("content.beforeUpdate", ref, { siteId, source: "job" });
      await hooks.dispatchGate("content.beforePublish", ref, { siteId, source: "job" });
      snapshot.slug = await uniquePermalinkSlug(after);
      after.slug = snapshot.slug;
    }
    await insertHistoricalSnapshot(row, actorId, rowToSnapshot(row), tx);
    await tx.run(
      `UPDATE content SET title = ?, slug = ?, excerpt = ?, blocks = ?, fields = ?, status = ?, published_at = ?,
       publish_on = NULL, unpublish_on = ?, updated_at = ?, version = version + 1 WHERE id = ? AND site_id = ?`,
      [
        snapshot.title,
        snapshot.slug,
        snapshot.excerpt,
        JSON.stringify(snapshot.blocks),
        JSON.stringify(snapshot.fields),
        after.status,
        after.publishedAt ? sqlTime(after.publishedAt) : null,
        transition === "publish" && row.unpublish_on
          ? sqlTime(toIsoTimestamp(row.unpublish_on)!)
          : null,
        sqlTime(time),
        id,
        siteId,
      ],
    );
    if (working) {
      // Preserve the executed draft in history, including when an expiry carries it back to draft.
      await insertHistoricalSnapshot(row, actorId, snapshot, tx);
      await tx.run("DELETE FROM revisions WHERE id = ? AND site_id = ? AND version = ?", [
        working.id,
        siteId,
        working.version,
      ]);
    }
    const event =
      transition === "publish"
        ? "content.published"
        : transition === "unpublish"
          ? "content.unpublished"
          : "content.schedule_expired";
    const eventId = randomUUID();
    if (event !== "content.schedule_expired")
      await enqueueWebhookEvent(
        event,
        {
          contentId: id,
          siteId,
          type: after.type,
          locale: after.locale,
          eventId,
          scheduleEventId: eventId,
        },
        { siteId, source: "job" },
        tx,
      );
    await tx.run(
      "INSERT INTO content_schedule_events (id, content_id, site_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        eventId,
        id,
        siteId,
        event,
        JSON.stringify({ before, after, actorId, transition }),
        sqlTime(time),
      ],
    );
    return true;
  });
}

/** At-least-once delivery: consumers receive a stable eventId for deduplication. */
export async function deliverScheduleEvents(): Promise<void> {
  const db = await getDb();
  const events = await db.query<{
    id: string;
    site_id: string;
    content_id: string;
    event: string;
    payload: string;
  }>("SELECT * FROM content_schedule_events ORDER BY created_at, id LIMIT 100");
  for (const event of events) {
    const payload = JSON.parse(event.payload) as {
      before: ReturnType<typeof serializeContentRow>;
      after: ReturnType<typeof serializeContentRow>;
      actorId: string | null;
      transition: string;
    };
    await rememberContentPermalink(payload.before, payload.after);
    await invalidateContentCache(true);
    if (event.event !== "content.schedule_expired") {
      await getRuntimeHooks().dispatchAction(
        event.event,
        {
          contentId: event.content_id,
          siteId: event.site_id,
          type: payload.after.type,
          locale: payload.after.locale,
          eventId: event.id,
          scheduleEventId: event.id,
        },
        { siteId: event.site_id, source: "job" },
      );
    }
    await auditLog({
      siteId: event.site_id,
      action: "content.schedule_executed",
      actorId: payload.actorId,
      target: event.content_id,
      detail: JSON.stringify({ eventId: event.id, transition: payload.transition }),
    });
    await db.run("DELETE FROM content_schedule_events WHERE id = ?", [event.id]);
  }
}

let running = false;
let scanCursor: string | null = null;
export async function runContentSchedules(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const db = await getDb();
    const time = new Date();
    const rows = await db.query<{ id: string; site_id: string }>(
      `SELECT id, site_id FROM content WHERE trashed_at IS NULL AND (publish_on <= ? OR unpublish_on <= ?)${scanCursor ? " AND id > ?" : ""} ORDER BY id LIMIT 100`,
      [sqlTime(time), sqlTime(time), ...(scanCursor ? [scanCursor] : [])],
    );
    for (const row of rows) {
      try {
        await transitionScheduledContent(row.id, row.site_id, time);
      } catch {
        console.error("[justflows] Scheduled content transition failed", JSON.stringify(row.id));
      }
    }
    // Rotate past vetoed rows so one batch of failures cannot starve other entries.
    scanCursor = rows.length === 100 ? rows[rows.length - 1]!.id : null;
    await deliverScheduleEvents();
  } finally {
    running = false;
  }
}

const scheduler = new JobScheduler(console);
let started = false;
export function startContentScheduleJobs(): void {
  if (started) return;
  started = true;
  scheduler.register({
    name: "content.publish-scheduled",
    schedule: "* * * * *",
    handler: async () => {
      try {
        await runContentSchedules();
        return { success: true };
      } catch {
        console.error("[justflows] Content scheduling scan failed; retrying next minute");
        return { success: false };
      }
    },
  });
  scheduler.enqueue("content.publish-scheduled");
  scheduler.start();
}
export function stopContentScheduleJobs(): void {
  scheduler.stop();
}
