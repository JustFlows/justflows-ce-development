// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathUnderBase } from "../security/safe-path.js";
import { isSafeRelativeFile } from "./paths.js";
import { ON_DEMAND_DIR } from "./on-demand-files.js";

export interface OutputFile {
  /** POSIX-style path relative to the output directory. */
  rel: string;
  body: Buffer;
}

export interface WriteReport {
  written: string[];
  pruned: string[];
  skipped: string[];
}

async function walkFiles(dir: string, base: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(abs, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs).split(path.sep).join("/"));
    }
  }
}

async function removeEmptyDirs(dir: string, base: string): Promise<void> {
  if (dir === base) return;
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) {
      await fs.rmdir(dir);
      await removeEmptyDirs(path.dirname(dir), base);
    }
  } catch {
    // directory vanished or not empty — nothing to do
  }
}

/**
 * Write the export to `outDir`. Every path is constrained under `outDir` with
 * {@link resolvePathUnderBase}. When `prune` is set, existing files not present
 * in `keep` are deleted (this is how unpublish / delete / slug-change remove
 * their pages), and emptied directories are cleaned up.
 */
export async function writeExport(
  outDir: string,
  files: OutputFile[],
  keep: Set<string>,
  prune: boolean,
): Promise<WriteReport> {
  const report: WriteReport = { written: [], pruned: [], skipped: [] };
  await fs.mkdir(outDir, { recursive: true });
  // Resolve symlinks up front (e.g. macOS /var → /private/var) so the
  // under-base check works for files that do not exist yet.
  const base = await fs.realpath(outDir);

  if (prune) {
    const existing: string[] = [];
    await walkFiles(base, base, existing);
    const dirsTouched = new Set<string>();
    for (const rel of existing) {
      /** Files built on demand are tracked in the database, not in the manifest. */
      if (keep.has(rel) || rel.startsWith(`${ON_DEMAND_DIR}/`)) continue;
      const abs = resolvePathUnderBase(base, rel);
      if (!abs) continue;
      await fs.rm(abs, { force: true });
      report.pruned.push(rel);
      dirsTouched.add(path.dirname(abs));
    }
    for (const dir of dirsTouched) await removeEmptyDirs(dir, base);
  }

  for (const file of files) {
    if (!isSafeRelativeFile(file.rel)) {
      report.skipped.push(file.rel);
      continue;
    }
    const abs = resolvePathUnderBase(base, file.rel);
    if (!abs) {
      report.skipped.push(file.rel);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.body);
    report.written.push(file.rel);
  }

  return report;
}

/** Minimal HTML that bounces a browser from an origin-redirected path to its target. */
export function redirectStubHtml(target: string): Buffer {
  const safe = target.replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="refresh" content="0; url=${safe}">` +
      `<link rel="canonical" href="${safe}"><title>Redirecting…</title>` +
      `</head><body><p>Redirecting to <a href="${safe}">${safe}</a></p></body></html>\n`,
    "utf8",
  );
}
