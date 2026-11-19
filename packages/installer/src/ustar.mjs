// SPDX-License-Identifier: MIT

import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Strict ustar reader for .jfpkg archives.
 *
 * Numeric fields are octal only. Links, special files, and any other type are
 * rejected. The whole archive is parsed before the first write, and each write
 * stays under the real destination directory.
 */

export class UstarError extends Error {
  constructor(message) {
    super(message);
    this.name = "UstarError";
  }
}

const DEFAULT_LIMITS = {
  maxExpandedBytes: 200 * 1024 * 1024,
  maxFileCount: 2_000,
  maxDecompressionRatio: 20,
  maxParseMs: 10_000,
};

function deadline(startedAt, limits) {
  if (Date.now() - startedAt > limits.maxParseMs) {
    throw new UstarError("Archive processing timed out");
  }
}

/**
 * @param {Buffer} field
 * @param {string} label
 * @param {boolean} allowBlank
 */
function parseOctal(field, label, allowBlank) {
  if ((field[0] ?? 0) & 0x80) {
    throw new UstarError(`${label} uses an unsupported numeric encoding`);
  }
  let end = field.length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 32)) end -= 1;
  let start = 0;
  while (start < end && field[start] === 32) start += 1;
  if (start === end) {
    if (allowBlank) return 0;
    throw new UstarError(`${label} is missing`);
  }
  let value = 0;
  for (let i = start; i < end; i += 1) {
    const byte = field[i] ?? 0;
    if (byte < 48 || byte > 55) throw new UstarError(`${label} is not octal`);
    value = value * 8 + (byte - 48);
    if (!Number.isSafeInteger(value)) throw new UstarError(`${label} overflows`);
  }
  return value;
}

function readCString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
}

function headerChecksum(header) {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) {
    sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  }
  return sum;
}

function entryPath(header) {
  const name = readCString(header, 0, 100);
  const prefix = readCString(header, 345, 155);
  const raw = prefix ? `${prefix}/${name}` : name;
  if (!raw || raw.includes("\\") || raw.includes("\0")) {
    throw new UstarError("Archive entry path is not allowed");
  }
  const cleaned = raw.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned || path.posix.isAbsolute(cleaned)) {
    throw new UstarError("Absolute path rejected");
  }
  const parts = cleaned.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new UstarError("Path traversal rejected");
  }
  return { path: parts.join("/"), directory: raw.endsWith("/") };
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

/**
 * Parse a ustar buffer. Throws before returning when any entry is unsafe.
 * @param {Buffer} tarBuf
 * @param {typeof DEFAULT_LIMITS} limits
 * @param {number} startedAt
 */
export function parseUstar(tarBuf, limits = DEFAULT_LIMITS, startedAt = Date.now()) {
  if (tarBuf.length % 512 !== 0) throw new UstarError("Truncated archive");
  /** @type {{ path: string, kind: "file" | "dir", data: Buffer }[]} */
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let expandedBytes = 0;
  let zeroBlocks = 0;

  while (offset + 512 <= tarBuf.length) {
    deadline(startedAt, limits);
    const header = tarBuf.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) {
        while (offset + 512 <= tarBuf.length) {
          if (!isZeroBlock(tarBuf.subarray(offset, offset + 512))) throw new UstarError("Truncated archive");
          offset += 512;
        }
        break;
      }
      continue;
    }
    if (zeroBlocks > 0) throw new UstarError("Truncated archive");

    const magic = header.subarray(257, 262).toString("utf8");
    if (magic !== "ustar") throw new UstarError("Unsupported archive format");
    const stored = parseOctal(header.subarray(148, 156), "checksum", false);
    if (stored !== headerChecksum(header)) throw new UstarError("Archive checksum mismatch");
    parseOctal(header.subarray(100, 108), "mode", true);
    parseOctal(header.subarray(108, 116), "uid", true);
    parseOctal(header.subarray(116, 124), "gid", true);
    const size = parseOctal(header.subarray(124, 136), "size", false);
    parseOctal(header.subarray(136, 148), "mtime", true);

    const type = header[156] ?? 0;
    const named = entryPath(header);
    const isDir = type === 53 || named.directory;
    const isFile = type === 48 || type === 0;
    if (!isDir && !isFile) throw new UstarError("Unsupported archive entry");
    if (isDir && size !== 0) throw new UstarError("Unsupported archive entry");

    const blocks = Math.ceil(size / 512) * 512;
    const next = offset + 512 + blocks;
    if (!Number.isSafeInteger(next) || next <= offset || next > tarBuf.length) {
      throw new UstarError("Truncated archive");
    }
    const data = tarBuf.subarray(offset + 512, offset + 512 + size);
    if (data.length !== size) throw new UstarError("Truncated archive");
    offset = next;

    if (seen.has(named.path)) throw new UstarError("Conflicting archive entry");
    seen.add(named.path);
    expandedBytes += size;
    if (entries.length + 1 > limits.maxFileCount) throw new UstarError("Archive exceeds the file limit");
    if (expandedBytes > limits.maxExpandedBytes) throw new UstarError("Archive expanded size limit exceeded");
    entries.push({ path: named.path, kind: isDir ? "dir" : "file", data: isDir ? Buffer.alloc(0) : Buffer.from(data) });
  }

  if (offset !== tarBuf.length) throw new UstarError("Truncated archive");
  if (zeroBlocks < 1 && entries.length > 0) throw new UstarError("Truncated archive");
  return entries;
}

function occupied(err) {
  const code = err && typeof err === "object" ? err.code : "";
  return code === "EEXIST" || code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR";
}

/** O_NOFOLLOW, or 0 where Node does not define it (Windows). */
const NATIVE_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

/** O_DIRECTORY, or 0 where Node does not define it (Windows). */
const NATIVE_DIRECTORY = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;

function fsError(code, target) {
  const err = new Error(`${code}: ${target}`);
  err.code = code;
  return err;
}

/**
 * Open a path without following a final link.
 *
 * With O_NOFOLLOW the kernel refuses the link. Without it (Windows) the path is
 * opened read-only first and then checked with lstat: it must not be a link,
 * and it must still be the file the handle has open. A link or junction, at
 * open time or swapped in afterwards, is refused. Checking before opening would
 * leave a window between check and use (CodeQL js/file-system-race). A link
 * fails with ELOOP, and a non-directory fails with ENOTDIR when `directory` is set.
 *
 * @param {string} target
 * @param {number} flags
 * @param {{ directory?: boolean, native?: boolean }} [options]
 */
export async function openNoFollow(target, flags, options = {}) {
  const native = options.native ?? NATIVE_NOFOLLOW !== 0;
  const wantDirectory = options.directory === true;
  const kernel = native && NATIVE_NOFOLLOW !== 0;
  const mutating =
    fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  /** The fallback opens before it checks, so it only allows read-only opens. */
  if (!kernel && (flags & mutating) !== 0) throw fsError("EINVAL", target);
  const handle = await fsp.open(
    target,
    kernel ? flags | NATIVE_NOFOLLOW | (wantDirectory ? NATIVE_DIRECTORY : 0) : flags,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!kernel) {
      const named = await fsp.lstat(target, { bigint: true });
      if (named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) {
        throw fsError("ELOOP", target);
      }
    }
    if (wantDirectory && !opened.isDirectory()) throw fsError("ENOTDIR", target);
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/**
 * Create each file with an exclusive open. A stat before the open would let
 * the path change in between, which is the race CodeQL reports. O_EXCL refuses
 * any existing name, a link included, on every platform. Where the platform
 * has no O_NOFOLLOW, the created file is also checked to be the one opened.
 */
async function writeEntries(dest, entries) {
  await fsp.mkdir(dest, { recursive: true });
  const root = await fsp.realpath(dest);
  const fileFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NATIVE_NOFOLLOW;
  const dirFlags = fs.constants.O_RDONLY;
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let parent = root;
    for (let i = 0; i < parts.length; i += 1) {
      const last = i === parts.length - 1;
      const realParent = await fsp.realpath(parent);
      if (realParent !== root && !realParent.startsWith(root + path.sep)) {
        throw new UstarError("Path traversal rejected");
      }
      const next = path.join(realParent, parts[i]);
      if (last && entry.kind === "file") {
        let handle;
        try {
          handle = await fsp.open(next, fileFlags);
        } catch (err) {
          if (occupied(err)) throw new UstarError("Conflicting archive entry");
          throw err;
        }
        try {
          if (NATIVE_NOFOLLOW === 0) {
            const created = await fsp.lstat(next, { bigint: true });
            const opened = await handle.stat({ bigint: true });
            if (created.isSymbolicLink() || created.dev !== opened.dev || created.ino !== opened.ino) {
              throw new UstarError("Conflicting archive entry");
            }
          }
          await handle.writeFile(entry.data);
        } finally {
          await handle.close();
        }
      } else {
        let created = false;
        try {
          await fsp.mkdir(next);
          created = true;
        } catch (err) {
          if (!occupied(err)) throw err;
        }
        if (!created) {
          let handle;
          try {
            handle = await openNoFollow(next, dirFlags, { directory: true });
          } catch (err) {
            if (occupied(err) || (err && err.code === "ENOENT")) {
              throw new UstarError("Conflicting archive entry");
            }
            throw err;
          }
          await handle.close();
        }
        parent = next;
      }
    }
  }
}

/**
 * Inflate a .jfpkg and extract it under `dest`. Parsing finishes before any
 * entry is written. `dest` must already exist.
 * @param {Buffer} archive
 * @param {string} dest
 * @param {typeof DEFAULT_LIMITS} [limits]
 */
export async function extractTarGz(archive, dest, limits = DEFAULT_LIMITS) {
  const startedAt = Date.now();
  if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
    throw new UstarError("Not a gzip archive");
  }
  const gunzip = createGunzip();
  const chunks = [];
  let total = 0;
  const source = Readable.from(archive).pipe(gunzip);
  const tarBuf = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      source.destroy();
      reject(err);
    };
    source.on("data", (chunk) => {
      try {
        deadline(startedAt, limits);
      } catch (err) {
        fail(err);
        return;
      }
      total += chunk.byteLength;
      if (total > limits.maxExpandedBytes) {
        fail(new UstarError("Archive expanded size limit exceeded"));
        return;
      }
      chunks.push(chunk);
    });
    source.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    source.on("error", () => fail(new UstarError("Invalid gzip archive")));
  });
  if (tarBuf.byteLength / Math.max(archive.byteLength, 1) > limits.maxDecompressionRatio) {
    throw new UstarError("Decompression ratio limit exceeded");
  }
  const entries = parseUstar(tarBuf, limits, startedAt);
  await writeEntries(dest, entries);
}
