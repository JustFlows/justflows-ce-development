#!/usr/bin/env node
// SPDX-License-Identifier: MIT

// Verify immutable core files, or write a baseline.
//
//   node scripts/verify-core-integrity.mjs
//   node scripts/verify-core-integrity.mjs write-local
//   node scripts/verify-core-integrity.mjs write-official
//
// write-official reads JUSTFLOWS_CORE_RELEASE_KEY_FILE or JUSTFLOWS_CORE_RELEASE_KEY.
// scripts/make-zip.sh runs it before packing, so a signed release contains
// core-integrity.json. The signature covers
// "justflows-core-files\n<version>\n<sha256 of the file list>" — see
// coreFilesSignPayload in apps/server/src/lib/security/core-integrity.ts.
// A missing manifest is unverified and exits 0. A mismatch exits 1.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dist = path.join(root, "apps/server/dist/lib/security/core-integrity-cli.js");
const src = path.join(root, "apps/server/src/lib/security/core-integrity-cli.ts");

function run(target, extra = []) {
  const result = spawnSync(process.execPath, [...extra, target, ...args], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

if (fs.existsSync(dist)) run(dist);

const tsxCandidates = [
  path.join(root, "node_modules/tsx/dist/cli.mjs"),
  path.join(root, "apps/server/node_modules/tsx/dist/cli.mjs"),
];
const tsx = tsxCandidates.find((candidate) => fs.existsSync(candidate));
if (!tsx) {
  console.error("verify-core-integrity: build the server or install dependencies so tsx is available");
  process.exit(1);
}
run(src, [tsx]);
