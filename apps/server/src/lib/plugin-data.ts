// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { PluginDataApi, PluginDataRecord } from "@justflows/sdk";
import { getDb, type DbClient } from "./db.js";
import { readMigrationDdl, runMigrationStatements } from "./run-migrations.js";

let ensured = false;

async function ensurePluginDataTable(): Promise<void> {
  if (ensured) return;
  const db = await getDb();
  const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb";
  const ddl = await readMigrationDdl("0004_plugin_data", driver);
  if (ddl) await runMigrationStatements(db, ddl, driver);
  ensured = true;
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function parsePayload<T>(raw: unknown): T {
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as T;
  }
}

type DataClient = Pick<DbClient, "run" | "query" | "execute">;

function pluginDataOps(db: DataClient, pluginId: string, siteId: string): PluginDataApi {
  const api: PluginDataApi = {
    async list<T = unknown>(collection: string): Promise<PluginDataRecord<T>[]> {
      const rows = await db.query<{
        item_id: string;
        payload: string | T;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT item_id, payload, created_at, updated_at
           FROM plugin_data
          WHERE site_id = ? AND plugin_id = ? AND collection = ?
          ORDER BY created_at DESC`,
        [siteId, pluginId, collection],
      );
      return rows.map((row) => ({
        id: row.item_id,
        data: parsePayload<T>(row.payload),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }));
    },

    async get<T = unknown>(collection: string, id: string): Promise<PluginDataRecord<T> | undefined> {
      const rows = await db.query<{
        item_id: string;
        payload: string | T;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT item_id, payload, created_at, updated_at
           FROM plugin_data
          WHERE site_id = ? AND plugin_id = ? AND collection = ? AND item_id = ?
          LIMIT 1`,
        [siteId, pluginId, collection, id],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        id: row.item_id,
        data: parsePayload<T>(row.payload),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    },

    async put<T = unknown>(collection: string, id: string, data: T): Promise<void> {
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM plugin_data
          WHERE site_id = ? AND plugin_id = ? AND collection = ? AND item_id = ?
          LIMIT 1`,
        [siteId, pluginId, collection, id],
      );
      const payload = JSON.stringify(data);
      const ts = now();
      if (existing[0]) {
        await db.run(
          `UPDATE plugin_data SET payload = ?, updated_at = ?
            WHERE site_id = ? AND plugin_id = ? AND collection = ? AND item_id = ?`,
          [payload, ts, siteId, pluginId, collection, id],
        );
        return;
      }
      await db.run(
        `INSERT INTO plugin_data
           (id, site_id, plugin_id, collection, item_id, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), siteId, pluginId, collection, id, payload, ts, ts],
      );
    },

    async delete(collection: string, id: string): Promise<void> {
      await db.run(
        `DELETE FROM plugin_data
          WHERE site_id = ? AND plugin_id = ? AND collection = ? AND item_id = ?`,
        [siteId, pluginId, collection, id],
      );
    },

    async cas<T = unknown>(
      collection: string,
      id: string,
      expectedUpdatedAt: string,
      data: T,
    ): Promise<boolean> {
      const payload = JSON.stringify(data);
      const ts = now();
      const updated = await db.execute(
        `UPDATE plugin_data SET payload = ?, updated_at = ?
          WHERE site_id = ? AND plugin_id = ? AND collection = ? AND item_id = ? AND updated_at = ?`,
        [payload, ts, siteId, pluginId, collection, id, expectedUpdatedAt],
      );
      if (updated > 0) return true;
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM plugin_data
          WHERE site_id = ? AND plugin_id = ? AND collection = ? AND item_id = ?
          LIMIT 1`,
        [siteId, pluginId, collection, id],
      );
      if (existing[0]) return false;
      await db.run(
        `INSERT INTO plugin_data
           (id, site_id, plugin_id, collection, item_id, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), siteId, pluginId, collection, id, payload, ts, ts],
      );
      return true;
    },

    async transaction<T>(fn: (tx: PluginDataApi) => Promise<T>): Promise<T> {
      const root = await getDb();
      return root.transaction((tx) => fn(pluginDataOps(tx, pluginId, siteId)));
    },

    async clear(): Promise<void> {
      await db.run("DELETE FROM plugin_data WHERE site_id = ? AND plugin_id = ?", [siteId, pluginId]);
    },
  };
  return api;
}

export async function deleteAllPluginData(pluginId: string, siteId: string): Promise<void> {
  await ensurePluginDataTable();
  const db = await getDb();
  await db.run("DELETE FROM plugin_data WHERE site_id = ? AND plugin_id = ?", [siteId, pluginId]);
}

export function createPluginDataApi(pluginId: string, siteId: string): PluginDataApi {
  return {
    async list<T = unknown>(collection: string): Promise<PluginDataRecord<T>[]> {
      await ensurePluginDataTable();
      return pluginDataOps(await getDb(), pluginId, siteId).list<T>(collection);
    },
    async get<T = unknown>(collection: string, id: string): Promise<PluginDataRecord<T> | undefined> {
      await ensurePluginDataTable();
      return pluginDataOps(await getDb(), pluginId, siteId).get<T>(collection, id);
    },
    async put<T = unknown>(collection: string, id: string, data: T): Promise<void> {
      await ensurePluginDataTable();
      return pluginDataOps(await getDb(), pluginId, siteId).put(collection, id, data);
    },
    async delete(collection: string, id: string): Promise<void> {
      await ensurePluginDataTable();
      return pluginDataOps(await getDb(), pluginId, siteId).delete(collection, id);
    },
    async cas<T = unknown>(
      collection: string,
      id: string,
      expectedUpdatedAt: string,
      data: T,
    ): Promise<boolean> {
      await ensurePluginDataTable();
      return pluginDataOps(await getDb(), pluginId, siteId).cas(collection, id, expectedUpdatedAt, data);
    },
    async transaction<T>(fn: (tx: PluginDataApi) => Promise<T>): Promise<T> {
      await ensurePluginDataTable();
      const root = await getDb();
      return root.transaction((tx) => fn(pluginDataOps(tx, pluginId, siteId)));
    },
    async clear(): Promise<void> {
      await deleteAllPluginData(pluginId, siteId);
    },
  };
}
