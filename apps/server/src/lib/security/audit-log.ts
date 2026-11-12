// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { getDb } from "../database/db.js";
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
  "auth.session_revoked",
  "auth.other_sessions_revoked",
  "auth.password_changed",
  "auth.password_reset",
  "auth.password_reset_requested",
  "auth.password_reset_failed",
  "auth.2fa_enabled",
  "auth.2fa_disabled",
  "auth.passkey_registered",
  "auth.passkey_renamed",
  "auth.passkey_revoked",
  "auth.recovery_codes_regenerated",
  "auth.sign_in_factors_reset",
  // Accounts and privilege
  "user.created",
  "user.role_changed",
  "user.access_changed",
  "user.deleted",
  "workspace.owner_updated",
  "workspace.created_mail",
  "workspace.sites_requested",
  "site.owner_updated",
  "access.role_created",
  "access.role_updated",
  "access.role_deleted",
  // Code execution surfaces
  "plugin.installed",
  "plugin.activated",
  "plugin.deactivated",
  "plugin.deleted",
  "plugin.updated",
  "plugin.permissions_approved",
  "theme.installed",
  "theme.activated",
  "theme.deleted",
  "theme.updated",
  "extension.auto_update_toggled",
  "extension.auto_update_skipped",
  "extension.auto_update_failed",
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
  "security.admin_path_changed",
  "security.passkey_policy_changed",
  "security.notifications_changed",
  "settings.changed",
  "redirect.created",
  "redirect.updated",
  "redirect.imported",
  "redirect.logs_cleared",
  "email.design_saved",
  "email.design_published",
  "email.design_restored",
  "email.template_saved",
  "email.template_published",
  "email.template_restored",
  "email.template_tested",
  "public_api.toggled",
  "manage_api.toggled",
  "apikey.created",
  "apikey.updated",
  "apikey.rotated",
  "apikey.revoked",
  "apikey.deleted",
  "apikey.auth_failed",
  "mcp.auth_failed",
  "ai.settings_changed",
  "ai.tool_called",
  "ai.provider_saved",
  "ai.provider_removed",
  "cdn.settings_saved",
  "cdn.settings_removed",
  "cdn.purged",
  "storage.removed",
  "storage.saved",
  "domain.added",
  "domain.removed",
  "domain.primary_changed",
  "domain.dns_record_added",
  "domain.dns_record_removed",
  "oauth.client_registered",
  "oauth.grant_created",
  "oauth.grant_revoked",
  "oauth.refresh_reuse",
  "content.published",
  "content.schedule_set",
  "content.schedule_changed",
  "content.visibility_changed",
  "content.schedule_cancelled",
  "content.schedule_executed",
  "content.revision_restored",
  "content.revision_discarded",
  "content.revision_pruned",
  "trash.trashed",
  "trash.restored",
  "trash.purged",
  "trash.emptied",
  "comment.rule_added",
  "comment.rule_removed",
  "comment.spam_term_added",
  "comment.spam_term_removed",
  "diagnostics.debug_enabled",
  "diagnostics.debug_disabled",
  "diagnostics.bundle_generated",
  "diagnostics.test_run",
  "diagnostics.job_retried",
  "integrity.failed",
  "integrity.scanned",
  "audit.security_events_deleted",
  "backup.downloaded",
  "backup.validated",
  "backup.restored",
  "backup.destinations_changed",
  "backup.delivered",
  "backup.schedule_changed",
  "backup.schedule_started",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = "success" | "failure";

/** Events relevant to account, privilege, code, update, and security investigations. */
export const SECURITY_AUDIT_ACTIONS = AUDIT_ACTIONS.filter((action) =>
  action.startsWith("auth.")
  || action.startsWith("user.")
  || action.startsWith("access.")
  || action.startsWith("apikey.")
  || action.startsWith("plugin.")
  || action.startsWith("theme.")
  || action.startsWith("extension.")
  || action.startsWith("core.")
  || action.startsWith("security.")
  || action.startsWith("integrity.")
  || action.startsWith("audit.")
  || action.startsWith("oauth.")
  || action.startsWith("cdn.")
  || action.startsWith("storage.")
  || action.startsWith("domain.")
  || action === "workspace.owner_updated"
  || action === "site.owner_updated"
  || action === "public_api.toggled"
  || action === "manage_api.toggled"
  || action === "mcp.auth_failed"
  || action === "settings.changed"
  || action === "ai.settings_changed"
  || action === "ai.provider_saved"
  || action === "ai.provider_removed"
  || action === "css_provider.installed"
  || action === "css_provider.activated"
  || action === "diagnostics.debug_enabled"
  || action === "diagnostics.debug_disabled",
);

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
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

/** Trim to the column width, and strip anything that could forge a log line. */
function field(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    .replace(/[\r\n\0]/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

let unavailableLogged = false;
let lastWriteFailureAt: string | null = null;
let lastWriteSuccessAt: string | null = null;

export interface AuditWriteStatus {
  available: boolean;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  maxRowsPerSite: number;
}

export const DEFAULT_AUDIT_MAX_ROWS = 100_000;

export function auditMaxRowsPerSite(): number {
  const raw = Number(process.env.JF_AUDIT_MAX_ROWS_PER_SITE);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 1_000_000) return Math.floor(raw);
  return DEFAULT_AUDIT_MAX_ROWS;
}

export function auditWriteStatus(): AuditWriteStatus {
  return {
    available: lastWriteFailureAt === null || (lastWriteSuccessAt !== null && lastWriteSuccessAt > lastWriteFailureAt),
    lastFailureAt: lastWriteFailureAt,
    lastSuccessAt: lastWriteSuccessAt,
    maxRowsPerSite: auditMaxRowsPerSite(),
  };
}

async function enforceAuditStorageBound(siteId: string): Promise<void> {
  const max = auditMaxRowsPerSite();
  const db = await getDb();
  for (;;) {
    const overflow = await db.query<{ id: string }>(
      "SELECT id FROM audit_log WHERE site_id = ? ORDER BY occurred_at DESC LIMIT 500 OFFSET ?",
      [siteId, max],
    );
    if (!overflow.length) return;
    await db.run(
      `DELETE FROM audit_log WHERE site_id = ? AND id IN (${overflow.map(() => "?").join(", ")})`,
      [siteId, ...overflow.map((row) => row.id)],
    );
  }
}

/**
 * Append one entry.
 *
 * Fire-and-forget by design — callers do not await this on the hot path, and it
 * resolves rather than rejects on failure.
 */
export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    const db = await getDb();
    const id = randomUUID();
    const occurredAt = nowSql();
    await db.run(
      `INSERT INTO audit_log
         (id, site_id, occurred_at, action, outcome, actor_id, actor_email, actor_role, target, ip, user_agent, detail, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      [
        id,
        entry.siteId,
        occurredAt,
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
    lastWriteSuccessAt = new Date().toISOString();
    await enforceAuditStorageBound(entry.siteId);
    void import("./security-notifications.js")
      .then(({ notifySecurityEvent }) => notifySecurityEvent({
        id,
        siteId: entry.siteId,
        action: entry.action,
        occurredAt,
      }))
      .catch(() => undefined);
  } catch (err) {
    lastWriteFailureAt = new Date().toISOString();
    // 0008_audit_log may not have been applied yet. Say so once rather than on
    // every action, so the log is a signal instead of a flood.
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.error("[justflows] audit log unavailable — has migration 0008_audit_log run?", err);
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
  view?: "all" | "security";
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

  if (query.view === "security") {
    sql += ` AND action IN (${SECURITY_AUDIT_ACTIONS.map(() => "?").join(", ")})`;
    params.push(...SECURITY_AUDIT_ACTIONS);
  }
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

export const MAX_AUDIT_EXPORT_ROWS = 5_000;

function maskedEmail(value: string | null): string | null {
  if (!value) return null;
  const [local, domain] = value.split("@");
  return local && domain ? `${local.slice(0, 1)}***@${domain}` : null;
}

function maskedIp(value: string | null): string | null {
  if (!value) return null;
  if (value.includes(":")) return `${value.split(":").slice(0, 3).join(":")}:…`;
  const parts = value.split(".");
  return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.0` : null;
}

/** Portable, bounded export without targets, details, user agents, or raw identifiers. */
export async function exportSecurityAuditLog(siteId: string): Promise<Array<Omit<AuditRow, "target" | "detail">>> {
  const placeholders = SECURITY_AUDIT_ACTIONS.map(() => "?").join(", ");
  const rows = await (await getDb()).query<Record<string, unknown>>(
    `SELECT occurred_at, action, outcome, actor_email, actor_role, ip
     FROM audit_log WHERE site_id = ? AND action IN (${placeholders})
     ORDER BY occurred_at DESC LIMIT ?`,
    [siteId, ...SECURITY_AUDIT_ACTIONS, MAX_AUDIT_EXPORT_ROWS],
  );
  return rows.map((row) => ({
    id: "",
    occurredAt: String(row.occurred_at ?? ""),
    action: String(row.action ?? ""),
    outcome: String(row.outcome ?? "success"),
    actorEmail: maskedEmail(row.actor_email == null ? null : String(row.actor_email)),
    actorRole: row.actor_role == null ? null : String(row.actor_role),
    ip: maskedIp(row.ip == null ? null : String(row.ip)),
  }));
}

/** Delete security-category rows only; the caller records a count-only marker afterward. */
export async function deleteSecurityAuditLog(siteId: string): Promise<number> {
  const placeholders = SECURITY_AUDIT_ACTIONS.map(() => "?").join(", ");
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM audit_log WHERE site_id = ? AND action IN (${placeholders})`,
    [siteId, ...SECURITY_AUDIT_ACTIONS],
  );
  if (!rows.length) return 0;
  await db.run(
    `DELETE FROM audit_log WHERE site_id = ? AND action IN (${placeholders})`,
    [siteId, ...SECURITY_AUDIT_ACTIONS],
  );
  return rows.length;
}
