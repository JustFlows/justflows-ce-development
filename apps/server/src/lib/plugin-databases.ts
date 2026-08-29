// SPDX-License-Identifier: MIT

import type {
  PluginDatabasesApi,
  PluginDatabaseDriver,
  PluginDatabaseTarget,
  PluginPermission,
  PluginSchemaTable,
} from "@justflows/sdk";
import type { DbClient } from "./db.js";
import { isLocalDatabaseHost, probeDatabase, probeSharedDatabase } from "./db-probe.js";
import {
  applyPluginSchema,
  dropPluginSchema,
  isPluginOwnedTable,
  openTargetDatabase,
  pluginTableName,
} from "./plugin-schema.js";
import {
  PLUGIN_HOST_SCHEMA_ITEM,
  PLUGIN_HOST_SCHEMA_PASSWORD_ITEM,
  getPluginHostItem,
} from "./plugin-kv.js";
import { decryptSecret } from "./secret-box.js";
import { getSiteId } from "./site-settings.js";
import { recordAppliedPluginSchema, type AppliedPluginSchemaMeta } from "./plugin-purge.js";

const IDENT = /^[a-z][a-z0-9_]{0,47}$/;

type Scalar = string | number | boolean | null;

function quoteIdent(value: string, driver: PluginDatabaseDriver): string {
  if (!IDENT.test(value)) {
    throw new Error(`Invalid identifier "${value}"`);
  }
  return driver === "postgres" ? `"${value}"` : `\`${value}\``;
}

function ownedTable(pluginId: string, table: string): string {
  const tableName = pluginTableName(pluginId, table);
  if (!isPluginOwnedTable(pluginId, tableName)) {
    throw new Error(`Plugin "${pluginId}" cannot query table "${table}"`);
  }
  return tableName;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

async function recordedTarget(
  pluginId: string,
  siteId: string,
): Promise<{ target?: PluginDatabaseTarget; tables?: string[] }> {
  const meta = await getPluginHostItem<AppliedPluginSchemaMeta>(
    pluginId,
    siteId,
    PLUGIN_HOST_SCHEMA_ITEM,
  );
  if (!meta?.target) return { tables: meta?.tables };
  const stored = await getPluginHostItem<string>(pluginId, siteId, PLUGIN_HOST_SCHEMA_PASSWORD_ITEM);
  return {
    tables: meta.tables,
    target: { ...meta.target, password: decryptSecret(stored ?? "") },
  };
}

async function openHandle(
  pluginId: string,
  siteId: string,
  permissions: ReadonlySet<PluginPermission> | ReadonlySet<string>,
): Promise<{ db: DbClient; close: boolean; driver: PluginDatabaseDriver }> {
  const recorded = await recordedTarget(pluginId, siteId);
  if (recorded.target) {
    if (!isLocalDatabaseHost(recorded.target.host) && !permissions.has("network:outbound")) {
      throw new Error(
        `Plugin "${pluginId}" cannot use a remote database without the "network:outbound" permission.`,
      );
    }
    return {
      db: await openTargetDatabase(recorded.target),
      close: true,
      driver: recorded.target.driver,
    };
  }
  const { getDb } = await import("./db.js");
  return {
    db: await getDb(),
    close: false,
    driver: (process.env.DB_DRIVER as PluginDatabaseDriver | undefined) || "mysql",
  };
}

export function createPluginDatabasesApi(
  pluginId: string,
  siteId: string,
  permissions: ReadonlySet<PluginPermission> | ReadonlySet<string>,
): PluginDatabasesApi {
  return {
    probeShared: () => probeSharedDatabase(),
    async probe(target: PluginDatabaseTarget) {
      if (!isLocalDatabaseHost(target.host) && !permissions.has("network:outbound")) {
        return {
          ok: false,
          error: `Plugin "${pluginId}" cannot probe a remote database without the "network:outbound" permission.`,
          dialect: target.driver,
          tls: Boolean(target.ssl),
          latencyMs: 0,
        };
      }
      return probeDatabase(target);
    },
    async ensureSchema(tables: PluginSchemaTable[], options?: { target?: PluginDatabaseTarget; rebuild?: string[] }) {
      const result = await applyPluginSchema({
        pluginId,
        tables,
        ...(options?.target ? { target: options.target } : {}),
        ...(options?.rebuild?.length ? { rebuild: options.rebuild } : {}),
        allowRemote: permissions.has("network:outbound"),
      });
      if (result.ok) {
        try {
          await recordAppliedPluginSchema(pluginId, result.tables, options?.target);
        } catch {
          // Tables exist; remembering the target must not fail activation.
        }
      }
      return result;
    },
    async dropSchema(tables?: PluginSchemaTable[], options?: { target?: PluginDatabaseTarget }) {
      let target = options?.target;
      let knownTables: string[] | undefined;
      try {
        const sid = siteId || (await getSiteId()) || "";
        if (sid) {
          const recorded = await recordedTarget(pluginId, sid);
          knownTables = recorded.tables;
          if (!target && recorded.target) target = recorded.target;
        }
      } catch {
        // Plugin-supplied arguments are enough when host metadata is missing.
      }
      return dropPluginSchema({
        pluginId,
        ...(tables ? { tables } : {}),
        ...(target ? { target } : {}),
        ...(knownTables ? { knownTables } : {}),
        allowRemote: permissions.has("network:outbound"),
      });
    },
    async upsert(table, row, options) {
      const tableName = ownedTable(pluginId, table);
      const handle = await openHandle(pluginId, siteId, permissions);
      const match = (options?.match?.length ? options.match : ["id"]).filter((col) => IDENT.test(col));
      const payload: Record<string, Scalar> = { ...row, site_id: siteId };
      const columns = Object.keys(payload).filter((col) => IDENT.test(col));
      if (columns.length === 0) return;
      try {
        const whereCols = match.filter((col) => payload[col] !== undefined && payload[col] !== null);
        let existingId: string | undefined;
        if (whereCols.length > 0) {
          const clause = whereCols.map((col) => `${quoteIdent(col, handle.driver)} = ?`).join(" AND ");
          const rows = await handle.db.query<{ id: string }>(
            `SELECT id FROM ${quoteIdent(tableName, handle.driver)} WHERE ${quoteIdent("site_id", handle.driver)} = ? AND ${clause} LIMIT 1`,
            [siteId, ...whereCols.map((col) => payload[col] ?? null)],
          );
          existingId = rows[0]?.id ? asString(rows[0].id) : undefined;
        } else {
          const rows = await handle.db.query<{ id: string }>(
            `SELECT id FROM ${quoteIdent(tableName, handle.driver)} WHERE ${quoteIdent("site_id", handle.driver)} = ? LIMIT 1`,
            [siteId],
          );
          existingId = rows[0]?.id ? asString(rows[0].id) : undefined;
        }
        if (existingId) {
          const updates = columns.filter((col) => col !== "id" && col !== "site_id");
          if (updates.length === 0) return;
          await handle.db.run(
            `UPDATE ${quoteIdent(tableName, handle.driver)} SET ${updates.map((col) => `${quoteIdent(col, handle.driver)} = ?`).join(", ")} WHERE ${quoteIdent("site_id", handle.driver)} = ? AND ${quoteIdent("id", handle.driver)} = ?`,
            [...updates.map((col) => payload[col] ?? null), siteId, existingId],
          );
          return;
        }
        await handle.db.run(
          `INSERT INTO ${quoteIdent(tableName, handle.driver)} (${columns.map((col) => quoteIdent(col, handle.driver)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((col) => payload[col] ?? null),
        );
      } finally {
        if (handle.close) await handle.db.close();
      }
    },
    async findOne(table, where = {}) {
      const tableName = ownedTable(pluginId, table);
      const handle = await openHandle(pluginId, siteId, permissions);
      const filters = Object.entries(where).filter(([col]) => IDENT.test(col));
      try {
        const clause = [
          `${quoteIdent("site_id", handle.driver)} = ?`,
          ...filters.map(([col]) => `${quoteIdent(col, handle.driver)} = ?`),
        ].join(" AND ");
        const rows = await handle.db.query<Record<string, unknown>>(
          `SELECT * FROM ${quoteIdent(tableName, handle.driver)} WHERE ${clause} LIMIT 1`,
          [siteId, ...filters.map(([, value]) => value)],
        );
        return rows[0];
      } catch {
        return undefined;
      } finally {
        if (handle.close) await handle.db.close();
      }
    },
    async find(table, where = {}, options) {
      const tableName = ownedTable(pluginId, table);
      const handle = await openHandle(pluginId, siteId, permissions);
      const filters = Object.entries(where).filter(([col]) => IDENT.test(col));
      const limit = Math.min(Math.max(1, Math.trunc(options?.limit ?? 100)), 500);
      try {
        const clause = [
          `${quoteIdent("site_id", handle.driver)} = ?`,
          ...filters.map(([col]) => `${quoteIdent(col, handle.driver)} = ?`),
        ].join(" AND ");
        return await handle.db.query<Record<string, unknown>>(
          `SELECT * FROM ${quoteIdent(tableName, handle.driver)} WHERE ${clause} LIMIT ?`,
          [siteId, ...filters.map(([, value]) => value), limit],
        );
      } catch {
        return [];
      } finally {
        if (handle.close) await handle.db.close();
      }
    },
    async delete(table, where) {
      const tableName = ownedTable(pluginId, table);
      const filters = Object.entries(where).filter(([col]) => IDENT.test(col));
      if (filters.length === 0) {
        throw new Error(`Plugin "${pluginId}" cannot delete from "${table}" without a column match`);
      }
      const handle = await openHandle(pluginId, siteId, permissions);
      try {
        const clause = [
          `${quoteIdent("site_id", handle.driver)} = ?`,
          ...filters.map(([col]) => `${quoteIdent(col, handle.driver)} = ?`),
        ].join(" AND ");
        await handle.db.run(
          `DELETE FROM ${quoteIdent(tableName, handle.driver)} WHERE ${clause}`,
          [siteId, ...filters.map(([, value]) => value)],
        );
      } finally {
        if (handle.close) await handle.db.close();
      }
    },
    async columns(table) {
      const tableName = ownedTable(pluginId, table);
      const handle = await openHandle(pluginId, siteId, permissions);
      try {
        if (handle.driver === "postgres") {
          const rows = await handle.db.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
            [tableName],
          );
          return rows.map((row) => asString(row.column_name));
        }
        const rows = await handle.db.query<{ Field: string; field?: string }>(
          `SHOW COLUMNS FROM ${quoteIdent(tableName, handle.driver)}`,
        );
        return rows.map((row) => asString(row.Field ?? row.field ?? ""));
      } catch {
        return [];
      } finally {
        if (handle.close) await handle.db.close();
      }
    },
  };
}
