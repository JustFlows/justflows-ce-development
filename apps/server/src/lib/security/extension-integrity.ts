// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PackageRejectedError } from "@justflows/installer";
import { packagesInstalledDir } from "../extensions/packages-dir.js";
import { getJfRoot } from "../runtime/jf-root.js";
import { resolvePathUnderBase } from "./safe-path.js";
import { openNoFollow } from "./open-no-follow.js";
import {
  IntegrityBoundsError,
  PACKAGE_DIGEST_LIMITS,
  sameDigest,
  walkTree,
  type IntegrityFile,
} from "./file-digest.js";
import { verifyCoreIntegrity, type CoreIntegrityStatus } from "./core-integrity.js";

/**
 * Per-file baseline for an installed plugin, theme, or CSS provider.
 *
 * The inventory lives under storage/integrity, outside the package directory,
 * and is written only after a trusted install. There is no action that adopts
 * the current files as a new baseline.
 */

const FORMAT = 1;
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,80}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const INVENTORY_NAME_RE = /^[a-f0-9]{64}\.json$/;

export type ExtensionPackageType = "plugin" | "theme" | "css-provider";
export type ExtensionIntegrityStatus =
  | "verified"
  | "modified"
  | "missing"
  | "unexpected"
  | "unverifiable"
  | "limit";

export interface ExtensionIntegrityReport {
  packageId: string;
  packageType: ExtensionPackageType | "unknown";
  version: string;
  status: ExtensionIntegrityStatus;
  modified: string[];
  missing: string[];
  unexpected: string[];
}

export interface IntegrityOverview {
  checkedAt: string;
  core: CoreIntegrityStatus;
  verified: number;
  unverifiable: number;
  failed: number;
  packages: ExtensionIntegrityReport[];
}

interface ExtensionInventory {
  format: number;
  packageId: string;
  packageType: ExtensionPackageType;
  version: string;
  archiveDigest: string;
  root: string;
  files: IntegrityFile[];
}

let cached: IntegrityOverview | null = null;

/** Drop the process cache. The next read scans again. */
export function invalidateIntegrityCache(): void {
  cached = null;
}

function integrityDir(): string {
  return path.join(getJfRoot(), "storage", "integrity", "extensions");
}

function allowedPackageRoots(): string[] {
  const root = getJfRoot();
  const fromEnv = (name: string, fallback: string) => {
    const rel = process.env[name] ?? fallback;
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
  };
  return [
    packagesInstalledDir(),
    fromEnv("PLUGINS_DIR", "plugins"),
    path.join(root, "themes"),
    fromEnv("CSS_PROVIDERS_DIR", "css-providers"),
    fromEnv("CSS_PROVIDERS_INSTALL_DIR", "css-providers-installed"),
  ];
}

function isAllowedPackageDir(packageDir: string): boolean {
  const resolved = path.resolve(packageDir);
  return allowedPackageRoots().some((base) => {
    const root = path.resolve(base);
    return resolved !== root && (resolved === root || resolved.startsWith(root + path.sep));
  });
}

function relativeInstallPath(packageDir: string): string | null {
  const root = path.resolve(getJfRoot());
  const resolved = path.resolve(packageDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  const relative = path.relative(root, resolved).split(path.sep).join("/");
  if (!relative || relative.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return relative;
}

function cap(paths: string[]): string[] {
  return paths.slice(0, 50);
}

function worstStatus(report: Pick<ExtensionIntegrityReport, "modified" | "missing" | "unexpected">, limit: boolean): ExtensionIntegrityStatus {
  if (limit) return "limit";
  if (report.modified.length) return "modified";
  if (report.missing.length) return "missing";
  if (report.unexpected.length) return "unexpected";
  return "verified";
}

function countsAsFailure(status: ExtensionIntegrityStatus): boolean {
  return status === "modified" || status === "missing" || status === "unexpected" || status === "limit";
}

function inventoryFileName(relativeRoot: string): string {
  return `${createHash("sha256").update(relativeRoot).digest("hex")}.json`;
}

function parseInventory(raw: string): ExtensionInventory | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.format !== FORMAT) return null;
  if (typeof record.packageId !== "string" || !PACKAGE_ID_RE.test(record.packageId)) return null;
  if (record.packageType !== "plugin" && record.packageType !== "theme" && record.packageType !== "css-provider") {
    return null;
  }
  if (typeof record.version !== "string" || !VERSION_RE.test(record.version)) return null;
  if (typeof record.archiveDigest !== "string" || !DIGEST_RE.test(record.archiveDigest)) return null;
  if (typeof record.root !== "string" || !isSafeRelative(record.root)) return null;
  if (!Array.isArray(record.files)) return null;
  const files: IntegrityFile[] = [];
  for (const file of record.files) {
    if (!file || typeof file !== "object") return null;
    const row = file as Record<string, unknown>;
    if (typeof row.path !== "string" || !isSafeRelative(row.path)) return null;
    if (typeof row.size !== "number" || !Number.isInteger(row.size) || row.size < 0) return null;
    if (typeof row.sha256 !== "string" || !DIGEST_RE.test(row.sha256)) return null;
    files.push({ path: row.path, size: row.size, sha256: row.sha256 });
  }
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) return null;
  const sorted = [...paths].sort();
  if (paths.some((item, index) => item !== sorted[index])) return null;
  return {
    format: FORMAT,
    packageId: record.packageId,
    packageType: record.packageType,
    version: record.version,
    archiveDigest: record.archiveDigest,
    root: record.root,
    files,
  };
}

function isSafeRelative(value: string): boolean {
  if (!value || value.length > 500 || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function readInventoryFile(filePath: string): Promise<ExtensionInventory | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await openNoFollow(filePath, fs.constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
    return parseInventory(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function readInventories(): Promise<Array<{ filePath: string; inventory: ExtensionInventory | null }>> {
  const dir = integrityDir();
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "ENOENT") return [];
    throw err;
  }
  const rows = [];
  for (const name of names) {
    if (!INVENTORY_NAME_RE.test(name)) continue;
    const filePath = resolvePathUnderBase(dir, name);
    if (!filePath) continue;
    rows.push({ filePath, inventory: await readInventoryFile(filePath) });
  }
  return rows;
}

function resolveInventoryRoot(relativeRoot: string): string | null {
  const abs = resolvePathUnderBase(getJfRoot(), ...relativeRoot.split("/"));
  if (!abs || !isAllowedPackageDir(abs)) return null;
  return abs;
}

async function directoryExists(packageDir: string): Promise<boolean> {
  try {
    const handle = await openNoFollow(packageDir, fs.constants.O_RDONLY, { directory: true });
    await handle.close();
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "ENOENT") return false;
    throw err;
  }
}

function compareInventory(inventory: ExtensionInventory, walked: Awaited<ReturnType<typeof walkTree>>): ExtensionIntegrityReport {
  const expected = new Map(inventory.files.map((file) => [file.path, file]));
  const actual = new Map(walked.files.map((file) => [file.path, file]));
  const modified: string[] = [];
  const missing: string[] = [];
  const unexpected = [...walked.unexpected, ...walked.changed, ...walked.unreadable];
  for (const [relative, file] of expected) {
    const found = actual.get(relative);
    if (!found) {
      missing.push(relative);
      continue;
    }
    if (found.size !== file.size || !sameDigest(found.sha256, file.sha256)) modified.push(relative);
  }
  for (const relative of actual.keys()) {
    if (!expected.has(relative)) unexpected.push(relative);
  }
  const limit = false;
  return {
    packageId: inventory.packageId,
    packageType: inventory.packageType,
    version: inventory.version,
    status: worstStatus({ modified, missing, unexpected }, limit),
    modified: cap(modified),
    missing: cap(missing),
    unexpected: cap(unexpected),
  };
}

async function discoverPackageDirs(): Promise<string[]> {
  const root = packagesInstalledDir();
  const found: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 8 || found.length > PACKAGE_DIGEST_LIMITS.maxFiles) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "justflows.json") {
        found.push(dir);
        continue;
      }
      if (entry.isDirectory()) await visit(full, depth + 1);
    }
  }
  await visit(root, 0);
  return found;
}

async function readPackageIdentity(packageDir: string): Promise<Pick<ExtensionIntegrityReport, "packageId" | "packageType" | "version">> {
  const manifestPath = resolvePathUnderBase(packageDir, "justflows.json");
  const empty = { packageId: "unknown", packageType: "unknown" as const, version: "" };
  if (!manifestPath) return empty;
  let handle: fs.promises.FileHandle;
  try {
    handle = await openNoFollow(manifestPath, fs.constants.O_RDONLY);
  } catch {
    return empty;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) return empty;
    const parsed = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
    const packageId = typeof parsed.id === "string" && PACKAGE_ID_RE.test(parsed.id) ? parsed.id : "unknown";
    const packageType = parsed.type === "plugin" || parsed.type === "theme" || parsed.type === "css-provider"
      ? parsed.type
      : "unknown";
    const version = typeof parsed.version === "string" && VERSION_RE.test(parsed.version) ? parsed.version : "";
    return { packageId, packageType, version };
  } catch {
    return empty;
  } finally {
    await handle.close();
  }
}

function limitReport(identity: Pick<ExtensionIntegrityReport, "packageId" | "packageType" | "version">): ExtensionIntegrityReport {
  return { ...identity, status: "limit", modified: [], missing: [], unexpected: [] };
}

/**
 * Write the baseline for a package that just finished a trusted install.
 * A link or a tree over the scan limits refuses the baseline.
 */
export async function recordInstalledPackageBaseline(input: {
  packageDir: string;
  packageId: string;
  packageType: ExtensionPackageType;
  version: string;
  archiveDigest: string;
}): Promise<void> {
  if (!PACKAGE_ID_RE.test(input.packageId) || !VERSION_RE.test(input.version) || !DIGEST_RE.test(input.archiveDigest)) {
    throw new PackageRejectedError("Installed package identity cannot be stored");
  }
  if (!isAllowedPackageDir(input.packageDir)) throw new PackageRejectedError("Installed package is outside its directory");
  const relativeRoot = relativeInstallPath(input.packageDir);
  if (!relativeRoot) throw new PackageRejectedError("Installed package is outside the installation");
  let walked;
  try {
    walked = await walkTree(input.packageDir, PACKAGE_DIGEST_LIMITS);
  } catch (err) {
    if (err instanceof IntegrityBoundsError) {
      throw new PackageRejectedError("Installed package is too large to record a baseline");
    }
    throw err;
  }
  if (walked.unexpected.length || walked.changed.length || walked.unreadable.length) {
    throw new PackageRejectedError("Installed package contains a link, special file, or unreadable file");
  }
  const inventory: ExtensionInventory = {
    format: FORMAT,
    packageId: input.packageId,
    packageType: input.packageType,
    version: input.version,
    archiveDigest: input.archiveDigest,
    root: relativeRoot,
    files: walked.files,
  };
  const dir = integrityDir();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const realDir = await fsp.realpath(dir);
  const dest = resolvePathUnderBase(realDir, inventoryFileName(relativeRoot));
  if (!dest) throw new PackageRejectedError("Integrity baseline path is outside storage");
  const temp = resolvePathUnderBase(realDir, `${inventoryFileName(relativeRoot)}.tmp`);
  if (!temp) throw new PackageRejectedError("Integrity baseline path is outside storage");
  await fsp.writeFile(temp, `${JSON.stringify(inventory)}\n`, { mode: 0o600 });
  await fsp.rename(temp, dest);
  invalidateIntegrityCache();
}

async function verifyDirectory(packageDir: string, inventory: ExtensionInventory | null): Promise<ExtensionIntegrityReport> {
  const identity = inventory
    ? { packageId: inventory.packageId, packageType: inventory.packageType, version: inventory.version }
    : await readPackageIdentity(packageDir);
  if (!inventory) {
    return { ...identity, status: "unverifiable", modified: [], missing: [], unexpected: [] };
  }
  try {
    const walked = await walkTree(packageDir, PACKAGE_DIGEST_LIMITS);
    return compareInventory(inventory, walked);
  } catch (err) {
    if (err instanceof IntegrityBoundsError) return limitReport(identity);
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "ENOENT") {
      return { ...identity, status: "missing", modified: [], missing: ["."], unexpected: [] };
    }
    throw err;
  }
}

/**
 * The recorded identity of an installed package: its id, type, version, and
 * the digest of the archive it was installed from. Null without a baseline.
 */
export async function readInstalledPackageIdentity(packageDir: string): Promise<{
  packageId: string;
  packageType: ExtensionPackageType;
  version: string;
  archiveDigest: string;
} | null> {
  if (!isAllowedPackageDir(packageDir)) return null;
  const relativeRoot = relativeInstallPath(packageDir);
  if (!relativeRoot) return null;
  const filePath = resolvePathUnderBase(integrityDir(), inventoryFileName(relativeRoot));
  const inventory = filePath ? await readInventoryFile(filePath) : null;
  if (!inventory || inventory.root !== relativeRoot) return null;
  return {
    packageId: inventory.packageId,
    packageType: inventory.packageType,
    version: inventory.version,
    archiveDigest: inventory.archiveDigest,
  };
}

/** Compare one installed directory with its baseline. No baseline is unverifiable. */
export async function verifyInstalledDirectory(packageDir: string): Promise<ExtensionIntegrityReport | null> {
  if (!isAllowedPackageDir(packageDir)) return null;
  const relativeRoot = relativeInstallPath(packageDir);
  if (!relativeRoot) return null;
  const dir = integrityDir();
  const filePath = resolvePathUnderBase(dir, inventoryFileName(relativeRoot));
  const inventory = filePath ? await readInventoryFile(filePath) : null;
  if (inventory && inventory.root !== relativeRoot) {
    return limitReport(await readPackageIdentity(packageDir));
  }
  return verifyDirectory(packageDir, inventory);
}

/**
 * True when this package may be imported and activated.
 * A missing baseline is allowed. A mismatch, an unreadable baseline, or a scan limit is not.
 */
export async function extensionAllowsLoad(packageDir: string): Promise<boolean> {
  const report = await verifyInstalledDirectory(packageDir);
  if (!report) return false;
  return report.status === "verified" || report.status === "unverifiable";
}

/** Scan installed packages and the core manifest. Uses the process cache unless forced. */
let scanInFlight: Promise<IntegrityOverview> | null = null;

/**
 * The cached overview, or a fresh scan.
 *
 * Callers that arrive during a scan share it. Hashing every installed tree is
 * the expensive part, so concurrent requests in this process cost one run.
 */
export async function loadIntegrityOverview(force = false): Promise<IntegrityOverview> {
  if (!force && cached) return cached;
  scanInFlight ??= scanIntegrity().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

async function scanIntegrity(): Promise<IntegrityOverview> {
  const packages: ExtensionIntegrityReport[] = [];
  const seen = new Set<string>();
  for (const row of await readInventories()) {
    if (!row.inventory) {
      packages.push(limitReport({ packageId: "unknown", packageType: "unknown", version: "" }));
      continue;
    }
    const packageDir = resolveInventoryRoot(row.inventory.root);
    if (!packageDir) {
      packages.push(limitReport(row.inventory));
      continue;
    }
    let present = false;
    try {
      present = await directoryExists(packageDir);
    } catch {
      packages.push(limitReport(row.inventory));
      continue;
    }
    if (!present) {
      await fsp.rm(row.filePath, { force: true }).catch(() => undefined);
      continue;
    }
    packages.push(await verifyDirectory(packageDir, row.inventory));
    seen.add(path.resolve(packageDir));
  }
  for (const packageDir of await discoverPackageDirs()) {
    const resolved = path.resolve(packageDir);
    if (seen.has(resolved)) continue;
    if (!isAllowedPackageDir(packageDir)) continue;
    packages.push(await verifyDirectory(packageDir, null));
  }
  let core: CoreIntegrityStatus = "absent";
  try {
    core = (await verifyCoreIntegrity()).status;
  } catch (err) {
    if (err instanceof IntegrityBoundsError) core = "failed";
    else throw err;
  }
  const overview: IntegrityOverview = {
    checkedAt: new Date().toISOString(),
    core,
    verified: packages.filter((item) => item.status === "verified").length,
    unverifiable: packages.filter((item) => item.status === "unverifiable").length,
    failed: packages.filter((item) => countsAsFailure(item.status)).length,
    packages,
  };
  cached = overview;
  return overview;
}
