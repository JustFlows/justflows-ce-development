// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getControlDb, runWithControlDatabase, type DbClient } from "../database/db.js";
import { enforceQuota, QuotaRefusalError } from "../tenancy/quotas.js";
import { resolvePathUnderBase } from "../security/safe-path.js";

const lockedSite = new AsyncLocalStorage<{ siteId: string; active: boolean }>();
/** A database row lock serializes quota admission across workers and storage types. */
export async function withSiteStorageLock<T>(siteId: string, work: () => Promise<T>): Promise<T> {
  if (lockedSite.getStore()?.active && lockedSite.getStore()?.siteId === siteId) return work();
  if (lockedSite.getStore()?.active)
    throw new Error("Cannot write another site inside a storage reservation");
  const db = await getControlDb();
  return db.transaction(async (tx) => {
    const site = await tx.query<{ id: string }>("SELECT id FROM sites WHERE id = ?", [siteId]);
    if (!site[0]) throw new Error("Storage site was not found");
    await tx.run(
      process.env.DB_DRIVER === "postgres"
        ? "INSERT INTO storage_quota_locks (site_id) VALUES (?) ON CONFLICT (site_id) DO NOTHING"
        : "INSERT IGNORE INTO storage_quota_locks (site_id) VALUES (?)",
      [siteId],
    );
    const lock = await tx.query(
      "SELECT site_id FROM storage_quota_locks WHERE site_id = ? FOR UPDATE",
      [siteId],
    );
    if (!lock[0]) throw new Error("Storage lock could not be acquired");
    const transactionClient: DbClient = {
      ...db,
      ...tx,
      // Nested control transactions use savepoints on the same connection.
      transaction: async (nested) => {
        const savepoint = `storage_${randomUUID().replace(/-/g, "")}`;
        await tx.run(`SAVEPOINT ${savepoint}`);
        try {
          const result = await nested(tx);
          await tx.run(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (err) {
          await tx.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await tx.run(`RELEASE SAVEPOINT ${savepoint}`);
          throw err;
        }
      },
      close: async () => {
        throw new Error("Cannot close a held storage transaction");
      },
    };
    const context = { siteId, active: true };
    try {
      return await lockedSite.run(context, () => runWithControlDatabase(transactionClient, work));
    } finally {
      context.active = false;
      (await import("./storage-snapshots.js")).invalidateStorageSnapshots(siteId);
    }
  });
}

export async function enforceStorageGrowth(siteId: string, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid storage growth");
  if (!bytes) return;
  const refusal = await enforceQuota("storage.bytes", siteId, bytes);
  if (refusal) throw new QuotaRefusalError(refusal);
}

export async function enforceLocalStorageWrites(
  siteId: string,
  root: string,
  files: Array<{ rel: string; body: Buffer }>,
): Promise<void> {
  let growth = 0;
  for (const file of files) {
    const target = resolvePathUnderBase(root, file.rel);
    if (!target) throw new Error("Unsafe storage output path");
    const existing = await fs.stat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    growth += Math.max(0, file.body.length - (existing?.size ?? 0));
  }
  await enforceStorageGrowth(siteId, growth);
}
