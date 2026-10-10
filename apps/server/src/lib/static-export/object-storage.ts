// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import { S3StorageAdapter } from "@justflows/media";
import { z } from "zod";
import { s3UploadConfig, isSafeUploadKey } from "../media/upload-store.js";
import { resolvePathUnderBase } from "../security/safe-path.js";
import { getTenantContext } from "../tenancy/context.js";
import { purgeCdnCache } from "../cdn/cdn-purge.js";
import { sha256, type StaticExportManifest } from "./manifest.js";

export function staticExportDriver(): "local" | "s3" {
  const value = process.env.STATIC_EXPORT_STORAGE_DRIVER?.trim() || "local";
  if (value !== "local" && value !== "s3")
    throw new Error("STATIC_EXPORT_STORAGE_DRIVER must be local or s3");
  return value;
}

/** Stable site ids keep exports isolated even when a site's primary domain changes. */
export function staticExportObjectPrefix(): string {
  const config = s3UploadConfig();
  const ctx = getTenantContext();
  const site = !ctx || ctx.rootSite ? "root" : ctx.siteId;
  if (!/^[A-Za-z0-9_-]+$/.test(site)) throw new Error("Invalid static export site id");
  const prefix = [config.prefix, "static-export", "sites", site].filter(Boolean).join("/");
  if (!isSafeUploadKey(prefix)) throw new Error("Invalid static export storage prefix");
  return `${prefix}/`;
}

const entrySchema = z.object({
  path: z.string().startsWith("/").max(4096),
  file: z.string().max(4096).refine(isSafeUploadKey),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z
    .string()
    .max(200)
    .regex(/^[^\r\n]+$/),
  cacheControl: z
    .string()
    .max(500)
    .regex(/^[^\r\n]+$/),
});
const deploymentSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema).max(200_000),
});
export type DeployedEntry = z.infer<typeof entrySchema>;

export function isHtmlExportEntry(entry: { contentType: string }): boolean {
  return entry.contentType.split(";")[0]?.trim().toLowerCase() === "text/html";
}
const POINTER = "_deployment.json";

export function deployedObjectKey(prefix: string, entry: DeployedEntry): string {
  return `${prefix}objects/${entry.sha256}/${entry.file}`;
}

export function staticExportObjectStore(): { adapter: S3StorageAdapter; prefix: string } {
  return {
    adapter: new S3StorageAdapter({
      ...s3UploadConfig(),
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
    }),
    prefix: staticExportObjectPrefix(),
  };
}

async function readDeployment(adapter: S3StorageAdapter, prefix: string): Promise<{
  entries: DeployedEntry[]; bytes: number;
} | null> {
  const object = await adapter.read(`${prefix}${POINTER}`);
  if (!object) return null;
  return { entries: deploymentSchema.parse(JSON.parse(object.body.toString("utf8"))).entries,
    bytes: object.body.length };
}

export async function readDeployedEntries(
  adapter: S3StorageAdapter, prefix: string,
): Promise<DeployedEntry[] | null> {
  return (await readDeployment(adapter, prefix))?.entries ?? null;
}

/** Upload immutable objects first, then publish the routing pointer in one PUT.
 * A failed upload leaves the previous deployment available. Only manifest files
 * are uploaded: server configs and internal export metadata remain local.
 */
export async function deployStaticExport(
  outDir: string,
  manifest: StaticExportManifest,
): Promise<void> {
  const { adapter, prefix } = staticExportObjectStore();
  const deployment = await readDeployment(adapter, prefix);
  const previous = deployment?.entries;
  const routesByFile = new Map<string, StaticExportManifest["routes"][number]>();
  for (const route of manifest.routes) {
    if (!routesByFile.has(route.file)) routesByFile.set(route.file, route);
  }
  const known = new Set((previous ?? []).map((entry) => deployedObjectKey(prefix, entry)));
  const entries = deploymentSchema.parse({
    version: 1,
    entries: manifest.routes.filter(isHtmlExportEntry),
  }).entries;
  const pointer = Buffer.from(JSON.stringify({ version: 1, entries }));
  const growth = entries.filter((entry) => !known.has(deployedObjectKey(prefix, entry))).reduce((total, entry) => total + (routesByFile.get(entry.file)?.bytes ?? 0), 0) + Math.max(0, pointer.length - (deployment?.bytes ?? 0));
  const siteId = getTenantContext()?.siteId ?? await (await import("../tenancy/registry.js")).installationRootSiteId();
  if (!siteId) throw new Error("Export storage needs an installed site");
  await (await import("../storage/storage-quota.js")).enforceStorageGrowth(siteId, growth);
  for (const entry of entries) {
    const key = deployedObjectKey(prefix, entry);
    if (known.has(key)) continue;
    const file = resolvePathUnderBase(outDir, entry.file);
    if (!file) throw new Error("Unsafe static export file");
    const body = await fs.readFile(file);
    if (body.length !== routesByFile.get(entry.file)?.bytes || sha256(body) !== entry.sha256)
      throw new Error("Static export file changed during deployment");
    await adapter.save(key, body, entry.contentType, entry.cacheControl);
  }
  await adapter.save(
    `${prefix}${POINTER}`,
    pointer,
    "application/json",
    "no-store",
  );
  // Retire duplicated assets from exports made before HTML-only S3 mode.
  // Original media objects are outside this site's reserved namespace.
  for (const entry of previous ?? []) {
    if (!isHtmlExportEntry(entry)) {
      try {
        await adapter.delete(deployedObjectKey(prefix, entry));
      } catch {
        console.error(
          "[static-export] could not remove an old exported asset; use Clear export to retry cleanup",
        );
      }
    }
  }
  await purgeStaticExportCdn(manifest.publicUrl);
  // Keep old immutable objects until Clear: concurrent readers may still be
  // streaming the previous pointer. Removed routes are no longer addressable.
}

export async function purgeStaticExportCdn(publicUrl?: string): Promise<void> {
  const ctx = getTenantContext();
  try {
    const hostname =
      ctx?.hostname || new URL(publicUrl || process.env.APP_URL || "http://localhost").hostname;
    await purgeCdnCache({ hostname, ...(ctx ? { siteId: ctx.siteId } : {}) });
  } catch {
    console.error("[static-export] CDN purge failed after object storage update");
  }
}

/** Remove only this site's reserved export namespace, never uploads/private files. */
export async function clearDeployedStaticExport(): Promise<boolean> {
  const { adapter, prefix } = staticExportObjectStore();
  const keys = await adapter.list(`${prefix}objects/`);
  if (keys.some((key) => !key.startsWith(`${prefix}objects/`) || !isSafeUploadKey(key)))
    throw new Error("Unsafe static export object key");
  const hadPointer = await adapter.exists(`${prefix}${POINTER}`);
  await adapter.delete(`${prefix}${POINTER}`);
  await purgeStaticExportCdn();
  for (const key of keys) {
    if (!key.startsWith(`${prefix}objects/`) || !isSafeUploadKey(key))
      throw new Error("Unsafe static export object key");
    await adapter.delete(key);
  }
  return hadPointer || keys.length > 0;
}
