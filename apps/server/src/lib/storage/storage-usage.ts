// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import path from "node:path";
import { S3StorageAdapter } from "@justflows/media";
import { getControlDb, getDb } from "../database/db.js";
import { uploadsDir } from "../runtime/jf-root.js";
import { s3UploadConfig, uploadDriver, isSafeUploadKey } from "../media/upload-store.js";
import { privateStorageUsage, privateLocalRoot } from "../files/private-storage.js";
import { installationRootSiteId } from "../tenancy/registry.js";
import { runWithSiteDatabase } from "../tenancy/provision.js";
import { getStaticExportConfig } from "../static-export/config.js";
import { runWithTenant } from "../tenancy/context.js";
import { resolvePathUnderBase } from "../security/safe-path.js";

export interface StorageAmount {
  bytes: number;
  files: number;
}
export interface StorageUsageRow {
  category: "media" | "private" | "exports";
  local: StorageAmount | null;
  external: StorageAmount | null;
}
export interface StorageUsageReport {
  generatedAt: string;
  rows: StorageUsageRow[];
  local: StorageAmount | null;
  external: StorageAmount | null;
  totalBytes: number | null;
  logicalBytes: number | null;
}
export const emptyStorageAmount = (): StorageAmount => ({ bytes: 0, files: 0 });
export function sumStorageAmounts(values: Array<StorageAmount | null>): StorageAmount | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<StorageAmount>(
    (total, value) => ({ bytes: total.bytes + value!.bytes, files: total.files + value!.files }),
    emptyStorageAmount(),
  );
}

/** Never follow symlinks or turn an unreadable directory into zero usage. */
export async function measureLocalDirectory(directory: string): Promise<StorageAmount | null> {
  try {
    const root = await fs.lstat(directory).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!root) return emptyStorageAmount();
    if (!root.isDirectory() || root.isSymbolicLink()) return null;
    const total = emptyStorageAmount();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const target = resolvePathUnderBase(
          directory,
          path.relative(directory, path.join(dir, entry.name)),
        );
        if (!target || entry.isSymbolicLink()) throw new Error("Unsafe storage path");
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile()) {
          total.bytes += (await fs.stat(target)).size;
          total.files++;
        }
      }
    };
    await walk(directory);
    return total;
  } catch {
    return null;
  }
}

export async function measureS3Prefix(
  adapter: S3StorageAdapter,
  prefix: string,
): Promise<StorageAmount | null> {
  try {
    if (!isSafeUploadKey(prefix)) return null;
    const objects = await adapter.listObjects(prefix);
    if (objects.some((object) => !object.key.startsWith(prefix))) return null;
    return {
      bytes: objects.reduce((total, object) => total + object.size, 0),
      files: objects.length,
    };
  } catch {
    return null;
  }
}

function report(rows: StorageUsageRow[], logicalBytes: number | null): StorageUsageReport {
  const local = sumStorageAmounts(rows.map((row) => row.local));
  const external = sumStorageAmounts(rows.map((row) => row.external));
  return {
    generatedAt: new Date().toISOString(),
    rows,
    local,
    external,
    totalBytes: local && external ? local.bytes + external.bytes : null,
    logicalBytes,
  };
}

export async function getSiteStorageUsage(siteId: string): Promise<StorageUsageReport> {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new Error("Invalid site id");
  const db = await getControlDb();
  const rootSite = await installationRootSiteId();
  const domains = await db.query<{ hostname: string }>(
    "SELECT hostname FROM site_domains WHERE site_id = ?",
    [siteId],
  );
  const exportRoot = runWithTenant(
    {
      siteId,
      rootSite: true,
      tenantId: "",
      hostname: "localhost",
      userMode: "isolated",
      databaseMode: "current",
      activePluginIds: null,
    },
    () => getStaticExportConfig().outDir,
  );
  let exportFolders =
    siteId === rootSite
      ? [exportRoot]
      : [...new Set([...domains.map((domain) => domain.hostname), siteId])].map((hostname) =>
          resolvePathUnderBase(`${exportRoot}-sites`, hostname),
        );
  // The manifest preserves ownership when a previous hostname is removed.
  if (siteId !== rootSite) {
    try {
      for (const entry of await fs.readdir(`${exportRoot}-sites`, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const folder = resolvePathUnderBase(`${exportRoot}-sites`, entry.name);
        if (!folder) continue;
        const manifest = resolvePathUnderBase(folder, "_static-export.json");
        if (!manifest) continue;
        try {
          if (JSON.parse(await fs.readFile(manifest, "utf8")).siteId === siteId)
            exportFolders.push(folder);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") exportFolders.push(null);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") exportFolders.push(null);
    }
  }
  exportFolders = [...new Set(exportFolders)];
  const mediaLocal = sumStorageAmounts(
    await Promise.all([
      measureLocalDirectory(path.join(uploadsDir(), siteId)),
      measureLocalDirectory(path.join(uploadsDir(), ".trash", siteId)),
    ]),
  );
  let mediaExternal: StorageAmount | null = emptyStorageAmount();
  let exportExternal: StorageAmount | null = emptyStorageAmount();
  try {
    const config = s3UploadConfig();
    const base = config.prefix ? `${config.prefix}/` : "";
    const adapter = new S3StorageAdapter({
      ...config,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
    });
    // Count retained remote exports even when exports have since been disabled.
    exportExternal = await measureS3Prefix(
      adapter,
      `${base}static-export/sites/${siteId === rootSite ? "root" : siteId}/`,
    );
    if (uploadDriver() === "s3")
      mediaExternal = sumStorageAmounts(
        await Promise.all([
          measureS3Prefix(adapter, `${base}${siteId}/`),
          measureS3Prefix(adapter, `${base}.trash/${siteId}/`),
        ]),
      );
  } catch {
    if (uploadDriver() === "s3" || process.env.STATIC_EXPORT_STORAGE_DRIVER === "s3") {
      mediaExternal = uploadDriver() === "s3" ? null : emptyStorageAmount();
      exportExternal = null;
    }
  }
  let privateUsage: { local: StorageAmount | null; external: StorageAmount | null } = {
    local: null,
    external: null,
  };
  let logicalBytes: number | null = null;
  try {
    await runWithSiteDatabase(siteId, async () => {
      privateUsage = await privateStorageUsage(siteId);
      const siteDb = await getDb();
      const media = await siteDb.query<{ bytes: string | number }>(
        "SELECT COALESCE(SUM(size_bytes + derivative_bytes), 0) AS bytes FROM media WHERE site_id = ?",
        [siteId],
      );
      const files = await siteDb.query<{ bytes: string | number }>(
        "SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM private_files WHERE site_id = ?",
        [siteId],
      );
      logicalBytes = Number(media[0]?.bytes ?? 0) + Number(files[0]?.bytes ?? 0);
    });
  } catch {
    /* Unknown database/storage usage stays unknown. */
  }
  const exportLocal = sumStorageAmounts(
    await Promise.all(
      exportFolders.map((folder) =>
        folder ? measureLocalDirectory(folder) : Promise.resolve(null),
      ),
    ),
  );
  return report(
    [
      { category: "media", local: mediaLocal, external: mediaExternal },
      { category: "private", ...privateUsage },
      { category: "exports", local: exportLocal, external: exportExternal },
    ],
    logicalBytes,
  );
}

/** Local totals include unassigned/retained files. Remote totals cover site namespaces. */
export async function getPlatformStorageUsage(): Promise<StorageUsageReport> {
  const db = await getControlDb();
  const sites = await db.query<{ id: string }>("SELECT id FROM sites");
  const reports: StorageUsageReport[] = [];
  for (const site of sites) reports.push(await getSiteStorageUsage(site.id));
  const exportRoot = runWithTenant(
    {
      siteId: "",
      rootSite: true,
      tenantId: "",
      hostname: "localhost",
      userMode: "isolated",
      databaseMode: "current",
      activePluginIds: null,
    },
    () => getStaticExportConfig().outDir,
  );
  const local = await Promise.all([
    measureLocalDirectory(uploadsDir()),
    measureLocalDirectory(privateLocalRoot()),
    measureLocalDirectory(exportRoot),
    measureLocalDirectory(`${exportRoot}-sites`),
  ]);
  const rows: StorageUsageRow[] = [
    {
      category: "media",
      local: local[0]!,
      external: sumStorageAmounts(reports.map((item) => item.rows[0]!.external)),
    },
    {
      category: "private",
      local: local[1]!,
      external: sumStorageAmounts(reports.map((item) => item.rows[1]!.external)),
    },
    {
      category: "exports",
      local: sumStorageAmounts([local[2]!, local[3]!]),
      external: sumStorageAmounts(reports.map((item) => item.rows[2]!.external)),
    },
  ];
  return report(
    rows,
    reports.some((item) => item.logicalBytes === null)
      ? null
      : reports.reduce((total, item) => total + item.logicalBytes!, 0),
  );
}
