// SPDX-License-Identifier: MIT

import { decryptSecret, encryptSecret } from "../security/secret-box.js";
import type { DbClient } from "../database/db.js";

export type BackupDriver = "postgres" | "mysql" | "mariadb";
type Queryable = Pick<DbClient, "query">;
type Row = Record<string, unknown>;

/**
 * Every site-scoped table a backup carries, parents before children, so rows
 * can be inserted in this order and deleted in reverse without breaking a
 * foreign key. `sites` itself is updated in place, never deleted.
 *
 * A test parses the migrations and fails when a site-scoped table is missing
 * from both this list and EXCLUDED_SITE_TABLES, so a new table is never left
 * out of backups silently.
 */
export const SITE_TABLES = [
  "users",
  "access_roles",
  "user_access_policies",
  "user_additional_roles",
  "user_preferences",
  "site_memberships",
  "languages",
  "content_types",
  "site_settings",
  "taxonomies",
  "terms",
  "content",
  "content_visibility",
  "content_terms",
  "revisions",
  "content_schedule_events",
  "document_history",
  "search_documents",
  "search_metrics",
  "menus",
  "media",
  "comments",
  "comment_moderation_rules",
  "comment_spam_terms",
  "template_parts",
  "theme_designs",
  "theme_templates",
  "themes",
  "plugins",
  "css_providers",
  "plugin_data",
  "private_files",
  "redirects",
  "redirect_not_found",
  "api_keys",
  "webhook_endpoints",
  "webhook_deliveries",
  "email_template_versions",
  "email_design_versions",
  "email_deliveries",
  "email_suppressions",
  "ai_provider_credentials",
  "ai_usage_daily",
  "oauth_clients",
  "oauth_grants",
  "webauthn_credentials",
  "user_identities",
  "audit_log",
  "data_requests",
] as const;

export type SiteTable = (typeof SITE_TABLES)[number];

/**
 * Site-scoped tables a backup deliberately leaves out, and why. Restoring any
 * of them would be wrong: they hold short-lived state, or values that belong
 * to the target environment and are handled by an explicit restore step.
 */
export const EXCLUDED_SITE_TABLES: Record<string, string> = {
  sites: "updated in place from the backup's site row",
  site_domains: "hostnames are reviewed and mapped during restore",
  tenant_databases: "database connections are reviewed and tested during restore",
  backup_schedules: "a restored copy must not start sending backups to the source's destinations",
  backup_jobs: "backup and restore jobs belong to the running installation",
  user_sessions: "sign-in sessions are short-lived and tied to the source host",
  password_resets: "reset links are single-use and short-lived",
  webauthn_challenges: "passkey challenges expire within minutes",
  oauth_codes: "authorization codes expire within minutes",
  oauth_tokens: "access tokens are short-lived; clients refresh through their grant",
  job_queue: "queued work belongs to the running installation",
  jobs: "queued work belongs to the running installation",
  storage_quota_locks: "locks belong to the running installation",
  tenants: "workspace settings travel in the network manifest",
  platform_settings: "installation settings travel in the network manifest",
  platform_operators: "installation operators travel in the network manifest",
  platform_audit: "installation history travels in the network manifest",
  quota_limits: "site limits travel with the site through quotaLimits",
  mcp_hub_sites: "the MCP hub registry belongs to the running installation",
};

/** Tables without their own `site_id`, scoped through a parent row instead. */
const SCOPED_THROUGH: Partial<Record<SiteTable, { parent: string; column: string }>> = {
  content_terms: { parent: "content", column: "content_id" },
  user_preferences: { parent: "users", column: "user_id" },
};

export function quoteIdent(name: string, driver: BackupDriver): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Unsafe identifier in backup");
  return driver === "postgres" ? `"${name}"` : `\`${name}\``;
}

/** SQL selecting one site's rows of a core table, with JSON columns read as text. */
export function siteRowsSql(table: SiteTable, driver: BackupDriver, columns: ColumnInfo[]): string {
  const through = SCOPED_THROUGH[table];
  const t = quoteIdent(table, driver);
  const list = selectColumns(columns, driver);
  if (through) {
    return `SELECT ${list} FROM ${t} x INNER JOIN ${quoteIdent(through.parent, driver)} p ON p.id = x.${quoteIdent(through.column, driver)} WHERE p.site_id = ?`;
  }
  return `SELECT ${list} FROM ${t} x WHERE x.site_id = ?`;
}

/** SQL deleting one site's rows of a core table, keeping `keepUserId` for `users`. */
export function deleteSiteRowsSql(table: SiteTable, driver: BackupDriver): string {
  const through = SCOPED_THROUGH[table];
  const t = quoteIdent(table, driver);
  if (through) {
    return `DELETE FROM ${t} WHERE ${quoteIdent(through.column, driver)} IN (SELECT id FROM ${quoteIdent(through.parent, driver)} WHERE site_id = ?)`;
  }
  if (table === "users") return `DELETE FROM ${t} WHERE site_id = ? AND id <> ?`;
  return `DELETE FROM ${t} WHERE site_id = ?`;
}

export function hasOwnSiteColumn(table: SiteTable): boolean {
  return !SCOPED_THROUGH[table];
}

export interface ColumnInfo {
  name: string;
  /** Lower-case data type as information_schema reports it. */
  type: string;
  /** MySQL column type, which tells a boolean tinyint(1) apart. */
  columnType: string;
  /** Holds JSON: json/jsonb, or MariaDB text with a json_valid check. */
  json: boolean;
}

/**
 * Columns of a table in the connected database, or null when the table does
 * not exist. Generated columns (`content.has_cache_control`, PostgreSQL's
 * `search_documents.search_vector`) are left out: the database computes them,
 * and inserting a value into one fails.
 */
export async function tableColumns(db: Queryable, table: string, driver: BackupDriver): Promise<ColumnInfo[] | null> {
  const rows = await db.query<Record<string, unknown>>(
    driver === "postgres"
      ? "SELECT column_name AS name, data_type AS type, udt_name AS column_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND is_generated = 'NEVER' ORDER BY ordinal_position"
      : "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_TYPE AS column_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION",
    [table],
  );
  if (rows.length === 0) return null;
  const checked = new Set<string>();
  if (driver === "mariadb") {
    const checks = await db.query<Record<string, unknown>>(
      "SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [table],
    );
    for (const check of checks) {
      const match = /json_valid\(`?([a-z0-9_]+)`?\)/i.exec(String(check.clause ?? check.CLAUSE ?? ""));
      if (match?.[1]) checked.add(match[1].toLowerCase());
    }
  }
  return rows.map((row) => {
    const name = String(row.name ?? row.NAME ?? "");
    const type = String(row.type ?? row.TYPE ?? "").toLowerCase();
    return {
      name,
      type,
      columnType: String(row.column_type ?? row.COLUMN_TYPE ?? "").toLowerCase(),
      json: type === "json" || type === "jsonb" || checked.has(name.toLowerCase()),
    };
  });
}

/** The select list for a table, in column order. */
export function selectColumns(columns: ColumnInfo[], driver: BackupDriver, alias = "x"): string {
  return columns.map((column) => `${alias}.${quoteIdent(column.name, driver)}`).join(", ");
}

/**
 * Turn a JSON column's value into the value the application sees. Drivers
 * disagree: postgres.js stores the app's JSON text one level deeper, mysql2
 * parses MySQL JSON, and MariaDB's JSON alias can arrive parsed or as text.
 * The app reads all of them with one tolerant JSON.parse, so does this.
 */
export function decodeJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Decode the JSON columns of exported rows into application values. */
export function decodeJsonColumns(rows: Row[], columns: ColumnInfo[]): Row[] {
  const json = columns.filter((column) => column.json).map((column) => column.name);
  if (json.length === 0) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const name of json) if (name in copy) copy[name] = decodeJsonValue(copy[name]);
    return copy;
  });
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Make a database value portable: dates become ISO strings, everything else stays JSON. */
export function exportValue(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value;
}

function isBooleanColumn(column: ColumnInfo, driver: BackupDriver): boolean {
  return driver === "postgres" ? column.type === "boolean" : column.columnType.startsWith("tinyint(1)") || column.type === "boolean";
}

function isTimeColumn(column: ColumnInfo): boolean {
  return /timestamp|datetime|^date$/.test(column.type);
}

/** Convert a portable value into what the target column and driver accept. */
export function importValue(
  value: unknown,
  column: ColumnInfo,
  driver: BackupDriver,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return importValue(Number.isNaN(value.getTime()) ? null : value.toISOString(), column, driver);
  /** The app writes JSON columns as JSON.stringify(value) on every driver. */
  if (column.json) return JSON.stringify(value);
  if (isBooleanColumn(column, driver)) {
    const truthy = value === true || value === 1 || value === "1" || value === "t" || value === "true";
    return driver === "postgres" ? truthy : truthy ? 1 : 0;
  }
  if (isTimeColumn(column) && typeof value === "string") {
    if (column.type === "date") return value.slice(0, 10);
    if (driver !== "postgres" && ISO_TIME.test(value)) {
      return value.replace("T", " ").replace(/Z$/, "").slice(0, 23);
    }
    return value;
  }
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return driver === "postgres" ? value : value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value);
}

const STORED_SECRET = /enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g;
const PORTABLE_SECRET = /jfsecret:v1:([A-Za-z0-9_-]*)/g;

/**
 * Secrets in the database are encrypted with this installation's APP_SECRET,
 * which another installation does not have. Inside the passphrase-encrypted
 * archive they travel decrypted, as markers that restore re-encrypts with the
 * target's key. Markers work inside JSON payloads too, since base64url never
 * needs escaping.
 */
export function exportSecrets(value: unknown, stats: { undecryptable: number }): unknown {
  if (typeof value === "string") {
    if (!value.includes("enc:v1:")) return value;
    return value.replace(STORED_SECRET, (match) => {
      const plain = decryptSecret(match);
      if (!plain) stats.undecryptable += 1;
      return `jfsecret:v1:${Buffer.from(plain, "utf8").toString("base64url")}`;
    });
  }
  if (Array.isArray(value)) return value.map((item) => exportSecrets(item, stats));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exportSecrets(item, stats)]));
  }
  return value;
}

/** Re-encrypt portable secret markers with this installation's key. */
export function importSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    if (!value.includes("jfsecret:v1:")) return value;
    return value.replace(PORTABLE_SECRET, (_match, encoded: string) =>
      encryptSecret(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  }
  if (Array.isArray(value)) return value.map(importSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, importSecrets(item)]));
  }
  return value;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Old-to-new identifiers for one restore. Every primary key is a random UUID,
 * so a string equal to a backed-up id is a reference to that row wherever it
 * appears: a foreign key, a JSON block attribute, or a media storage path.
 * One map is shared by every site of a network restore, so references between
 * sites (memberships, shared users) stay intact.
 */
export class IdMap {
  private readonly map = new Map<string, string>();

  set(from: string, to: string): void {
    this.map.set(from.toLowerCase(), to);
  }

  get(from: string): string | undefined {
    return this.map.get(from.toLowerCase());
  }

  /** Give every row id in `rows` a new id unless it already has one. */
  assignRowIds(rows: Row[], newId: () => string): void {
    for (const row of rows) {
      const id = row.id;
      if (typeof id === "string" && UUID_ONLY.test(id) && !this.map.has(id.toLowerCase())) this.set(id, newId());
    }
  }

  apply(value: unknown): unknown {
    if (this.map.size === 0) return value;
    if (typeof value === "string") return value.replace(UUID, (match) => this.map.get(match.toLowerCase()) ?? match);
    if (Array.isArray(value)) return value.map((item) => this.apply(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.apply(item)]));
    }
    return value;
  }
}

/** Order rows so a row's `parent_id` row is inserted first. */
export function parentsFirst(rows: Row[]): Row[] {
  if (!rows.some((row) => row.parent_id)) return rows;
  const pending = [...rows];
  const available = new Set(rows.map((row) => String(row.id ?? "")));
  const inserted = new Set<string>();
  const ordered: Row[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex(
      (row) => !row.parent_id || !available.has(String(row.parent_id)) || inserted.has(String(row.parent_id)),
    );
    if (index < 0) throw new Error("Backup contains a cyclic parent relationship");
    const row = pending.splice(index, 1)[0]!;
    ordered.push(row);
    inserted.add(String(row.id ?? ""));
  }
  return ordered;
}

/** Insert rows, keeping only columns the target table has, converted for its driver. */
export async function insertRows(
  db: Pick<DbClient, "run">,
  table: string,
  columns: ColumnInfo[],
  rows: Row[],
  driver: BackupDriver,
): Promise<void> {
  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const row of rows) {
    const present = Object.keys(row).filter((name) => byName.has(name));
    if (present.length === 0) continue;
    await db.run(
      `INSERT INTO ${quoteIdent(table, driver)} (${present.map((name) => quoteIdent(name, driver)).join(", ")}) VALUES (${present.map(() => "?").join(", ")})`,
      present.map((name) => importValue(row[name], byName.get(name)!, driver)),
    );
  }
}
