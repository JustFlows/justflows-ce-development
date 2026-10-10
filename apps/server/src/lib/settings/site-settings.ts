import { randomUUID } from "node:crypto";
import { getDb } from "../database/db.js";
import { getTenantContext } from "../tenancy/context.js";

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/**
 * The `key` column, quoted for the active driver.
 *
 * `key` is a reserved word in MySQL and MariaDB but not in PostgreSQL, where a
 * backtick is a syntax error rather than a quote. setSiteSetting branched on
 * the driver for its INSERT; the reads did not, and hardcoded the MySQL form —
 * so every settings lookup was malformed SQL on PostgreSQL.
 */
export function settingsKeyColumnFor(driver: string | undefined): string {
  return driver === "postgres" ? "key" : "`key`";
}

export function settingsKeyColumn(): string {
  return settingsKeyColumnFor(process.env.DB_DRIVER);
}

export async function getSiteId(): Promise<string | null> {
  const current = getTenantContext();
  if (current?.siteId) return current.siteId;
  const db = await getDb();
  const rows = await db.query<{ id: string }>("SELECT id FROM sites LIMIT 2");
  if (rows.length === 1) return rows[0]?.id ?? null;
  return null;
}

export async function getSiteSetting<T>(siteId: string, key: string): Promise<T | null> {
  const db = await getDb();
  const rows = await db.query<{ value: unknown }>(
    `SELECT value FROM site_settings WHERE site_id = ? AND ${settingsKeyColumn()} = ? LIMIT 1`,
    [siteId, key],
  );
  return parseSettingValue<T>(rows.length > 0, rows[0]?.value);
}

/** Read a bounded group of related settings in one site-scoped query. */
export async function getSiteSettings(siteId: string, keys: string[]): Promise<Record<string, unknown>> {
  const uniqueKeys = [...new Set(keys)];
  if (!uniqueKeys.length) return {};
  const db = await getDb();
  const column = settingsKeyColumn();
  const values: Array<[string, unknown]> = [];
  for (let offset = 0; offset < uniqueKeys.length; offset += 200) {
    const batch = uniqueKeys.slice(offset, offset + 200);
    const rows = await db.query<{ setting_key: string; value: unknown }>(
      `SELECT ${column} AS setting_key, value FROM site_settings WHERE site_id = ? AND ${column} IN (${batch.map(() => "?").join(", ")})`,
      [siteId, ...batch],
    );
    for (const row of rows) values.push([row.setting_key, parseSettingValue(true, row.value)]);
  }
  return Object.fromEntries(values);
}

/**
 * Decode one stored settings value. A row that exists but holds JSON `false`,
 * `0` or `""` is still a real, deliberate value — only a missing row (or a SQL
 * NULL) means "unset". Postgres hands `jsonb` back already parsed, so a non-string
 * value is passed straight through; MySQL/MariaDB store the JSON text verbatim.
 */
export function parseSettingValue<T>(rowExists: boolean, raw: unknown): T | null {
  if (!rowExists || raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as T;
  }
}

export async function setSiteSetting(siteId: string, key: string, value: unknown): Promise<void> {
  const db = await getDb();
  const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb" | undefined;
  const serialized = JSON.stringify(value);

  if (driver === "postgres") {
    await db.run(
      `INSERT INTO site_settings (id, site_id, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [randomUUID(), siteId, key, serialized, now()],
    );
    return;
  }

  await db.run(
    `INSERT INTO site_settings (id, site_id, \`key\`, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [randomUUID(), siteId, key, serialized, now()],
  );
}

export async function deleteSiteSetting(siteId: string, key: string): Promise<void> {
  const db = await getDb();
  await db.run(`DELETE FROM site_settings WHERE site_id = ? AND ${settingsKeyColumn()} = ?`, [
    siteId,
    key,
  ]);
}
