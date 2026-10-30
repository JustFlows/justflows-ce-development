// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCoreIntegrity, writeCoreManifest } from "./core-integrity.js";

/**
 * Check or write the core file manifest.
 *
 *   node apps/server/dist/lib/security/core-integrity-cli.js
 *   node apps/server/dist/lib/security/core-integrity-cli.js write-local
 *   node apps/server/dist/lib/security/core-integrity-cli.js write-official
 *
 * write-official reads the private key from JUSTFLOWS_CORE_RELEASE_KEY_FILE
 * or JUSTFLOWS_CORE_RELEASE_KEY. Pass --root to write into a release tree.
 * A missing manifest is unverified and exits 0. A mismatch exits 1.
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function loadPrivateKey(): string {
  const file = process.env.JUSTFLOWS_CORE_RELEASE_KEY_FILE;
  if (file) return fs.readFileSync(file, "utf8");
  const pem = process.env.JUSTFLOWS_CORE_RELEASE_KEY;
  if (!pem) {
    console.error("core-integrity: set JUSTFLOWS_CORE_RELEASE_KEY_FILE or JUSTFLOWS_CORE_RELEASE_KEY");
    process.exit(1);
  }
  return pem;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  await runCli();
}

async function runCli(): Promise<void> {
  const command = process.argv[2] ?? "verify";
  const root = flag("--root");
  if (command === "write-local") {
    const written = await writeCoreManifest({ kind: "local", ...(root ? { root } : {}) });
    console.log(`wrote ${written.count} files`);
    return;
  }
  if (command === "write-official") {
    const written = await writeCoreManifest({
      kind: "official",
      privateKeyPem: loadPrivateKey(),
      ...(root ? { root } : {}),
    });
    console.log(`wrote ${written.count} files`);
    return;
  }
  if (command === "verify") {
    const report = await verifyCoreIntegrity();
    console.log(JSON.stringify(report));
    if (report.status === "failed") process.exit(1);
    return;
  }
  console.error("core-integrity: verify | write-local | write-official");
  process.exit(1);
}
