// SPDX-License-Identifier: MIT

import type {
  PluginColumnType,
  PluginDatabaseDriver,
  PluginDatabaseTarget,
  PluginSchemaApplyResult,
  PluginSchemaColumn,
  PluginSchemaTable,
} from "@justflows/sdk";
import type { DbClient } from "./db.js";
import { isIgnorableMigrationError } from "./run-migrations.js";
import { isLocalDatabaseHost, sanitizeProbeError } from "./db-probe.js";

const IDENT = /^[a-z][a-z0-9_]{0,47}$/;

export function pluginTablePrefix(pluginId: string): string {
  const last = pluginId.split(".").pop() ?? pluginId;
  const slug = last.replace(/-/g, "_");
  if (!IDENT.test(slug)) {
    throw new Error(`Plugin "${pluginId}" cannot own schema tables — slug "${slug}" is not a safe identifier.`);
  }
  return slug;
}

export function pluginTableName(pluginId: string, table: string): string {
  return `${pluginTablePrefix(pluginId)}_${assertIdent("table", table)}`;
}

function assertIdent(kind: string, value: string): string {
  if (!IDENT.test(value)) {
    throw new Error(`Invalid ${kind} "${value}". Use a lowercase letter followed by letters, digits, or underscores.`);
  }
  return value;
}

function quoteIdent(value: string, driver: PluginDatabaseDriver): string {
  const name = assertIdent("identifier", value);
  return driver === "postgres" ? `"${name}"` : `\`${name}\``;
}

/** True when `tableName` is `{pluginSlug}_…` and a safe identifier. */
export function isPluginOwnedTable(pluginId: string, tableName: string): boolean {
  const prefix = pluginTablePrefix(pluginId);
  if (!IDENT.test(tableName)) return false;
  return tableName.startsWith(`${prefix}_`) && tableName.length > prefix.length + 1;
}

/**
 * LIKE pattern for plugin-owned tables. `!` is the ESCAPE character, so a
 * prefix of `hello_world` matches `hello_world_*` and not `helloXworld_*`.
 */
export function pluginOwnedTableLikePattern(pluginId: string): string {
  return `${pluginTablePrefix(pluginId)}!_%`;
}

export function compileDropPluginTables(
  pluginId: string,
  tableNames: string[],
  driver: PluginDatabaseDriver,
): string[] {
  const owned = tableNames.filter((name) => isPluginOwnedTable(pluginId, name));
  if (owned.length === 0) return [];
  if (driver === "postgres") {
    const quoted = owned.map((name) => quoteIdent(name, driver));
    return [`DROP TABLE IF EXISTS ${quoted.join(", ")} CASCADE`];
  }
  return [
    "SET FOREIGN_KEY_CHECKS=0",
    ...owned.map((name) => `DROP TABLE IF EXISTS ${quoteIdent(name, driver)}`),
    "SET FOREIGN_KEY_CHECKS=1",
  ];
}

function asTableName(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function tableNameFromRow(row: Record<string, unknown>): string {
  const value = row.table_name ?? row.TABLE_NAME ?? row.tablename ?? Object.values(row)[0];
  return asTableName(value);
}

export async function listPluginOwnedTables(
  db: Pick<DbClient, "query">,
  pluginId: string,
  driver: PluginDatabaseDriver,
): Promise<string[]> {
  const fromSchema = async (): Promise<string[]> => {
    const pattern = pluginOwnedTableLikePattern(pluginId);
    const sql =
      driver === "postgres"
        ? "SELECT tablename AS table_name FROM pg_catalog.pg_tables WHERE schemaname = current_schema() AND tablename LIKE ? ESCAPE '!'"
        : "SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME LIKE ? ESCAPE '!'";
    const rows = await db.query<Record<string, unknown>>(sql, [pattern]);
    return rows.map(tableNameFromRow).filter((name) => isPluginOwnedTable(pluginId, name));
  };

  try {
    const names = await fromSchema();
    if (names.length > 0 || driver === "postgres") return names;
  } catch {
    if (driver === "postgres") return [];
  }

  const prefix = pluginTablePrefix(pluginId).replace(/_/g, "\\_");
  const rows = await db.query<Record<string, unknown>>("SHOW TABLES LIKE ?", [`${prefix}\\_%`]);
  return rows.map(tableNameFromRow).filter((name) => isPluginOwnedTable(pluginId, name));
}

export async function dropPluginOwnedTables(
  db: Pick<DbClient, "run" | "query">,
  pluginId: string,
  driver: PluginDatabaseDriver,
  knownTables: string[] = [],
): Promise<string[]> {
  let tables: string[] = [];
  try {
    tables = await listPluginOwnedTables(db, pluginId, driver);
  } catch {
    tables = [];
  }
  if (tables.length === 0) {
    tables = knownTables.filter((name) => isPluginOwnedTable(pluginId, name));
  }
  for (const statement of compileDropPluginTables(pluginId, tables, driver)) {
    try {
      await db.run(statement);
    } catch (err) {
      if (statement.startsWith("SET FOREIGN_KEY_CHECKS")) continue;
      throw err;
    }
  }
  return tables;
}

function sqlType(column: PluginSchemaColumn, driver: PluginDatabaseDriver): string {
  const type: PluginColumnType = column.type;
  if (type === "varchar") {
    const length = column.length && column.length > 0 ? Math.min(column.length, 2048) : 255;
    return `VARCHAR(${length})`;
  }
  if (driver === "postgres") {
    if (type === "uuid") return "UUID";
    if (type === "json") return "JSONB";
    if (type === "boolean") return "BOOLEAN";
    if (type === "timestamptz") return "TIMESTAMPTZ";
    if (type === "bigint") return "BIGINT";
    if (type === "int") return "INTEGER";
    return "TEXT";
  }
  if (type === "uuid") return "CHAR(36)";
  if (type === "json") return "JSON";
  if (type === "boolean") return "TINYINT(1)";
  if (type === "timestamptz") return "DATETIME";
  if (type === "bigint") return "BIGINT";
  if (type === "int") return "INT";
  return "TEXT";
}

function columnSql(column: PluginSchemaColumn, driver: PluginDatabaseDriver): string {
  const name = quoteIdent(column.name, driver);
  const parts = [`${name} ${sqlType(column, driver)}`];
  if (column.primary) {
    parts.push("PRIMARY KEY");
  } else {
    if (column.notNull) parts.push("NOT NULL");
    if (column.unique) parts.push("UNIQUE");
  }
  return parts.join(" ");
}

export function compilePluginSchema(
  pluginId: string,
  tables: PluginSchemaTable[],
  driver: PluginDatabaseDriver,
): { tableName: string; sql: string[] }[] {
  const prefix = pluginTablePrefix(pluginId);
  return tables.map((table) => {
    const name = assertIdent("table", table.name);
    const tableName = `${prefix}_${name}`;
    const quotedTable = quoteIdent(tableName, driver);
    if (table.columns.length === 0) {
      throw new Error(`Table "${table.name}" must declare at least one column.`);
    }
    const columns = table.columns.map((column) => columnSql(column, driver));
    const extras: string[] = [];
    for (const index of table.indexes ?? []) {
      const indexName = assertIdent("index", index.name);
      const cols = index.columns.map((col) => quoteIdent(col, driver));
      const quotedIndex = quoteIdent(`idx_${tableName}_${indexName}`, driver);
      if (driver === "postgres") {
        extras.push(
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quotedIndex} ON ${quotedTable} (${cols.join(", ")})`,
        );
      } else {
        columns.push(`${index.unique ? "UNIQUE " : ""}KEY ${quotedIndex} (${cols.join(", ")})`);
      }
    }
    const body = columns.join(",\n  ");
    const create =
      driver === "postgres"
        ? `CREATE TABLE IF NOT EXISTS ${quotedTable} (\n  ${body}\n)`
        : `CREATE TABLE IF NOT EXISTS ${quotedTable} (\n  ${body}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
    return { tableName, sql: [create, ...extras] };
  });
}

export async function applyCompiledSchema(
  db: Pick<DbClient, "run">,
  compiled: { tableName: string; sql: string[] }[],
): Promise<string[]> {
  const created: string[] = [];
  for (const table of compiled) {
    for (const statement of table.sql) {
      try {
        await db.run(statement);
      } catch (err) {
        if (!isIgnorableMigrationError(err)) throw err;
      }
    }
    created.push(table.tableName);
  }
  return created;
}

export async function openTargetDatabase(target: PluginDatabaseTarget): Promise<DbClient> {
  const { useSsl, rejectUnauthorized } = {
    useSsl: target.ssl ?? !isLocalDatabaseHost(target.host),
    rejectUnauthorized: target.rejectUnauthorized ?? true,
  };
  if (target.driver === "postgres") {
    const { default: postgres } = await import("postgres");
    const url = `postgres://${encodeURIComponent(target.username)}:${encodeURIComponent(target.password)}@${target.host}:${target.port}/${target.database}`;
    const sql = postgres(url, {
      max: 1,
      ssl: useSsl ? { rejectUnauthorized } : false,
    });
    return {
      run: async (query, params = []) => {
        let i = 0;
        const pgQuery = query.replace(/\?/g, () => `$${++i}`);
        await sql.unsafe(pgQuery, params as Parameters<typeof sql.unsafe>[1]);
      },
      query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
        let i = 0;
        const pgQuery = query.replace(/\?/g, () => `$${++i}`);
        const rows = await sql.unsafe(pgQuery, params as Parameters<typeof sql.unsafe>[1]);
        return rows as unknown as T[];
      },
      execute: async () => 0,
      transaction: async (fn) => fn({ run: async () => undefined, query: async () => [], execute: async () => 0 }),
      close: () => sql.end({ timeout: 2 }),
    };
  }
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.username,
    password: target.password,
    database: target.database,
    ...(useSsl ? { ssl: { minVersion: "TLSv1.2" as const, rejectUnauthorized } } : {}),
  });
  return {
    run: async (query, params = []) => {
      if (params.length === 0) {
        await conn.query(query);
        return;
      }
      await conn.execute(query, params);
    },
    query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
      const [rows] =
        params.length === 0 ? await conn.query(query) : await conn.execute(query, params);
      return rows as T[];
    },
    execute: async () => 0,
    transaction: async (fn) => fn({ run: async () => undefined, query: async () => [], execute: async () => 0 }),
    close: async () => {
      await conn.end();
    },
  };
}

export async function applyPluginSchema(options: {
  pluginId: string;
  tables: PluginSchemaTable[];
  target?: PluginDatabaseTarget;
  allowRemote: boolean;
  rebuild?: string[];
}): Promise<PluginSchemaApplyResult> {
  try {
    const driver: PluginDatabaseDriver = options.target?.driver
      ?? ((process.env.DB_DRIVER as PluginDatabaseDriver | undefined) || "mysql");
    const compiled = compilePluginSchema(options.pluginId, options.tables, driver);
    let db: DbClient;
    let close = false;
    if (options.target) {
      if (!isLocalDatabaseHost(options.target.host) && !options.allowRemote) {
        return {
          ok: false,
          tables: [],
          error: `Plugin "${options.pluginId}" cannot create tables on a remote database without the "network:outbound" permission.`,
        };
      }
      db = await openTargetDatabase(options.target);
      close = true;
    } else {
      const { getDb } = await import("./db.js");
      db = await getDb();
    }
    try {
      if (options.rebuild?.length) {
        const rebuildNames = options.rebuild.map((name) => pluginTableName(options.pluginId, name));
        for (const statement of compileDropPluginTables(options.pluginId, rebuildNames, driver)) {
          try {
            await db.run(statement);
          } catch (err) {
            if (statement.startsWith("SET FOREIGN_KEY_CHECKS")) continue;
            if (!isIgnorableMigrationError(err)) throw err;
          }
        }
      }
      const tables = await applyCompiledSchema(db, compiled);
      return { ok: true, tables };
    } finally {
      if (close) await db.close();
    }
  } catch (err) {
    return { ok: false, tables: [], error: sanitizeProbeError(err) };
  }
}

export async function dropPluginSchema(options: {
  pluginId: string;
  tables?: PluginSchemaTable[];
  target?: PluginDatabaseTarget;
  allowRemote: boolean;
  knownTables?: string[];
}): Promise<PluginSchemaApplyResult> {
  try {
    const driver: PluginDatabaseDriver = options.target?.driver
      ?? ((process.env.DB_DRIVER as PluginDatabaseDriver | undefined) || "mysql");
    const known = options.tables?.length
      ? compilePluginSchema(options.pluginId, options.tables, driver).map((table) => table.tableName)
      : (options.knownTables ?? []);
    let db: DbClient;
    let close = false;
    if (options.target) {
      if (!isLocalDatabaseHost(options.target.host) && !options.allowRemote) {
        return {
          ok: false,
          tables: [],
          error: `Plugin "${options.pluginId}" cannot drop tables on a remote database without the "network:outbound" permission.`,
        };
      }
      db = await openTargetDatabase(options.target);
      close = true;
    } else {
      const { getDb } = await import("./db.js");
      db = await getDb();
    }
    try {
      const tables = await dropPluginOwnedTables(db, options.pluginId, driver, known);
      return { ok: true, tables };
    } finally {
      if (close) await db.close();
    }
  } catch (err) {
    return { ok: false, tables: [], error: sanitizeProbeError(err) };
  }
}
