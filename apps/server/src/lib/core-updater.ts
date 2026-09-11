import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getJfRoot } from "./jf-root.js";
import { requestPassengerRestart } from "./app-restart.js";
import { verifyUpdateArchiveSignature } from "./package-trust.js";
import { extractZipSafely, resolvePathUnderRoot } from "./safe-zip.js";
import {
  acquireLock,
  appendUpdateLog,
  clearLock,
  clearUpdateJob,
  initUpdateStatus,
  patchUpdateStatus,
  readUpdateStatus,
  stagingDir as updatesStagingDir,
  writeUpdateJob,
  type UpdateJob,
  type UpdatePhase,
  type UpdateStatus,
  type UpdateStep,
} from "./core-update-status.js";

export type { UpdateStep } from "./core-update-status.js";

const MAX_ZIP_BYTES = 200 * 1024 * 1024; // 200 MB

/** Paths never overwritten during a core update. */
const PRESERVE_TOP_LEVEL = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "uploads",
  "packages-installed",
  ".updates",
  "node_modules",
]);

/** Raised when a second update is requested while one is already running. */
export class UpdateInProgressError extends Error {
  code = "UPDATE_IN_PROGRESS" as const;
  constructor() {
    super("A core update is already running");
    this.name = "UpdateInProgressError";
  }
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 15 * 60 * 1000,
): { ok: boolean; output: string } {
  const result = spawnSync(/* turbopackIgnore: true */ cmd, args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" },
  });

  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join("\n")
    .trim();
  return { ok: result.status === 0 && !result.error, output };
}

/**
 * Install dependencies with the package manager the release was built with.
 * This repo is a pnpm workspace; running `npm install` at the root resolves the
 * whole monorepo against `package-lock.json` and, on a memory-limited Plesk
 * host, is a prime candidate for an OOM kill mid-update. Prefer pnpm, fall back
 * to npm only when pnpm is genuinely not on PATH.
 */
function runDependencyInstall(root: string): { ok: boolean; output: string; tool: string } {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
    const pnpm = runCommand(
      "pnpm",
      ["install", "--frozen-lockfile", "--prod=false", "--ignore-scripts"],
      root,
    );
    if (pnpm.ok) return { ok: true, output: "Dependencies installed with pnpm", tool: "pnpm" };
    if (!/ENOENT|not found|not recognized/i.test(pnpm.output)) {
      return { ok: false, output: pnpm.output, tool: "pnpm" };
    }
    // pnpm not available — fall through to npm.
  }
  const npm = runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  return {
    ok: npm.ok,
    output: npm.ok ? "Dependencies installed with npm" : npm.output,
    tool: "npm",
  };
}

async function walkFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full, base)));
    } else {
      files.push(path.relative(base, full));
    }
  }
  return files;
}

/** Run migrations from the just-copied dist, not this process's bundled modules. */
function runCopiedMigrations(root: string): { ok: boolean; output: string } {
  const entry = path.join(root, "apps/server/dist/lib/apply-pending-migrations-cli.js");
  if (!fs.existsSync(entry)) {
    return { ok: false, output: "Missing apps/server/dist/lib/apply-pending-migrations-cli.js" };
  }
  return runCommand("node", [entry], root, 5 * 60 * 1000);
}

function shouldPreserve(relativePath: string): boolean {
  const top = relativePath.split(path.sep)[0] ?? relativePath;
  if (PRESERVE_TOP_LEVEL.has(top)) return true;
  if (relativePath.startsWith(".updates" + path.sep)) return true;
  return false;
}

async function copyUpdateFiles(sourceRoot: string, destRoot: string): Promise<number> {
  const files = await walkFiles(sourceRoot);
  let copied = 0;

  for (const rel of files) {
    if (shouldPreserve(rel)) continue;

    const dest = resolvePathUnderRoot(destRoot, rel);
    if (!dest) continue;

    const src = path.join(sourceRoot, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    copied++;
  }

  return copied;
}

function findExtractedRoot(extractDir: string): string {
  // Flat layout: files at archive root (current justflows.zip format).
  if (fs.existsSync(path.join(extractDir, "server.js"))) {
    return extractDir;
  }

  // Legacy layout: top-level folder (e.g. justflows/server.js).
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
    const candidate = path.join(extractDir, entry.name);
    if (fs.existsSync(path.join(candidate, "server.js"))) {
      return candidate;
    }
  }

  throw new Error("Invalid Justflows zip — expected server.js at archive root");
}

function validateUpdatePackage(
  sourceRoot: string,
): { ok: true; version: string } | { ok: false; detail: string } {
  const serverJs = path.join(sourceRoot, "server.js");
  const pkgPath = path.join(sourceRoot, "package.json");

  if (!fs.existsSync(serverJs)) {
    return { ok: false, detail: "Invalid update package — missing server.js" };
  }
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, detail: "Invalid update package — missing package.json" };
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      name?: string;
      version?: string;
    };
    if (pkg.name && pkg.name !== "justflows") {
      return { ok: false, detail: `Invalid update package — unexpected name "${pkg.name}"` };
    }
    return { ok: true, version: pkg.version ?? "unknown" };
  } catch {
    return { ok: false, detail: "Invalid update package — unreadable package.json" };
  }
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function emitCoreUpdated(
  siteId: string | null | undefined,
  source: string,
  fromVersion: string,
  toVersion: string,
): Promise<void> {
  if (!siteId) return;
  try {
    const { getRuntimeHooks } = await import("./plugin-runtime.js");
    await getRuntimeHooks().dispatchAction(
      "core.updated",
      { fromVersion, toVersion, source },
      { siteId, source: "system" },
    );
  } catch (err) {
    console.error("[justflows] core.updated hook failed:", String(err).replace(/\n/g, " "));
  }
}

interface UpdateResult {
  ok: boolean;
  steps: UpdateStep[];
  currentVersion: string;
  newVersion: string;
  restartRequired: boolean;
  restarting: boolean;
}

const STEP_PHASE: Record<string, UpdatePhase> = {
  upload: "verifying",
  validate: "validating",
  signature: "verifying",
  extract: "extracting",
  copy: "copying",
  migrate: "migrating",
  "npm install": "installing",
  build: "building",
  restart: "restarting",
  complete: "done",
};

interface ApplyOptions {
  signature?: string;
  /** Caller already holds the update lock and initialised status (worker path). */
  assumeLocked?: boolean;
  /** Archive is already unpacked here — skip staging + extraction. */
  preExtractedDir?: string;
  siteId?: string | null;
  source?: "upload" | "remote" | "auto";
}

/**
 * Copy a verified core archive into place, migrate, install dependencies,
 * (re)build if needed, and ask Passenger to restart. Every step is mirrored to
 * `.updates/status.json` so the admin UI can follow along and recover after a
 * page reload or a dropped connection.
 */
export async function applyCoreUpdate(
  uploadBuffer: Buffer,
  filename: string,
  options?: ApplyOptions,
): Promise<UpdateResult> {
  const steps: UpdateStep[] = [];
  const log: string[] = [];
  const root = getJfRoot();
  const currentVersion = readVersion(root);
  const source = options?.source ?? "upload";
  const ownsLock = !options?.assumeLocked;

  function record(step: UpdateStep): void {
    steps.push(step);
    const icon = step.ok ? "✓" : "✗";
    log.push(`${icon} ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
    patchUpdateStatus({
      phase: STEP_PHASE[step.step] ?? "copying",
      steps: [...steps],
      log: [...log],
    });
  }

  function finish(result: UpdateResult, error?: string): UpdateResult {
    patchUpdateStatus({
      running: false,
      phase: result.ok ? "done" : "failed",
      ok: result.ok,
      newVersion: result.newVersion,
      restartRequired: result.restartRequired,
      restarting: result.restarting,
      finishedAt: Date.now(),
      error: error ?? null,
      steps: [...steps],
      log: [...log],
    });
    return result;
  }

  const fail = (error: string): UpdateResult =>
    finish(
      {
        ok: false,
        steps,
        currentVersion,
        newVersion: currentVersion,
        restartRequired: false,
        restarting: false,
      },
      error,
    );

  if (ownsLock) {
    if (!acquireLock(source)) throw new UpdateInProgressError();
    initUpdateStatus({ source, currentVersion, targetVersion: null });
  }
  patchUpdateStatus({ pid: process.pid, running: true, currentVersion });

  if (!filename.endsWith(".zip")) {
    const r = fail("Only .zip files are accepted");
    if (ownsLock) clearLock();
    return r;
  }
  if (uploadBuffer.byteLength > MAX_ZIP_BYTES) {
    const r = fail("File too large (max 200 MB)");
    if (ownsLock) clearLock();
    return r;
  }

  const staging = updatesStagingDir();
  const extractDir = options?.preExtractedDir ?? path.join(staging, "extract");
  const zipPath = path.join(staging, "upload.zip");

  try {
    if (!options?.preExtractedDir) {
      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(staging, { recursive: true });
      await fsp.writeFile(zipPath, uploadBuffer);
    }

    const digest = createHash("sha256").update(uploadBuffer).digest("hex");
    record({
      step: "upload",
      ok: true,
      detail: `${(uploadBuffer.byteLength / 1024 / 1024).toFixed(1)} MB (sha256: ${digest.slice(0, 12)}…)`,
    });

    const expectedDigest = process.env.JUSTFLOWS_UPDATE_DIGEST?.trim().toLowerCase();
    if (expectedDigest && digest !== expectedDigest) {
      record({
        step: "validate",
        ok: false,
        detail: "Update digest does not match JUSTFLOWS_UPDATE_DIGEST",
      });
      return finish({
        ok: false,
        steps,
        currentVersion,
        newVersion: currentVersion,
        restartRequired: false,
        restarting: false,
      });
    }

    verifyUpdateArchiveSignature(uploadBuffer, options?.signature);
    if (process.env.JUSTFLOWS_UPDATE_SIGNING_KEY) {
      record({ step: "signature", ok: true, detail: "Update signature verified" });
    }

    if (!options?.preExtractedDir) {
      extractZipSafely(zipPath, extractDir);
    }
    record({ step: "extract", ok: true, detail: "Archive extracted" });

    const sourceRoot = findExtractedRoot(extractDir);
    const validated = validateUpdatePackage(sourceRoot);
    if (!validated.ok) {
      record({ step: "validate", ok: false, detail: validated.detail });
      return finish({
        ok: false,
        steps,
        currentVersion,
        newVersion: currentVersion,
        restartRequired: false,
        restarting: false,
      });
    }
    const newVersion = validated.version;
    patchUpdateStatus({ targetVersion: newVersion });
    record({ step: "validate", ok: true, detail: `Package verified (v${newVersion})` });

    const copied = await copyUpdateFiles(sourceRoot, root);
    record({
      step: "copy",
      ok: true,
      detail: `Updated ${copied} files (.env and uploads preserved)`,
    });

    const migrate = runCopiedMigrations(root);
    record({
      step: "migrate",
      ok: migrate.ok,
      detail: migrate.ok
        ? "Database schema updated"
        : migrate.output.slice(-500) || "Migration failed — will retry after restart",
    });

    // The manifests an update package ships are npm-only hosting copies —
    // `prepare-hosting.js` rewrites workspace:* specs to file: paths and
    // strips devDependencies before the archive is built. A pnpm-lock.yaml
    // describing the pre-hosting monorepo no longer matches them, so
    // `pnpm install --frozen-lockfile` fails deterministically wherever pnpm
    // happens to be on PATH. Update packages never ship one, but an earlier
    // release cycle can have left one on disk (copying files never deletes
    // ones the new package doesn't include) — drop it so install always falls
    // through to the npm + package-lock.json this package actually ships.
    await fsp.rm(path.join(root, "pnpm-lock.yaml"), { force: true });

    const install = runDependencyInstall(root);
    record({
      step: "npm install",
      ok: install.ok,
      detail: install.ok
        ? install.output
        : install.output.slice(-500) || "Dependency install failed",
    });
    if (!install.ok) {
      return finish({
        ok: false,
        steps,
        currentVersion,
        newVersion,
        restartRequired: false,
        restarting: false,
      });
    }

    const hasBuiltServer =
      fs.existsSync(path.join(root, "apps/server/dist/server.js")) &&
      fs.existsSync(path.join(root, "apps/server/admin-ui/dist/client/index.html")) &&
      fs.existsSync(path.join(root, "apps/server/admin-ui/dist/server/entry-server.js"));

    if (hasBuiltServer) {
      record({ step: "build", ok: true, detail: "Using pre-built artifacts from update package" });
    } else {
      const build = runCommand("node", ["scripts/install-all.js", "--build-only"], root);
      record({
        step: "build",
        ok: build.ok,
        detail: build.ok ? "Server rebuilt" : build.output.slice(-500) || "build:server failed",
      });
      if (!build.ok) {
        return finish({
          ok: false,
          steps,
          currentVersion,
          newVersion,
          restartRequired: false,
          restarting: false,
        });
      }
    }

    const restart = await requestPassengerRestart(root);
    record({
      step: "restart",
      ok: restart.ok,
      detail: restart.ok
        ? "Site will reload on the next request"
        : (restart.error ?? "Could not trigger restart"),
    });

    const ok = migrate.ok && restart.ok;
    record({
      step: "complete",
      ok,
      detail: ok
        ? `Updated from v${currentVersion} to v${newVersion}`
        : "Update copied; the site will finish remaining work after reload",
    });

    if (ok) await emitCoreUpdated(options?.siteId, source, currentVersion, newVersion);

    return finish({
      ok,
      steps,
      currentVersion,
      newVersion,
      restartRequired: !restart.ok,
      restarting: restart.ok,
    });
  } catch (err) {
    record({ step: "error", ok: false, detail: err instanceof Error ? err.message : String(err) });
    return finish(
      {
        ok: false,
        steps,
        currentVersion,
        newVersion: currentVersion,
        restartRequired: false,
        restarting: false,
      },
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    clearUpdateJob();
    clearLock();
  }
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Read a response body, aborting once it exceeds `maxBytes`. */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Download exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** `<hex>  justflows.zip` — take the first 64-hex token. */
function parseSha256Sidecar(text: string): string | null {
  const match = /\b([a-fA-F0-9]{64})\b/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** Download a published release through the gateway and verify its checksum. */
async function downloadRelease(release: {
  availableVersion: string;
  downloadUrl: string;
  sha256Url: string | null;
}): Promise<Buffer> {
  const res = await fetch(release.downloadUrl, {
    headers: { accept: "application/zip" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = await readBounded(res, MAX_ZIP_BYTES);

  if (release.sha256Url) {
    const shaRes = await fetch(release.sha256Url, {
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!shaRes.ok) throw new Error(`Could not fetch checksum (${shaRes.status})`);
    const expected = parseSha256Sidecar(await shaRes.text());
    if (!expected) throw new Error("Release checksum file is unreadable");
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch — expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      );
    }
  }
  return buffer;
}

/**
 * Download + verify + install the latest published release, running the same
 * pipeline as an operator upload. Used by the unattended auto-update job (the
 * admin "Update" button goes through {@link startCoreUpdate} instead).
 */
export async function applyCoreUpdateFromRelease(
  release: { availableVersion: string; downloadUrl: string; sha256Url: string | null },
  options?: { siteId?: string | null; source?: "auto" | "remote" },
): Promise<UpdateResult> {
  const currentVersion = readVersion(getJfRoot());
  let buffer: Buffer;
  try {
    buffer = await downloadRelease(release);
  } catch (err) {
    return {
      ok: false,
      steps: [
        { step: "download", ok: false, detail: err instanceof Error ? err.message : String(err) },
      ],
      currentVersion,
      newVersion: currentVersion,
      restartRequired: false,
      restarting: false,
    };
  }

  return applyCoreUpdate(buffer, "justflows.zip", {
    siteId: options?.siteId ?? null,
    source: options?.source ?? "auto",
  });
}

// --- background job orchestration ----------------------------------------

/** Location of the detached worker on disk, if this build shipped it. */
function installedWorkerPath(root: string): string {
  return path.join(root, "apps/server/dist/lib/core-update-worker.js");
}

/**
 * Stage an update and hand it to a detached worker process, returning
 * immediately. The heavy work (copy, migrate, install, build, restart) then runs
 * outside any HTTP request; the caller and the admin UI follow it through
 * `.updates/status.json`.
 *
 * Falls back to running the pipeline in the foreground only when this build does
 * not yet ship the worker and one cannot be bootstrapped from the archive — i.e.
 * the single transitional upgrade to a build that has this code.
 */
export async function startCoreUpdate(opts: {
  source: "upload" | "remote";
  siteId: string | null;
  filename?: string;
  buffer?: Buffer;
  signature?: string;
  release?: { availableVersion: string; downloadUrl: string; sha256Url: string | null };
}): Promise<{ mode: "background" | "foreground"; status: UpdateStatus; result?: UpdateResult }> {
  if (readUpdateStatus().running) throw new UpdateInProgressError();

  const root = getJfRoot();
  const currentVersion = readVersion(root);
  const staging = updatesStagingDir();

  if (opts.source === "upload") {
    const name = opts.filename ?? "";
    if (!name.endsWith(".zip")) throw new Error("Only .zip files are accepted");
    if (!opts.buffer) throw new Error("No file provided");
    if (opts.buffer.byteLength > MAX_ZIP_BYTES) throw new Error("File too large (max 200 MB)");
  }
  if (opts.source === "remote" && !opts.release) throw new Error("No release to install");

  // Take the slot before touching any shared state so a racing request 409s
  // instead of clobbering a run that is already in flight.
  if (!acquireLock(opts.source)) throw new UpdateInProgressError();

  try {
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });

    let zipPath: string | null = null;
    if (opts.source === "upload" && opts.buffer) {
      zipPath = path.join(staging, "upload.zip");
      await fsp.writeFile(zipPath, opts.buffer);
    }

    // Prefer the worker this build installed; otherwise try to unpack one from
    // the archive we were just handed so even the first upgrade to a build that
    // ships the worker still runs in the background.
    let workerPath: string | null = fs.existsSync(installedWorkerPath(root))
      ? installedWorkerPath(root)
      : null;
    let preExtractedDir: string | null = null;

    if (!workerPath && zipPath) {
      try {
        const extractDir = path.join(staging, "extract");
        extractZipSafely(zipPath, extractDir);
        const srcRoot = findExtractedRoot(extractDir);
        const shipped = path.join(srcRoot, "apps/server/dist/lib/core-update-worker.js");
        if (fs.existsSync(shipped)) {
          workerPath = shipped;
          preExtractedDir = extractDir;
        }
      } catch {
        /* fall back to foreground */
      }
    }

    initUpdateStatus({
      source: opts.source,
      currentVersion,
      targetVersion: opts.release?.availableVersion ?? null,
    });

    const job: UpdateJob = {
      source: opts.source,
      siteId: opts.siteId,
      createdAt: Date.now(),
      currentVersion,
      targetVersion: opts.release?.availableVersion ?? null,
      zipPath,
      signature: opts.signature ?? null,
      release: opts.release ?? null,
      preExtractedDir,
    };
    writeUpdateJob(job);

    if (workerPath) {
      const child = spawn(process.execPath, [workerPath], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production", JF_ROOT: root },
      });
      child.unref();
      appendUpdateLog("↻ Update started in the background — you can leave this page");
      return { mode: "background", status: readUpdateStatus() };
    }

    appendUpdateLog(
      "⚠ Running in compatibility mode (foreground) — the next update will run in the background",
    );
    // `executeUpdateJob` -> `applyCoreUpdate` releases the lock in its `finally`.
    const result = await executeUpdateJob(job);
    return { mode: "foreground", status: readUpdateStatus(), result };
  } catch (err) {
    // We never handed the job to a worker — clear the slot so the operator can
    // retry immediately.
    clearLock();
    clearUpdateJob();
    patchUpdateStatus({
      running: false,
      phase: "failed",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
    });
    throw err;
  }
}

/**
 * Run a staged {@link UpdateJob} to completion. Shared by the detached worker
 * and the foreground compatibility path in {@link startCoreUpdate}.
 */
export async function executeUpdateJob(job: UpdateJob): Promise<UpdateResult> {
  const root = getJfRoot();
  patchUpdateStatus({ pid: process.pid, running: true });

  try {
    let buffer: Buffer;
    if (job.source === "remote" && job.release) {
      patchUpdateStatus({ phase: "downloading" });
      appendUpdateLog(`↻ Downloading Justflows v${job.release.availableVersion}…`);
      buffer = await downloadRelease(job.release);
      appendUpdateLog("✓ download: archive verified");
    } else if (job.zipPath) {
      buffer = await fsp.readFile(job.zipPath);
    } else {
      throw new Error("Update job has no archive");
    }

    return await applyCoreUpdate(buffer, "justflows.zip", {
      signature: job.signature ?? undefined,
      assumeLocked: true,
      preExtractedDir: job.preExtractedDir ?? undefined,
      siteId: job.siteId,
      source: job.source,
    });
  } catch (err) {
    // A throw here is before `applyCoreUpdate` (download / staged-zip read) or
    // an unexpected fault; `applyCoreUpdate`'s own `finally` handles the rest.
    const message = err instanceof Error ? err.message : String(err);
    patchUpdateStatus({
      running: false,
      phase: "failed",
      ok: false,
      error: message,
      finishedAt: Date.now(),
    });
    appendUpdateLog(`✗ ${message}`);
    clearUpdateJob();
    clearLock();
    return {
      ok: false,
      steps: [{ step: "error", ok: false, detail: message }],
      currentVersion: readVersion(root),
      newVersion: readVersion(root),
      restartRequired: false,
      restarting: false,
    };
  }
}
