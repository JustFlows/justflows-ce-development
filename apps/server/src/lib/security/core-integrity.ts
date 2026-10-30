// SPDX-License-Identifier: MIT

import { createHash, createPrivateKey, createPublicKey, sign, verify as verifySignature } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CORE_RELEASE_PUBLIC_KEYS } from "../extensions/package-trust.js";
import { getJfRoot } from "../runtime/jf-root.js";
import { resolvePathUnderBase } from "./safe-path.js";
import {
  CORE_DIGEST_LIMITS,
  IntegrityBoundsError,
  hashRelativeFile,
  sameDigest,
  walkTree,
  type IntegrityFile,
} from "./file-digest.js";

/**
 * Signed manifest of immutable core files.
 *
 * Uploads, storage, secrets, and installed extension directories are not part
 * of the manifest. A checkout with no manifest is unverified, not a failed
 * release. A local baseline is not an official signature.
 */

const FORMAT = 1;
const MANIFEST_NAME = "core-integrity.json";
const MUTABLE_PREFIXES = [
  "storage/",
  "uploads/",
  "packages-installed/",
  "node_modules/",
  ".git/",
  ".updates/",
  "logs/",
  "cache/",
  "tmp/",
  "install-token/",
];

export type CoreIntegrityStatus = "verified" | "local" | "absent" | "failed";

export interface CoreIntegrityReport {
  status: CoreIntegrityStatus;
  version: string;
  checked: number;
  mismatched: string[];
}

interface CoreManifest {
  format: number;
  kind: "official" | "local";
  version: string;
  files: IntegrityFile[];
  signature?: string;
}

function isMutable(relativePath: string): boolean {
  if (relativePath === ".env" || relativePath.startsWith(".env.")) return true;
  return MUTABLE_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

function filesDigest(files: IntegrityFile[]): string {
  const canonical = JSON.stringify(files.map((file) => ({
    path: file.path,
    size: file.size,
    sha256: file.sha256,
  })));
  return createHash("sha256").update(canonical).digest("hex");
}

/** Bytes a core file manifest signature covers. */
export function coreFilesSignPayload(version: string, digestHex: string): Buffer {
  return Buffer.from(`justflows-core-files\n${version}\n${digestHex.toLowerCase()}`, "utf8");
}

function verifyManifestSignature(
  version: string,
  digestHex: string,
  signatureB64: string,
  publicKeys: readonly string[],
): boolean {
  const payload = coreFilesSignPayload(version, digestHex);
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  if (signature.length === 0) return false;
  for (const pem of publicKeys) {
    try {
      if (verifySignature(null, payload, createPublicKey(pem), signature)) return true;
    } catch {
      /* try the next key */
    }
  }
  return false;
}

function parseManifest(raw: string): CoreManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.format !== FORMAT) return null;
  if (record.kind !== "official" && record.kind !== "local") return null;
  if (typeof record.version !== "string" || !record.version || record.version.length > 80) return null;
  if (!Array.isArray(record.files)) return null;
  const files: IntegrityFile[] = [];
  for (const file of record.files) {
    if (!file || typeof file !== "object") return null;
    const row = file as Record<string, unknown>;
    if (typeof row.path !== "string" || row.path.length > 500 || row.path.startsWith("/") || row.path.includes("\\")) {
      return null;
    }
    if (row.path.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
    if (typeof row.size !== "number" || !Number.isInteger(row.size) || row.size < 0) return null;
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) return null;
    files.push({ path: row.path, size: row.size, sha256: row.sha256 });
  }
  const signature = typeof record.signature === "string" ? record.signature : undefined;
  return { format: FORMAT, kind: record.kind, version: record.version, files, signature };
}

async function readManifest(root: string): Promise<CoreManifest | null> {
  const filePath = resolvePathUnderBase(root, MANIFEST_NAME);
  if (!filePath) return null;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "ENOENT") return null;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return null;
    return parseManifest(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

function skipHeavyDirectory(relativeDir: string): boolean {
  const name = relativeDir.split("/").pop() ?? relativeDir;
  return name === "node_modules"
    || name === ".git"
    || name === "storage"
    || name === "uploads"
    || name === "tests"
    || name === "__tests__"
    || name === "coverage";
}

async function addTree(files: IntegrityFile[], root: string, absolute: string, prefix: string): Promise<void> {
  try {
    await fsp.access(absolute);
  } catch {
    return;
  }
  const walked = await walkTree(absolute, CORE_DIGEST_LIMITS, skipHeavyDirectory);
  if (walked.unexpected.length || walked.changed.length || walked.unreadable.length) {
    throw new IntegrityBoundsError("Core tree contains a link or unreadable file");
  }
  for (const file of walked.files) {
    const relative = prefix ? `${prefix}/${file.path}` : file.path;
    if (isMutable(relative) || relative.endsWith(".tsbuildinfo")) continue;
    files.push({ path: relative, size: file.size, sha256: file.sha256 });
  }
}

async function addFile(files: IntegrityFile[], root: string, relativePath: string): Promise<void> {
  if (isMutable(relativePath)) return;
  const hashed = await hashRelativeFile(root, relativePath, CORE_DIGEST_LIMITS);
  if (hashed.kind === "missing") return;
  if (hashed.kind !== "file") throw new IntegrityBoundsError("Core file could not be hashed");
  files.push(hashed.file);
}

/**
 * Files an official or local baseline covers. Missing build output is skipped.
 *
 * Plugins, themes, and CSS providers are left out. A core update does not
 * replace those directories, so a manifest of them would fail on every site
 * that already has its own copies.
 */
export async function collectCoreFiles(root = getJfRoot()): Promise<IntegrityFile[]> {
  const files: IntegrityFile[] = [];
  await addFile(files, root, "server.js");
  await addFile(files, root, "package.json");
  await addFile(files, root, "apps/server/package.json");
  await addTree(files, root, path.join(root, "apps/server/dist"), "apps/server/dist");
  await addTree(files, root, path.join(root, "migrations"), "migrations");
  let packageNames: string[] = [];
  try {
    packageNames = await fsp.readdir(path.join(root, "packages"));
  } catch {
    packageNames = [];
  }
  for (const name of packageNames) {
    if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\")) continue;
    await addFile(files, root, `packages/${name}/package.json`);
    await addTree(files, root, path.join(root, "packages", name, "dist"), `packages/${name}/dist`);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

async function readVersion(root: string): Promise<string> {
  const hashed = await hashRelativeFile(root, "package.json", CORE_DIGEST_LIMITS);
  if (hashed.kind !== "file") return "unknown";
  const filePath = resolvePathUnderBase(root, "package.json");
  if (!filePath) return "unknown";
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length <= 80 ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Write core-integrity.json. kind official requires the release private key. */
export async function writeCoreManifest(options: {
  root?: string;
  kind: "local" | "official";
  privateKeyPem?: string;
  version?: string;
}): Promise<{ count: number; filePath: string }> {
  const root = options.root ?? getJfRoot();
  const files = await collectCoreFiles(root);
  const version = options.version ?? await readVersion(root);
  const manifest: CoreManifest = { format: FORMAT, kind: options.kind, version, files };
  if (options.kind === "official") {
    if (!options.privateKeyPem) throw new Error("Official core manifest needs a signing key");
    const signature = sign(null, coreFilesSignPayload(version, filesDigest(files)), createPrivateKey(options.privateKeyPem));
    manifest.signature = signature.toString("base64");
  }
  const filePath = resolvePathUnderBase(await fsp.realpath(root), MANIFEST_NAME);
  if (!filePath) throw new Error("Core manifest path is outside the installation");
  await fsp.writeFile(filePath, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  return { count: files.length, filePath };
}

/** Compare on-disk core files with core-integrity.json. */
export async function verifyCoreIntegrity(options?: {
  root?: string;
  publicKeys?: readonly string[];
}): Promise<CoreIntegrityReport> {
  const root = options?.root ?? getJfRoot();
  const publicKeys = options?.publicKeys ?? CORE_RELEASE_PUBLIC_KEYS;
  let manifest: CoreManifest | null;
  try {
    manifest = await readManifest(root);
  } catch {
    return { status: "failed", version: "", checked: 0, mismatched: [] };
  }
  if (!manifest) return { status: "absent", version: "", checked: 0, mismatched: [] };
  const mismatched: string[] = [];
  if (manifest.files.some((file) => isMutable(file.path))) {
    return { status: "failed", version: manifest.version, checked: 0, mismatched: ["manifest"] };
  }
  const digest = filesDigest(manifest.files);
  const signed = Boolean(manifest.signature);
  const signatureOk = manifest.signature
    ? verifyManifestSignature(manifest.version, digest, manifest.signature, publicKeys)
    : false;
  if ((signed || manifest.kind === "official") && !signatureOk) mismatched.push("signature");
  for (const file of manifest.files) {
    if (mismatched.length >= 50) break;
    let hashed;
    try {
      hashed = await hashRelativeFile(root, file.path, CORE_DIGEST_LIMITS);
    } catch (err) {
      if (err instanceof IntegrityBoundsError) {
        return { status: "failed", version: manifest.version, checked: manifest.files.length, mismatched: [file.path] };
      }
      throw err;
    }
    if (hashed.kind !== "file" || hashed.file.size !== file.size || !sameDigest(hashed.file.sha256, file.sha256)) {
      mismatched.push(file.path);
    }
  }
  if (mismatched.length) {
    return { status: "failed", version: manifest.version, checked: manifest.files.length, mismatched };
  }
  return {
    status: signatureOk ? "verified" : "local",
    version: manifest.version,
    checked: manifest.files.length,
    mismatched: [],
  };
}
