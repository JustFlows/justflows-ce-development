// SPDX-License-Identifier: MIT

import fs from "node:fs";
import fsp from "node:fs/promises";

/**
 * Open a path without following a final link, on every platform.
 *
 * With O_NOFOLLOW the kernel refuses the link. Node.js has no O_NOFOLLOW or
 * O_DIRECTORY on Windows, so there the path is opened read-only first and then
 * checked with lstat: the path must not be a link, and it must still be the
 * file the handle has open (dev and ino). A link or junction, at open time or
 * swapped in afterwards, is refused, and nothing is read before the check.
 * Checking before opening would leave a window between check and use
 * (CodeQL js/file-system-race). A link fails with ELOOP, and a non-directory
 * fails with ENOTDIR when `directory` is set.
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

/** Flags that change the file on open. The fallback opens before it checks, so it allows none. */
const MUTATING_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;

function assertReadOnly(flags: number, target: string): void {
  if ((flags & MUTATING_FLAGS) !== 0) throw fsError("EINVAL", target);
}

/** `opened` is the handle's own stat; `named` is an lstat of the path taken after the open. */
function checkOpened(
  opened: fs.BigIntStats,
  named: fs.BigIntStats | null,
  target: string,
  directory: boolean,
): void {
  if (named && (named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino)) {
    throw fsError("ELOOP", target);
  }
  if (directory && !opened.isDirectory()) throw fsError("ENOTDIR", target);
}

/** Async open that does not follow a final link. */
export async function openNoFollow(
  target: string,
  flags: number,
  options: OpenNoFollowOptions = {},
): Promise<fs.promises.FileHandle> {
  const directory = options.directory === true;
  const native = useNative(options);
  if (!native) assertReadOnly(flags, target);
  const handle = await fsp.open(target, native ? nativeFlags(flags, directory) : flags);
  try {
    const opened = await handle.stat({ bigint: true });
    const named = native ? null : await fsp.lstat(target, { bigint: true });
    checkOpened(opened, named, target, directory);
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/** Sync open that does not follow a final link. Returns a file descriptor. */
export function openNoFollowSync(target: string, flags: number, options: OpenNoFollowOptions = {}): number {
  const directory = options.directory === true;
  const native = useNative(options);
  if (!native) assertReadOnly(flags, target);
  const fd = fs.openSync(target, native ? nativeFlags(flags, directory) : flags);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = native ? null : fs.lstatSync(target, { bigint: true });
    checkOpened(opened, named, target, directory);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  return fd;
}
