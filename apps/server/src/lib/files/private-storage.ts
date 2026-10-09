// SPDX-License-Identifier: MIT

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { S3StorageAdapter } from "@justflows/media";
import { getControlDb, getDb } from "../database/db.js";
import { getJfRoot, uploadsDir } from "../runtime/jf-root.js";
import { decryptSecret, encryptSecret } from "../security/secret-box.js";
import { getSiteSetting, parseSettingValue, setSiteSetting, settingsKeyColumn } from "../settings/site-settings.js";
import { installationRootSiteId } from "../tenancy/registry.js";
import { checkQuota, enforceQuota, QuotaRefusalError } from "../tenancy/quotas.js";
import { isSafeUploadKey, s3UploadConfig, uploadDriver } from "../media/upload-store.js";

/**
 * Private file storage: files a plugin keeps for one site that are never
 * public, such as products sold as downloads. Browsers never get a storage
 * address; a plugin route answers with a file reference and the host streams
 * the bytes (see plugin-http.ts).
 *
 * Which storage a site uses, first match wins:
 *
 * 1. Its own S3-compatible connection, when it saved one and its plan allows
 *    it (`feature.ownStorage`).
 * 2. The root site's connection, saved in the installation database.
 * 3. The environment's bucket (`STORAGE_DRIVER=s3`), under `.private/`, unless
 *    `STORAGE_S3_PUBLIC_URL` makes that bucket public.
 * 4. Local disk, `PRIVATE_STORAGE_PATH` or `<root>/storage/private`, never
 *    inside the public uploads folder.
 *
 * Objects are `<siteId>/<owner>/<key>`: one folder per site, then per plugin.
 * `private_files` records each file for usage limits and for copying files when
 * the storage changes. A replaced connection is kept (encrypted) until no file
 * is stored there any more.
 */

export const PRIVATE_STORAGE_SETTING = "private_storage";
/** Folder of the public uploads bucket that holds private files. `/uploads` refuses it. */
export const PRIVATE_UPLOADS_FOLDER = ".private";

const OWNER_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_KEY = 512;

export type PrivateStorageSource = "site" | "platform" | "environment" | "local";

export interface S3ConnectionValues {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
}

interface StoredConnection {
  /** New on every save, so files know which connection holds them. */
  id: string;
  values: S3ConnectionValues;
  /** Encrypted with secret-box. */
  secrets: { accessKeyId: string; secretAccessKey: string };
  last4: { accessKeyId: string; secretAccessKey: string };
  updatedAt: string;
}

interface StoredSetting {
  current: StoredConnection | null;
  /** Connections that may still hold files until the copy job moved them. */
  previous: StoredConnection[];
}

export interface PrivateStorageView {
  connection: (S3ConnectionValues & { accessKeyId: { last4: string }; secretAccessKey: { last4: string }; updatedAt: string }) | null;
}

export interface PrivateObjectStream {
  status: 200 | 206;
  size: number;
  /** `bytes start-end/size` for a partial answer. */
  contentRange?: string;
  body: Readable;
}

/** One place private files can live. */
export interface PrivateBackend {
  /** Stable id of this storage, stored on each file. */
  id: string;
  inventoryKey?: string;
  source: PrivateStorageSource;
  measure?: (siteId: string) => Promise<{ bytes: number; files: number } | null>;
  put(objectKey: string, data: Buffer, contentType: string): Promise<void>;
  read(objectKey: string): Promise<Buffer | null>;
  open(objectKey: string, range?: string): Promise<PrivateObjectStream | null>;
  delete(objectKey: string): Promise<void>;
}

export interface PrivateFileInfo {
  key: string;
  size: number;
  contentType: string;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

export class PrivateStorageError extends Error {}

// ---------------------------------------------------------------- settings

function isConnection(value: unknown): value is StoredConnection {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StoredConnection>;
  return typeof row.id === "string" && !!row.values && typeof row.values.bucket === "string" && !!row.secrets;
}

function asSetting(value: unknown): StoredSetting {
  if (!value || typeof value !== "object") return { current: null, previous: [] };
  const row = value as Partial<StoredSetting>;
  return {
    current: isConnection(row.current) ? row.current : null,
    previous: Array.isArray(row.previous) ? row.previous.filter(isConnection) : [],
  };
}

/** The setting as this site stored it, in its own database. */
async function readSiteSetting(siteId: string): Promise<StoredSetting> {
  return asSetting(await getSiteSetting<unknown>(siteId, PRIVATE_STORAGE_SETTING));
}

/** The root site's setting, read from the installation database. */
async function readRootSetting(rootId: string): Promise<StoredSetting> {
  const db = await getControlDb();
  const rows = await db.query<{ value: unknown }>(
    `SELECT value FROM site_settings WHERE site_id = ? AND ${settingsKeyColumn()} = ? LIMIT 1`,
    [rootId, PRIVATE_STORAGE_SETTING],
  );
  return asSetting(parseSettingValue<unknown>(rows.length > 0, rows[0]?.value));
}

function view(stored: StoredConnection | null): PrivateStorageView {
  if (!stored) return { connection: null };
  return {
    connection: {
      ...stored.values,
      accessKeyId: { last4: stored.last4.accessKeyId },
      secretAccessKey: { last4: stored.last4.secretAccessKey },
      updatedAt: stored.updatedAt,
    },
  };
}

export async function getPrivateStorageSettings(siteId: string): Promise<PrivateStorageView> {
  return view((await readSiteSetting(siteId)).current);
}

export interface SavePrivateStorageInput {
  endpoint?: string;
  region?: string;
  bucket: string;
  prefix?: string;
  forcePathStyle?: boolean;
  /** Empty keeps the saved key. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

function cleanValues(input: SavePrivateStorageInput): S3ConnectionValues {
  const endpoint = (input.endpoint ?? "").trim().replace(/\/+$/, "");
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new PrivateStorageError("Enter the endpoint as an address, for example https://s3.gra.io.cloud.ovh.net.");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) {
      throw new PrivateStorageError("The endpoint must use https.");
    }
  }
  const bucket = input.bucket.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new PrivateStorageError("Enter a valid bucket name.");
  const region = (input.region ?? "").trim() || "us-east-1";
  if (!/^[a-z0-9-]{1,40}$/.test(region)) throw new PrivateStorageError("Enter a valid region.");
  const prefix = (input.prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (prefix && (!isSafeUploadKey(prefix) || prefix.length > 120)) throw new PrivateStorageError("Enter a valid folder.");
  return { endpoint, region, bucket, prefix, forcePathStyle: input.forcePathStyle ?? Boolean(endpoint) };
}

/** Build the connection a save would store, keeping saved keys when none are entered. */
function nextConnection(input: SavePrivateStorageInput, current: StoredConnection | null): StoredConnection {
  const values = cleanValues(input);
  const key = (input.accessKeyId ?? "").trim();
  const secret = (input.secretAccessKey ?? "").trim();
  if ((!key || !secret) && !current) throw new PrivateStorageError("Enter the access key and secret key.");
  return {
    id: randomUUID(),
    values,
    secrets: {
      accessKeyId: key ? encryptSecret(key) : current!.secrets.accessKeyId,
      secretAccessKey: secret ? encryptSecret(secret) : current!.secrets.secretAccessKey,
    },
    last4: {
      accessKeyId: key ? key.slice(-4) : current!.last4.accessKeyId,
      secretAccessKey: secret ? secret.slice(-4) : current!.last4.secretAccessKey,
    },
    updatedAt: new Date().toISOString(),
  };
}

function s3Backend(stored: StoredConnection, source: "site" | "platform"): PrivateBackend | null {
  const accessKeyId = decryptSecret(stored.secrets.accessKeyId);
  const secretAccessKey = decryptSecret(stored.secrets.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) return null;
  const { endpoint, region, bucket, prefix, forcePathStyle } = stored.values;
  return s3Store(
    `${source}:${stored.id}`,
    source,
    new S3StorageAdapter({ bucket, region, ...(endpoint ? { endpoint } : {}), accessKeyId, secretAccessKey, forcePathStyle }),
    prefix,
  );
}

/** Write a small object and read it back, so a wrong key or bucket is caught before saving. */
export async function testPrivateStorage(siteId: string, input: SavePrivateStorageInput): Promise<void> {
  const current = (await readSiteSetting(siteId)).current;
  const backend = s3Backend(nextConnection(input, current), "site");
  if (!backend) throw new PrivateStorageError("The saved keys could not be read. Enter them again.");
  const probe = `${siteId}/.connection-test-${randomUUID()}`;
  try {
    await backend.put(probe, Buffer.from("justflows"), "text/plain");
    const back = await backend.read(probe);
    if (back?.toString() !== "justflows") throw new PrivateStorageError("The bucket did not return what was written.");
  } catch (err) {
    if (err instanceof PrivateStorageError) throw err;
    throw new PrivateStorageError(`The storage refused the test: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`);
  } finally {
    await backend.delete(probe).catch(() => undefined);
  }
}

/** Save the site's connection. The replaced one is kept until its files are copied. */
export async function savePrivateStorage(siteId: string, input: SavePrivateStorageInput): Promise<PrivateStorageView> {
  return (await import("../storage/storage-quota.js")).withSiteStorageLock(siteId, () => savePrivateStorageLocked(siteId, input));
}
async function savePrivateStorageLocked(siteId: string, input: SavePrivateStorageInput): Promise<PrivateStorageView> {
  const setting = await readSiteSetting(siteId);
  const next = nextConnection(input, setting.current);
  const previous = setting.current ? [setting.current, ...setting.previous] : setting.previous;
  await setSiteSetting(siteId, PRIVATE_STORAGE_SETTING, { current: next, previous } satisfies StoredSetting);
  return view(next);
}

/** Stop using the site's connection; it falls back to the next storage in line. */
export async function clearPrivateStorage(siteId: string): Promise<void> {
  return (await import("../storage/storage-quota.js")).withSiteStorageLock(siteId, () => clearPrivateStorageLocked(siteId));
}
async function clearPrivateStorageLocked(siteId: string): Promise<void> {
  const setting = await readSiteSetting(siteId);
  if (!setting.current) return;
  await setSiteSetting(siteId, PRIVATE_STORAGE_SETTING, {
    current: null,
    previous: [setting.current, ...setting.previous],
  } satisfies StoredSetting);
}

/**
 * Drop replaced connections no file is stored on any more. For the root site
 * `inUse` must cover every site, since they all read the platform's earlier
 * connections.
 */
export async function forgetUnusedConnections(siteId: string, inUse: Set<string>): Promise<void> {
  return (await import("../storage/storage-quota.js")).withSiteStorageLock(siteId, () => forgetUnusedConnectionsLocked(siteId, inUse));
}
async function forgetUnusedConnectionsLocked(siteId: string, inUse: Set<string>): Promise<void> {
  const setting = await readSiteSetting(siteId);
  const rootId = await installationRootSiteId();
  const ids = rootId === siteId ? (await (await getControlDb()).query<{ id: string }>("SELECT id FROM sites")).map((row) => row.id) : [siteId];
  const keep = [];
  for (const item of setting.previous) {
    if (inUse.has(`site:${item.id}`) || inUse.has(`platform:${item.id}`)) { keep.push(item); continue; }
    const backend = s3Backend(item, rootId === siteId ? "platform" : "site");
    let empty = Boolean(backend?.measure);
    for (const id of ids) {
      const usage = await backend?.measure?.(id).catch(() => null);
      if (!usage || usage.bytes > 0 || usage.files > 0) { empty = false; break; }
    }
    if (!empty) keep.push(item);
  }
  if (keep.length === setting.previous.length) return;
  await setSiteSetting(siteId, PRIVATE_STORAGE_SETTING, { current: setting.current, previous: keep } satisfies StoredSetting);
}

// ---------------------------------------------------------------- backends

function s3Store(id: string, source: PrivateStorageSource, adapter: S3StorageAdapter, prefix: string): PrivateBackend {
  const full = (key: string) => (prefix ? `${prefix}/${key}` : key);
  return {
    id,
    inventoryKey: adapter.objectUrl(prefix).toString(),
    source,
    put: async (key, data, type) => {
      await adapter.save(full(key), data, type);
    },
    read: async (key) => (await adapter.read(full(key)))?.body ?? null,
    open: async (key, range) => {
      const res = await adapter.open(full(key), range ? { range } : {});
      if (res.status === 404 || !res.body) return null;
      if (res.status !== 200 && res.status !== 206) throw new Error(`Storage answered ${res.status}`);
      const contentRange = res.headers.get("content-range") ?? undefined;
      const total = contentRange ? Number(contentRange.split("/")[1]) : Number(res.headers.get("content-length") ?? 0);
      return {
        status: res.status,
        size: Number.isFinite(total) ? total : 0,
        ...(contentRange ? { contentRange } : {}),
        body: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
      };
    },
    delete: (key) => adapter.delete(full(key)),
    measure: async (siteId) => (await import("../storage/storage-usage.js")).measureS3Prefix(adapter, full(`${siteId}/`)),
  };
}

/** `bytes=a-b` within `size`, or null for no or an unusable range. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!match || size <= 0) return null;
  const [, a, b] = match;
  if (!a && !b) return null;
  let start: number;
  let end: number;
  if (!a) {
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : null;
}

export function privateLocalRoot(): string {
  const configured = process.env.PRIVATE_STORAGE_PATH?.trim();
  const root = configured ? (path.isAbsolute(configured) ? configured : path.join(getJfRoot(), configured)) : path.join(getJfRoot(), "storage", "private");
  const uploads = path.resolve(uploadsDir());
  const resolved = path.resolve(root);
  if (resolved === uploads || resolved.startsWith(uploads + path.sep)) {
    throw new PrivateStorageError("PRIVATE_STORAGE_PATH cannot be inside the public uploads folder.");
  }
  return resolved;
}

export function localPrivateBackend(root: string): PrivateBackend {
  const resolve = (key: string): string => {
    const target = path.resolve(root, key);
    if (!isSafeUploadKey(key) || !target.startsWith(root + path.sep)) throw new Error(`Unsafe private file key: ${key}`);
    return target;
  };
  return {
    id: `local:${root}`,
    source: "local",
    inventoryKey: path.resolve(root),
    measure: async (siteId) => (await import("../storage/storage-usage.js")).measureLocalDirectory(path.join(root, siteId)),
    put: async (key, data) => {
      const target = resolve(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.part`;
      await fs.writeFile(temp, data);
      await fs.rename(temp, target);
    },
    read: async (key) => fs.readFile(resolve(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    }),
    open: async (key, range) => {
      const target = resolve(key);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat?.isFile()) return null;
      const part = parseByteRange(range, stat.size);
      if (part) {
        return {
          status: 206,
          size: stat.size,
          contentRange: `bytes ${part.start}-${part.end}/${stat.size}`,
          body: createReadStream(target, { start: part.start, end: part.end }),
        };
      }
      return { status: 200, size: stat.size, body: createReadStream(target) };
    },
    delete: async (key) => {
      await fs.rm(resolve(key), { force: true });
    },
  };
}

/** The environment bucket, when it may hold private files. */
function environmentBackend(): PrivateBackend | null {
  if (uploadDriver() !== "s3") return null;
  const config = s3UploadConfig();
  // A public bucket would serve private files to anyone with the address.
  if (config.publicUrl) return null;
  const prefix = [config.prefix, PRIVATE_UPLOADS_FOLDER].filter(Boolean).join("/");
  return s3Store(`environment:${config.bucket}/${prefix}`, "environment", new S3StorageAdapter(config), prefix);
}

async function allowsOwnStorage(siteId: string): Promise<boolean> {
  try {
    return (await checkQuota("feature.ownStorage", siteId, { delta: 0 })).ok;
  } catch {
    return true;
  }
}

/** Every storage a site's files may be in, the one new files go to first. */
async function candidates(siteId: string): Promise<PrivateBackend[]> {
  const out: PrivateBackend[] = [];
  const rootId = await installationRootSiteId().catch(() => null);
  const onRoot = !rootId || rootId === siteId;
  const own = await readSiteSetting(siteId).catch(() => ({ current: null, previous: [] }) as StoredSetting);
  if (!onRoot && own.current && (await allowsOwnStorage(siteId))) {
    const backend = s3Backend(own.current, "site");
    if (backend) out.push(backend);
  }
  const platform = onRoot ? own : rootId ? await readRootSetting(rootId).catch(() => ({ current: null, previous: [] }) as StoredSetting) : null;
  if (platform?.current) {
    const backend = s3Backend(platform.current, "platform");
    if (backend) out.push(backend);
  }
  const env = (() => {
    try {
      return environmentBackend();
    } catch {
      return null;
    }
  })();
  if (env) out.push(env);
  out.push(localPrivateBackend(privateLocalRoot()));
  // Older connections, to read files not copied yet. On the root site its own are the platform's.
  for (const item of own.previous) {
    const backend = s3Backend(item, onRoot ? "platform" : "site");
    if (backend) out.push(backend);
  }
  if (!onRoot) {
    for (const item of platform?.previous ?? []) {
      const backend = s3Backend(item, "platform");
      if (backend) out.push(backend);
    }
  }
  if (!onRoot && own.current && !(await allowsOwnStorage(siteId))) {
    const backend = s3Backend(own.current, "site");
    if (backend) out.push(backend);
  }
  return out;
}

/** Where a site stores new private files. */
export async function activePrivateBackend(siteId: string): Promise<PrivateBackend> {
  return (await candidates(siteId))[0]!;
}

/** The storage with this id among the site's current and earlier ones. */
export async function privateBackendById(siteId: string, id: string): Promise<PrivateBackend | null> {
  return (await candidates(siteId)).find((backend) => backend.id === id) ?? null;
}

/** Which storage the site uses now, for the admin. */
export async function describeActivePrivateStorage(siteId: string): Promise<{ source: PrivateStorageSource; publicEnvironmentBucket: boolean }> {
  const active = await activePrivateBackend(siteId);
  let publicEnvironmentBucket = false;
  try {
    publicEnvironmentBucket = uploadDriver() === "s3" && Boolean(s3UploadConfig().publicUrl);
  } catch {
    publicEnvironmentBucket = false;
  }
  return { source: active.source, publicEnvironmentBucket };
}

// ---------------------------------------------------------------- files

export function objectKey(siteId: string, owner: string, key: string): string {
  if (!OWNER_RE.test(owner)) throw new PrivateStorageError("Invalid file owner.");
  if (!key || key.length > MAX_KEY || key.endsWith("/") || !isSafeUploadKey(key)) throw new PrivateStorageError("Invalid file key.");
  return `${siteId}/${owner}/${key}`;
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "");
  return text.includes("T") ? text : text ? `${text.replace(" ", "T")}Z` : "";
}

type FileRow = { id: string; size_bytes: number | string; content_type: string; sha256: string; storage_id: string; created_at: unknown; updated_at: unknown };

async function findRow(siteId: string, owner: string, key: string): Promise<FileRow | null> {
  const db = await getDb();
  const rows = await db.query<FileRow>(
    "SELECT id, size_bytes, content_type, sha256, storage_id, created_at, updated_at FROM private_files WHERE site_id = ? AND owner = ? AND file_key = ? LIMIT 1",
    [siteId, owner, key],
  );
  return rows[0] ?? null;
}

function info(key: string, row: FileRow): PrivateFileInfo {
  return {
    key,
    size: Number(row.size_bytes) || 0,
    contentType: row.content_type,
    sha256: row.sha256,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Store a file, within the site's private-file limits. Replacing a file counts only the growth. */
export async function putPrivateFile(siteId: string, owner: string, key: string, data: Buffer, contentType: string): Promise<PrivateFileInfo> {
  const { withSiteStorageLock } = await import("../storage/storage-quota.js");
  return withSiteStorageLock(siteId, () => putPrivateFileLocked(siteId, owner, key, data, contentType));
}

async function putPrivateFileLocked(
  siteId: string,
  owner: string,
  key: string,
  data: Buffer,
  contentType: string,
): Promise<PrivateFileInfo> {
  const object = objectKey(siteId, owner, key);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType.slice(0, 255) : "application/octet-stream";
  const existing = await findRow(siteId, owner, key);
  if (!existing) {
    const block = await enforceQuota("files.count", siteId, 1);
    if (block) throw new QuotaRefusalError(block);
  }
  const growth = Math.max(0, data.length - (Number(existing?.size_bytes) || 0));
  const bytesBlock = growth > 0 ? await enforceQuota("files.bytes", siteId, growth) : null;
  if (bytesBlock) throw new QuotaRefusalError(bytesBlock);
  const backend = await activePrivateBackend(siteId);
  const { enforceStorageGrowth } = await import("../storage/storage-quota.js");
  await enforceStorageGrowth(siteId, existing?.storage_id === backend.id ? growth : data.length);
  await backend.put(object, data, type);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const db = await getDb();
  const now = stamp();
  if (existing) {
    if (existing.storage_id !== backend.id) {
      // The copy left on the earlier storage is no longer needed.
      const old = await privateBackendById(siteId, existing.storage_id);
      await old?.delete(object).catch(() => undefined);
    }
    await db.run(
      "UPDATE private_files SET size_bytes = ?, content_type = ?, sha256 = ?, storage_id = ?, updated_at = ? WHERE id = ?",
      [data.length, type, sha256, backend.id, now, existing.id],
    );
  } else {
    await db.run(
      `INSERT INTO private_files (id, site_id, owner, file_key, size_bytes, content_type, sha256, storage_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), siteId, owner, key, data.length, type, sha256, backend.id, now, now],
    );
  }
  return (await getPrivateFile(siteId, owner, key))!;
}

export async function getPrivateFile(siteId: string, owner: string, key: string): Promise<PrivateFileInfo | null> {
  objectKey(siteId, owner, key);
  const row = await findRow(siteId, owner, key);
  return row ? info(key, row) : null;
}

/** The file's bytes, from whichever storage holds it now. */
export async function readPrivateFile(siteId: string, owner: string, key: string): Promise<Buffer | null> {
  const object = objectKey(siteId, owner, key);
  const row = await findRow(siteId, owner, key);
  if (!row) return null;
  const backend = await privateBackendById(siteId, row.storage_id);
  return backend ? backend.read(object) : null;
}

/** Open the file for streaming to a client, with an optional `Range` header. */
export async function openPrivateFile(
  siteId: string,
  owner: string,
  key: string,
  range?: string,
): Promise<(PrivateObjectStream & { contentType: string }) | null> {
  const object = objectKey(siteId, owner, key);
  const row = await findRow(siteId, owner, key);
  if (!row) return null;
  const backend = await privateBackendById(siteId, row.storage_id);
  if (!backend) return null;
  const opened = await backend.open(object, range);
  return opened ? { ...opened, contentType: row.content_type } : null;
}

export async function deletePrivateFile(siteId: string, owner: string, key: string): Promise<boolean> {
  const object = objectKey(siteId, owner, key);
  const row = await findRow(siteId, owner, key);
  if (!row) return false;
  const backend = await privateBackendById(siteId, row.storage_id);
  await backend?.delete(object);
  const db = await getDb();
  await db.run("DELETE FROM private_files WHERE id = ?", [row.id]);
  return true;
}

/** Files of one owner under a key prefix (`downloads/` or `""` for all), up to 500. */
export async function listPrivateFiles(siteId: string, owner: string, prefix = ""): Promise<PrivateFileInfo[]> {
  if (!OWNER_RE.test(owner)) throw new PrivateStorageError("Invalid file owner.");
  const db = await getDb();
  const rows = await db.query<FileRow & { file_key: string }>(
    "SELECT id, file_key, size_bytes, content_type, sha256, storage_id, created_at, updated_at FROM private_files WHERE site_id = ? AND owner = ? ORDER BY file_key LIMIT 500",
    [siteId, owner],
  );
  return rows.filter((row) => row.file_key.startsWith(prefix)).map((row) => info(row.file_key, row));
}

/**
 * Copy files stored elsewhere to the site's current storage, up to `limit`
 * per run. The originals stay where they were; a replaced connection is
 * forgotten once nothing is stored on it.
 */
export async function copyPrivateFiles(siteId: string, limit = 50): Promise<{ copied: number; failed: number; left: number }> {
  return (await import("../storage/storage-quota.js")).withSiteStorageLock(siteId, () => copyPrivateFilesLocked(siteId, limit));
}

async function copyPrivateFilesLocked(siteId: string, limit: number): Promise<{ copied: number; failed: number; left: number }> {
  const target = await activePrivateBackend(siteId);
  const db = await getDb();
  const rows = await db.query<{ id: string; owner: string; file_key: string; content_type: string; storage_id: string }>(
    `SELECT id, owner, file_key, content_type, storage_id FROM private_files WHERE site_id = ? AND storage_id <> ? LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))}`,
    [siteId, target.id],
  );
  let copied = 0;
  let failed = 0;
  for (const row of rows) {
    const object = `${siteId}/${row.owner}/${row.file_key}`;
    try {
      const source = await privateBackendById(siteId, row.storage_id);
      const data = source ? await source.read(object) : null;
      if (!data) {
        failed += 1;
        continue;
      }
      await (await import("../storage/storage-quota.js")).enforceStorageGrowth(siteId, data.length);
      await target.put(object, data, row.content_type);
      await db.run("UPDATE private_files SET storage_id = ? WHERE id = ? AND storage_id = ?", [target.id, row.id, row.storage_id]);
      copied += 1;
    } catch (err) {
      failed += 1;
      console.error("[private-files] copy failed", siteId, row.id, err instanceof Error ? err.message : "unknown error");
    }
  }
  const remaining = await db.query<{ total: number | string }>(
    "SELECT COUNT(*) AS total FROM private_files WHERE site_id = ? AND storage_id <> ?",
    [siteId, target.id],
  );
  const left = Number(remaining[0]?.total ?? 0) || 0;
  const rootId = await installationRootSiteId().catch(() => null);
  // The root site's earlier connections are shared; the copy job forgets them once no site uses them.
  if (rootId && rootId !== siteId) {
    await forgetUnusedConnections(siteId, await storageIdsInUse(siteId)).catch(() => undefined);
  }
  return { copied, failed, left };
}

/** Storage ids this site's files are on. */
export async function storageIdsInUse(siteId: string): Promise<Set<string>> {
  const db = await getDb();
  const used = await db.query<{ storage_id: string }>("SELECT DISTINCT storage_id FROM private_files WHERE site_id = ?", [siteId]);
  return new Set(used.map((item) => item.storage_id));
}

/** Physical private storage, including earlier connections awaiting migration cleanup. */
export async function privateStorageUsage(siteId: string): Promise<{ local: { bytes: number; files: number } | null; external: { bytes: number; files: number } | null }> {
  const { sumStorageAmounts } = await import("../storage/storage-usage.js");
  // Reporting must not silently fall back when configured connections cannot be read.
  const own = await readSiteSetting(siteId);
  const rootId = await installationRootSiteId();
  const platform = rootId && rootId !== siteId ? await readRootSetting(rootId) : null;
  for (const setting of [own, platform]) {
    for (const connection of [setting?.current, ...(setting?.previous ?? [])]) {
      if (connection && !s3Backend(connection, "site")) throw new Error("Private storage connection could not be read");
    }
  }
  const stores = [...new Map((await candidates(siteId)).map((backend) => [backend.inventoryKey ?? backend.id, backend])).values()];
  const local: Array<{ bytes: number; files: number } | null> = []; const external: Array<{ bytes: number; files: number } | null> = [];
  for (const backend of stores) {
    let usage = null;
    try { usage = await backend.measure?.(siteId) ?? null; } catch { /* Unknown stays unknown. */ }
    (backend.source === "local" ? local : external).push(usage);
  }
  return { local: sumStorageAmounts(local), external: sumStorageAmounts(external) };
}
