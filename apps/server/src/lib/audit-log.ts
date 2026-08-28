// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { getDb } from "./db.js";
import { clientIp } from "./rate-limit.js";
import { logSafe } from "./log-safe.js";

/**
 * Administrative audit trail.
 *
 * Records the actions that change who can do what, or what code runs — the set
 * an incident responder needs and a compliance reviewer asks for. Deliberately
 * not a request log: recording everything produces a table nobody reads, and
 * the interesting events are a few dozen a month, not a few thousand a day.
 *
 * Writes never throw into the caller. An audit row failing must not fail the
 * action it describes — a site that stops working because logging broke is a
 * worse outcome than a gap in the log, and the gap is visible either way.
 */

export const AUDIT_ACTIONS = [
  // Authentication
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.password_changed",
  "auth.password_reset",
  "auth.2fa_enabled",
  "auth.2fa_disabled",
  // Accounts and privilege
  "user.created",
  "user.role_changed",
  "user.deleted",
  // Code execution surfaces
  "plugin.installed",
  "plugin.activated",
  "plugin.deactivated",
  "plugin.deleted",
  "theme.installed",
  "theme.activated",
  "css_provider.installed",
  "css_provider.activated",
  "core.updated",
  "core.auto_update_started",
  "core.auto_update_completed",
  "core.auto_update_failed",
  "core.auto_update_skipped",
  "core.auto_update_toggled",
  // Configuration that weakens or strengthens the site
  "security.headers_changed",
  "settings.changed",
  "public_api.toggled",
  "content.published",
  "content.revision_restored",
  "content.revision_discarded",
  "content.revision_pruned",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = "success" | "failure";

export interface AuditEntry {
  siteId: string;
  action: AuditAction;
  outcome?: AuditOutcome;
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  /** What was acted on — a user id, a plugin id, a setting key. */
  target?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Short human-readable context. Never credentials or content. */
  detail?: string | null;
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Trim to the column width, and strip anything that could forge a log line. */
function field(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[\r\n\0]/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

let unavailableLogged = false;

/**
 * Append one entry.
 *
 * Fire-and-forget by design — callers do not await this on the hot path, and it
 * resolves rather than rejects on failure.
 */
export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    const db = await getDb();
    await db.run(
      `INSERT INTO audit_log
         (id, site_id, occurred_at, action, outcome, actor_id, actor_email, actor_role, target, ip, user_agent, detail, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      [
        randomUUID(),
        entry.siteId,
        nowSql(),
        entry.action,
        entry.outcome ?? "success",
        entry.actorId ?? null,
        field(entry.actorEmail, 320),
        field(entry.actorRole, 32),
        field(entry.target, 255),
        field(entry.ip, 64),
        field(entry.userAgent, 255),
        field(entry.detail, 2000),
      ],
    );
  } catch (err) {
    // 0008_audit_log may not have been applied yet. Say so once rather than on
    // every action, so the log is a signal instead of a flood.
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.error(
        "[justflows] audit log unavailable — has migration 0008_audit_log run?",
        err,
      );
    }
  }
}

/** Pull the request-side fields, so call sites stay one line. */
export function auditContext(req: Request): Pick<AuditEntry, "ip" | "userAgent"> {
  return {
    ip: clientIp(req),
    userAgent: logSafe(req.get("user-agent") ?? "", 255),
  };
}

/**
 * Record an action taken by the signed-in user of this request.
 *
 * Not awaited by callers: an audit write must not add latency to, or be able to
 * fail, the action it is describing.
 */
export function auditFromRequest(
  req: Request,
  action: AuditAction,
  extra: Partial<AuditEntry> = {},
): void {
  const session = req.session;
  const siteId = extra.siteId ?? session?.siteId;
  if (!siteId) return;

  void auditLog({
    siteId,
    action,
    actorId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    actorRole: session?.role ?? null,
    ...auditContext(req),
    ...extra,
  });
}

export interface AuditQuery {
  siteId: string;
  action?: string;
  limit?: number;
  before?: string;
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actorEmail: string | null;
  actorRole: string | null;
  target: string | null;
  ip: string | null;
  detail: string | null;
}

/** Read the trail, newest first. */
export async function listAuditLog(query: AuditQuery): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
  const params: (string | number)[] = [query.siteId];
  let sql = "SELECT * FROM audit_log WHERE site_id = ?";

  if (query.action) {
    sql += " AND action = ?";
    params.push(query.action);
  }
  if (query.before) {
    sql += " AND occurred_at < ?";
    params.push(query.before);
  }
  sql += " ORDER BY occurred_at DESC LIMIT ?";
  params.push(limit);

  const rows = await getDb().then((db) => db.query<Record<string, unknown>>(sql, params));
  return rows.map((r) => ({
    id: String(r.id),
    occurredAt: String(r.occurred_at ?? ""),
    action: String(r.action),
    outcome: String(r.outcome ?? "success"),
    actorEmail: r.actor_email == null ? null : String(r.actor_email),
    actorRole: r.actor_role == null ? null : String(r.actor_role),
    target: r.target == null ? null : String(r.target),
    ip: r.ip == null ? null : String(r.ip),
    detail: r.detail == null ? null : String(r.detail),
  }));
}

/** Default retention. Long enough to investigate, short enough to be lawful. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

export function auditRetentionDays(): number {
  const raw = Number(process.env.JF_AUDIT_RETENTION_DAYS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_AUDIT_RETENTION_DAYS;
}

/**
 * Drop entries past the retention window.
 *
 * An audit log that grows forever is both an operational problem and, once it
 * holds IP addresses, a data-protection one: GDPR Art. 5(1)(e) requires
 * personal data be kept no longer than necessary.
 */
export async function pruneAuditLog(siteId: string, days = auditRetentionDays()): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  const db = await getDb();
  const stale = await db.query<{ id: string }>(
    "SELECT id FROM audit_log WHERE site_id = ? AND occurred_at < ?",
    [siteId, cutoff],
  );
  if (stale.length === 0) return 0;
  await db.run("DELETE FROM audit_log WHERE site_id = ? AND occurred_at < ?", [siteId, cutoff]);
  return stale.length;
}
