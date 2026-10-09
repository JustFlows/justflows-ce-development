// SPDX-License-Identifier: MIT

import { parseEnvBool } from "@justflows/core";
import {
  LocalStorageAdapter,
  S3StorageAdapter,
  type S3AdapterOptions,
  type S3ObjectResponse,
} from "@justflows/media";
import { uploadsDir } from "../runtime/jf-root.js";
import { resolvePathUnderBase } from "../security/safe-path.js";

/**
 * Where site uploads are stored: the local `uploads/` folder or an
 * S3-compatible bucket (`STORAGE_DRIVER=s3`). Every read and write of an upload
 * goes through {@link getUploadStore}, so both drivers share one key layout
 * (see upload-paths.ts) and the public URL stays `/uploads/<key>` either way.
 */

export type UploadDriver = "local" | "s3";

export interface S3UploadConfig extends S3AdapterOptions {
  /** Key prefix inside the bucket, so several installs can share one bucket. */
  prefix: string;
  /** Public base URL (CDN / public bucket). When set, `/uploads` redirects there. */
  publicUrl: string;
}

export interface UploadStore {
  driver: UploadDriver;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** File contents, or null when missing. */
  read(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Move a file, or a folder when both keys end in "/". False when the source is missing. */
  move(from: string, to: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys under a folder prefix (ending in "/"), recursively. */
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface S3UploadStore extends UploadStore {
  driver: "s3";
  config: S3UploadConfig;
  /** Stream an object to a client; `passthrough` carries range / conditional headers. */
  open(key: string, passthrough?: Record<string, string>): Promise<S3ObjectResponse>;
  /** The object's key inside the bucket (with the configured prefix). */
  bucketKey(key: string): string;
}

const env = (...names: string[]): string => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
};

export function uploadDriver(): UploadDriver {
  return env("STORAGE_DRIVER").toLowerCase() === "s3" ? "s3" : "local";
}

/**
 * S3 settings from the environment. `STORAGE_S3_*` is canonical; the older
 * `S3_*` names from .env.example are still read.
 */
export function s3UploadConfig(): S3UploadConfig {
  const bucket = env("STORAGE_S3_BUCKET", "S3_BUCKET");
  const accessKeyId = env("STORAGE_S3_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID");
  const secretAccessKey = env("STORAGE_S3_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY");
  const missing = [
    !bucket && "STORAGE_S3_BUCKET",
    !accessKeyId && "STORAGE_S3_ACCESS_KEY_ID",
    !secretAccessKey && "STORAGE_S3_SECRET_ACCESS_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`STORAGE_DRIVER=s3 needs ${missing.join(", ")}`);
  }
  const pathStyle = env("STORAGE_S3_FORCE_PATH_STYLE");
  const sessionToken = env("STORAGE_S3_SESSION_TOKEN");
  return {
    bucket,
    region: env("STORAGE_S3_REGION", "S3_REGION") || "us-east-1",
    endpoint: env("STORAGE_S3_ENDPOINT", "S3_ENDPOINT") || undefined,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(pathStyle ? { forcePathStyle: parseEnvBool(pathStyle, false) } : {}),
    prefix: env("STORAGE_S3_PREFIX").replace(/^\/+|\/+$/g, ""),
    publicUrl: env("STORAGE_S3_PUBLIC_URL", "S3_PUBLIC_URL").replace(/\/+$/, ""),
  };
}

/**
 * Reject keys that are absolute, contain `..` / `.` segments, backslashes, or
 * control characters. A trailing "/" (a folder prefix) is allowed.
 */
export function isSafeUploadKey(key: string): boolean {
  if (!key || key.startsWith("/") || key.includes("\\") || /[\u0000-\u001f]/.test(key))
    return false;
  const segments = (key.endsWith("/") ? key.slice(0, -1) : key).split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

function checked(key: string): string {
  if (!isSafeUploadKey(key)) throw new Error(`Unsafe upload key: ${key}`);
  return key;
}

function localStore(root: string): UploadStore {
  const adapter = new LocalStorageAdapter({ rootPath: root, baseUrl: "/uploads" });
  // Also refuses a key that leaves the folder through a symlink.
  const checked = (key: string): string => {
    if (!isSafeUploadKey(key) || !resolvePathUnderBase(root, key)) {
      throw new Error(`Unsafe upload key: ${key}`);
    }
    return key;
  };
  return {
    driver: "local",
    put: async (key, data, type) => {
      await adapter.save(checked(key), data, type);
    },
    read: async (key) => (await adapter.read(checked(key)))?.body ?? null,
    exists: (key) => adapter.exists(checked(key)),
    move: (from, to) => adapter.move(checked(from), checked(to)),
    delete: (key) => adapter.delete(checked(key)),
    list: (prefix) => adapter.list(checked(prefix)),
    deletePrefix: (prefix) => adapter.deletePrefix(checked(prefix)),
  };
}

function s3Store(config: S3UploadConfig): S3UploadStore {
  const adapter = new S3StorageAdapter(config);
  const bucketKey = (key: string) =>
    config.prefix ? `${config.prefix}/${checked(key)}` : checked(key);
  const strip = (key: string) => (config.prefix ? key.slice(config.prefix.length + 1) : key);
  return {
    driver: "s3",
    config,
    bucketKey,
    put: async (key, data, type) => {
      await adapter.save(bucketKey(key), data, type);
    },
    read: async (key) => (await adapter.read(bucketKey(key)))?.body ?? null,
    exists: (key) => adapter.exists(bucketKey(key)),
    move: async (from, to) => {
      const parts = checked(from).split("/");
      const candidate = parts[0] === ".trash" ? parts[1] : parts[0];
      const siteId = candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate) ? candidate
        : (await import("../tenancy/context.js")).getTenantContext()?.siteId ?? await (await import("../tenancy/registry.js")).installationRootSiteId();
      if (!siteId) throw new Error("Storage move needs an installed site");
      const { withSiteStorageLock, enforceStorageGrowth } = await import("../storage/storage-quota.js");
      return withSiteStorageLock(siteId, async () => {
        const source = bucketKey(from);
        const inventory = await adapter.listObjects(source);
        const objects = inventory.filter((object) => from.endsWith("/") ? object.key.startsWith(source) : object.key === source);
        await enforceStorageGrowth(siteId, objects.reduce((total, object) => total + object.size, 0));
        return adapter.move(source, bucketKey(to));
      });
    },
    delete: (key) => adapter.delete(bucketKey(key)),
    list: async (prefix) => (await adapter.list(bucketKey(prefix))).map(strip),
    deletePrefix: (prefix) => adapter.deletePrefix(bucketKey(prefix)),
    open: (key, passthrough) => adapter.open(bucketKey(key), passthrough),
  };
}

let cached: { signature: string; store: UploadStore } | null = null;

/** The configured store. Re-reads the environment, so a changed setting applies without a restart. */
export function getUploadStore(): UploadStore {
  const driver = uploadDriver();
  const s3 = driver === "s3" ? s3UploadConfig() : null;
  const signature = JSON.stringify(s3 ?? uploadsDir());
  if (cached?.signature !== signature) {
    cached = { signature, store: s3 ? s3Store(s3) : localStore(uploadsDir()) };
  }
  return cached.store;
}

/** A local store rooted at an explicit folder (used to copy local uploads into S3). */
export function localUploadStore(root = uploadsDir()): UploadStore {
  return localStore(root);
}

export function isS3UploadStore(store: UploadStore): store is S3UploadStore {
  return store.driver === "s3";
}

/** Contents of an upload, or null when the key is unsafe, missing, or unreadable. */
export async function readUpload(key: string): Promise<Buffer | null> {
  if (!isSafeUploadKey(key)) return null;
  try {
    return await getUploadStore().read(key);
  } catch {
    return null;
  }
}
