import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * `justflows submit [folder]` (justflows-ce#275): send plugin or theme source
 * to the Justflows Marketplace for review, from any Git host or none.
 *
 * - In a Git checkout, the source is `git archive` of HEAD and the commit SHA
 *   is sent with it. Uncommitted changes are refused, so the recorded commit
 *   always matches the code.
 * - Outside Git, the folder is packed without `node_modules` and `.git`.
 *
 * Needs `JUSTFLOWS_PUBLISHER_TOKEN`, a publisher token with the "submit"
 * scope from the partners site. The submission then waits until you confirm
 * it on the partners site with your passkey or authenticator app.
 */

const DEFAULT_REGISTRY = "https://api.justflows.com";

interface Options {
  folder: string;
  registry: string;
  dryRun: boolean;
}

function parse(args: string[]): Options {
  let folder = ".";
  let registry = process.env["JUSTFLOWS_REGISTRY_URL"]?.trim() || DEFAULT_REGISTRY;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--registry") registry = args[++i] ?? registry;
    else if (arg === "--dry-run") dryRun = true;
    else if (!arg.startsWith("--")) folder = arg;
  }
  return { folder: path.resolve(folder), registry: trimTrailingSlashes(registry), dryRun };
}

/** Removes trailing slashes without a regular expression, so long input cannot slow it down. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function git(folder: string, args: string[], encoding: "utf8" | "buffer" = "utf8"): string | Buffer | null {
  try {
    return execFileSync("git", ["-C", folder, ...args], {
      encoding: encoding === "utf8" ? "utf8" : undefined,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 100 * 1024 * 1024,
    }) as string | Buffer;
  } catch {
    return null;
  }
}

/** The source archive and, from Git, the exact commit it came from. */
export function packSource(folder: string, id: string): { archive: Buffer; commit?: string } {
  const top = git(folder, ["rev-parse", "--show-toplevel"]);
  if (typeof top === "string" && path.resolve(top.trim()) === folder) {
    const dirty = git(folder, ["status", "--porcelain"]);
    if (typeof dirty === "string" && dirty.trim()) {
      throw new Error("This folder has uncommitted changes. Commit them first, so the submission matches a commit.");
    }
    const commit = String(git(folder, ["rev-parse", "HEAD"]) ?? "").trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Could not read the current commit.");
    const archive = git(folder, ["archive", "--format=tar.gz", `--prefix=${id}-${commit.slice(0, 7)}/`, "HEAD"], "buffer");
    if (!Buffer.isBuffer(archive)) throw new Error("git archive failed.");
    return { archive, commit };
  }
  const archive = execFileSync("tar", ["-czf", "-", "--exclude=./node_modules", "--exclude=./.git", "-C", folder, "."], {
    maxBuffer: 100 * 1024 * 1024,
  });
  return { archive };
}

export async function submitCommand(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log("Usage: justflows submit [folder] [--registry <url>] [--dry-run]\nNeeds JUSTFLOWS_PUBLISHER_TOKEN (a publisher token with the submit scope).");
    return;
  }
  const options = parse(args);
  const manifestPath = path.join(options.folder, "justflows.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`No justflows.json in ${options.folder}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id?: string; version?: string };
  if (!manifest.id || !manifest.version) throw new Error("justflows.json needs id and version");

  const { archive, commit } = packSource(options.folder, manifest.id);
  console.log(`${manifest.id}@${manifest.version}: ${(archive.length / 1024).toFixed(0)} KB${commit ? `, commit ${commit}` : " (not a Git checkout)"}`);
  if (options.dryRun) {
    console.log("Dry run: nothing was sent.");
    return;
  }

  const token = process.env["JUSTFLOWS_PUBLISHER_TOKEN"]?.trim();
  if (!token) throw new Error("Set JUSTFLOWS_PUBLISHER_TOKEN to a publisher token with the submit scope (create one on the partners site).");

  const form = new FormData();
  if (commit) form.append("commit", commit);
  form.append("source", new Blob([new Uint8Array(archive)], { type: "application/gzip" }), "source.tar.gz");
  const response = await fetch(`${options.registry}/v1/publisher/submissions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; id?: string; state?: string };
  if (!response.ok) throw new Error(`Submission refused (HTTP ${response.status}): ${data.error ?? "unknown error"}`);
  console.log(`✓ Submitted. Confirm it on the partners site (Publisher account → Submissions) with your passkey or authenticator app.`);
  if (data.id) console.log(`  Submission ${data.id}`);
}
