// SPDX-License-Identifier: MIT

import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Hash regular files without following links.
 *
 * Open the path first, then read that handle. A path that is a link, or that
 * resolves outside the tree, is reported and its bytes are not hashed.
 */

export interface IntegrityFile {
  path: string;
  size: number;
  sha256: string;
}

export interface DigestLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxMs: number;
}

export const PACKAGE_DIGEST_LIMITS: DigestLimits = {
  maxFiles: 5000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxMs: 10_000,
};

export const CORE_DIGEST_LIMITS: DigestLimits = {
  maxFiles: 20_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 400 * 1024 * 1024,
  maxMs: 30_000,
};

export class IntegrityBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityBoundsError";
  }
}

export interface WalkResult {
  files: IntegrityFile[];
  /** Links, special files, and paths that leave the tree. */
  unexpected: string[];
  /** Present at listing and gone, or changed, before the read finished. */
  changed: string[];
  /** Present, but not readable. */
  unreadable: string[];
}

interface WalkState extends WalkResult {
  total: number;
  deadline: number;
}

function requireNoFollow(): number {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
  if (
    typeof O_NOFOLLOW !== "number" ||
    typeof O_NONBLOCK !== "number" ||
    typeof O_DIRECTORY !== "number"
  ) {
    throw new IntegrityBoundsError("This platform cannot verify files without following links");
  }
  return O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
}

/** True when candidate is root or a path inside it. */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function posixRelative(root: string, full: string): string | null {
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const posix = relative.split(path.sep).join("/");
  if (posix.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return posix;
}

/** Equal SHA-256 hex digests. Different lengths are not equal. */
export function sameDigest(left: string, right: string): boolean {
  if (left.length !== right.length || left.length !== 64) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== 32 || b.length !== 32) return false;
  return timingSafeEqual(a, b);
}

function errno(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : undefined;
}

async function listDirectory(dir: string, rootReal: string): Promise<{ real: string; names: string[] } | null> {
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(dir, flags);
  } catch (err) {
    const code = errno(err);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENOTSUP") return null;
    throw err;
  }
  try {
    const real = await fsp.realpath(dir);
    if (!isPathInside(rootReal, real)) return null;
    const names = await fsp.readdir(real);
    return { real, names };
  } finally {
    await handle.close();
  }
}

type Hashed =
  | { kind: "file" }
  | { kind: "directory" }
  | { kind: "missing" }
  | { kind: "skip" };

async function hashOne(
  full: string,
  relative: string,
  rootReal: string,
  limits: DigestLimits,
  state: WalkState,
): Promise<Hashed> {
  if (Date.now() > state.deadline) throw new IntegrityBoundsError("Integrity scan timed out");
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(full, requireNoFollow());
  } catch (err) {
    const code = errno(err);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP" || code === "EISDIR") {
      if (code === "EISDIR") return { kind: "directory" };
      state.unexpected.push(relative);
      return { kind: "skip" };
    }
    if (code === "EACCES" || code === "EPERM" || code === "ENXIO" || code === "ENODEV") {
      state.unreadable.push(relative);
      return { kind: "skip" };
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) return { kind: "directory" };
    if (!stat.isFile()) {
      state.unexpected.push(relative);
      return { kind: "skip" };
    }
    const real = await fsp.realpath(full);
    if (!isPathInside(rootReal, real)) {
      state.unexpected.push(relative);
      return { kind: "skip" };
    }
    if (stat.size > limits.maxFileBytes) throw new IntegrityBoundsError("Integrity scan file is too large");
    if (state.files.length >= limits.maxFiles) throw new IntegrityBoundsError("Integrity scan has too many files");
    if (state.total + stat.size > limits.maxTotalBytes) {
      throw new IntegrityBoundsError("Integrity scan is too large");
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length !== stat.size || after.size !== stat.size || after.ino !== stat.ino) {
      state.changed.push(relative);
      return { kind: "skip" };
    }
    state.total += data.length;
    state.files.push({
      path: relative,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    return { kind: "file" };
  } finally {
    await handle.close();
  }
}

async function walkFrom(
  dir: string,
  relativeDir: string,
  rootReal: string,
  limits: DigestLimits,
  state: WalkState,
  skipDirectory: ((relativeDir: string) => boolean) | undefined,
  depth: number,
): Promise<void> {
  if (depth > 24) throw new IntegrityBoundsError("Integrity scan is too deep");
  if (skipDirectory?.(relativeDir)) return;
  const listed = await listDirectory(dir, rootReal);
  if (!listed) {
    if (relativeDir) state.unexpected.push(relativeDir);
    return;
  }
  for (const name of listed.names) {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
      continue;
    }
    const relative = relativeDir ? `${relativeDir}/${name}` : name;
    const full = path.join(listed.real, name);
    const hashed = await hashOne(full, relative, rootReal, limits, state);
    if (hashed.kind === "missing") {
      state.changed.push(relative);
      continue;
    }
    if (hashed.kind === "directory") {
      await walkFrom(full, relative, rootReal, limits, state, skipDirectory, depth + 1);
    }
  }
}

/**
 * Hash every regular file under root.
 *
 * root itself must be a real directory. Links are not followed. skipDirectory
 * receives the relative directory path ("" for a child decision at the top).
 */
export async function walkTree(
  root: string,
  limits: DigestLimits,
  skipDirectory?: (relativeDir: string) => boolean,
): Promise<WalkResult> {
  requireNoFollow();
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(root, flags);
  } catch (err) {
    const code = errno(err);
    if (code === "ELOOP") throw new IntegrityBoundsError("Package root is a link");
    throw err;
  }
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(root);
  } finally {
    await handle.close();
  }
  const state: WalkState = {
    files: [],
    unexpected: [],
    changed: [],
    unreadable: [],
    total: 0,
    deadline: Date.now() + limits.maxMs,
  };
  await walkFrom(rootReal, "", rootReal, limits, state, skipDirectory, 0);
  state.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: state.files,
    unexpected: state.unexpected,
    changed: state.changed,
    unreadable: state.unreadable,
  };
}

/**
 * Hash one relative file inside root.
 * Missing, a link, or a path outside root comes back as that kind and is not read.
 */
export async function hashRelativeFile(
  root: string,
  relativePath: string,
  limits: DigestLimits,
): Promise<
  | { kind: "file"; file: IntegrityFile }
  | { kind: "missing" }
  | { kind: "unexpected" }
  | { kind: "changed" }
  | { kind: "unreadable" }
> {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) {
    return { kind: "unexpected" };
  }
  if (relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return { kind: "unexpected" };
  }
  requireNoFollow();
  let rootReal: string;
  try {
    const handle = await fsp.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      rootReal = await fsp.realpath(root);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (errno(err) === "ENOENT") return { kind: "missing" };
    if (errno(err) === "ELOOP") return { kind: "unexpected" };
    throw err;
  }
  const full = path.resolve(rootReal, ...relativePath.split("/"));
  if (!isPathInside(rootReal, full)) return { kind: "unexpected" };
  const relative = posixRelative(rootReal, full);
  if (!relative) return { kind: "unexpected" };
  const state: WalkState = {
    files: [],
    unexpected: [],
    changed: [],
    unreadable: [],
    total: 0,
    deadline: Date.now() + limits.maxMs,
  };
  const hashed = await hashOne(full, relative, rootReal, limits, state);
  if (hashed.kind === "missing") return { kind: "missing" };
  if (hashed.kind === "directory") return { kind: "unexpected" };
  if (state.files[0]) return { kind: "file", file: state.files[0] };
  if (state.changed.length) return { kind: "changed" };
  if (state.unreadable.length) return { kind: "unreadable" };
  if (state.unexpected.length) return { kind: "unexpected" };
  return { kind: "missing" };
}
