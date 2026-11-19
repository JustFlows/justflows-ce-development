// SPDX-License-Identifier: MIT

import fs from "node:fs";
import fsp from "node:fs/promises";

/**
 * Open a path without following a final link, on every platform.
 *
 * With O_NOFOLLOW the kernel refuses the link. Node.js has no O_NOFOLLOW or
 * O_DIRECTORY on Windows, so there the path is checked with lstat, then opened,
 * and the opened handle must be that same file (dev and ino), so a link or
 * junction swapped in between is refused. A link fails with ELOOP, and a
 * non-directory fails with ENOTDIR when `directory` is set.
 */

/** O_NOFOLLOW, or 0 where Node does not define it (Windows). */
const NATIVE_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

/** O_DIRECTORY, or 0 where Node does not define it (Windows). */
const NATIVE_DIRECTORY = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;

export interface OpenNoFollowOptions {
  /** Require a directory. */
  directory?: boolean;
  /** false forces the lstat-and-compare path; tests use it on POSIX. */
  native?: boolean;
}

function fsError(code: string, target: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: ${target}`);
  err.code = code;
  return err;
}

function useNative(options: OpenNoFollowOptions): boolean {
  return (options.native ?? true) && NATIVE_NOFOLLOW !== 0;
}

function nativeFlags(flags: number, directory: boolean): number {
  return flags | NATIVE_NOFOLLOW | (directory ? NATIVE_DIRECTORY : 0);
}

function checkBefore(before: fs.BigIntStats, target: string, directory: boolean): void {
  if (before.isSymbolicLink()) throw fsError("ELOOP", target);
  if (directory && !before.isDirectory()) throw fsError("ENOTDIR", target);
}

function checkAfter(before: fs.BigIntStats | null, after: fs.BigIntStats, target: string, directory: boolean): void {
  if (before && (after.dev !== before.dev || after.ino !== before.ino)) throw fsError("ELOOP", target);
  if (directory && !after.isDirectory()) throw fsError("ENOTDIR", target);
}

/** Async open that does not follow a final link. */
export async function openNoFollow(
  target: string,
  flags: number,
  options: OpenNoFollowOptions = {},
): Promise<fs.promises.FileHandle> {
  const directory = options.directory === true;
  let before: fs.BigIntStats | null = null;
  let handle: fs.promises.FileHandle;
  if (useNative(options)) {
    handle = await fsp.open(target, nativeFlags(flags, directory));
  } else {
    before = await fsp.lstat(target, { bigint: true });
    checkBefore(before, target, directory);
    handle = await fsp.open(target, flags);
  }
  try {
    checkAfter(before, await handle.stat({ bigint: true }), target, directory);
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/** Sync open that does not follow a final link. Returns a file descriptor. */
export function openNoFollowSync(target: string, flags: number, options: OpenNoFollowOptions = {}): number {
  const directory = options.directory === true;
  let before: fs.BigIntStats | null = null;
  let fd: number;
  if (useNative(options)) {
    fd = fs.openSync(target, nativeFlags(flags, directory));
  } else {
    before = fs.lstatSync(target, { bigint: true });
    checkBefore(before, target, directory);
    fd = fs.openSync(target, flags);
  }
  try {
    checkAfter(before, fs.fstatSync(fd, { bigint: true }), target, directory);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  return fd;
}
