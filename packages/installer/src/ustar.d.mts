export class UstarError extends Error {
  constructor(message: string);
}

export interface UstarLimits {
  maxExpandedBytes: number;
  maxFileCount: number;
  maxDecompressionRatio: number;
  maxParseMs: number;
}

export interface UstarEntry {
  path: string;
  kind: "file" | "dir";
  data: Buffer;
}

export function parseUstar(tar: Buffer, limits?: UstarLimits, startedAt?: number): UstarEntry[];

export function extractTarGz(archive: Buffer, dest: string, limits?: UstarLimits): Promise<void>;

/**
 * Open a path without following a final link. `native: false` forces the
 * lstat-and-compare path used where O_NOFOLLOW is missing (Windows).
 */
export function openNoFollow(
  target: string,
  flags: number,
  options?: { directory?: boolean; native?: boolean },
): Promise<import("node:fs/promises").FileHandle>;
