#!/usr/bin/env node
/**
 * Patch workspace:* deps to file: paths so `npm install` works on Plesk/cPanel.
 * Run before `npm install` in make-zip.sh; restore with restore-hosting.js after.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_DIR = path.join(ROOT, ".hosting-backup");

const PACKAGE_DIRS = [
  "apps/server",
  "packages/blocks",
  "packages/installer",
  "packages/core",
  "packages/cache",
  "packages/auth",
  "packages/sdk",
  "packages/database",
  "packages/plugin-api",
  "packages/content",
  "packages/media",
];

function findPackageJson(name) {
  for (const dir of PACKAGE_DIRS) {
    const pkgPath = path.join(ROOT, dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.name === name) return pkgPath;
  }
  return null;
}

function isWorkspaceSpec(version) {
  return typeof version === "string" && version.startsWith("workspace:");
}

function fileSpecFrom(fromDir, name) {
  const target = findPackageJson(name);
  if (!target) return null;
  let rel = path.relative(fromDir, path.dirname(target));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return `file:${rel.replace(/\\/g, "/")}`;
}

function patchFile(pkgPath) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  let changed = false;

  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;

    for (const [name, version] of Object.entries(deps)) {
      if (!isWorkspaceSpec(version)) continue;

      const spec = fileSpecFrom(path.dirname(pkgPath), name);
      if (!spec) {
        console.warn(`[prepare-hosting] Unknown workspace package: ${name} in ${pkgPath}`);
        continue;
      }

      deps[name] = spec;
      changed = true;
    }
  }

  // Local file: packages still pull devDependencies into npm's tree, which
  // crashes arborist ("Cannot read properties of null (reading 'matches')")
  // when mixed with a pnpm node_modules. Production zips do not need them.
  if (pkg.devDependencies) {
    delete pkg.devDependencies;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

function hoistRootProductionDeps(root) {
  const deps = { ...(root.dependencies ?? {}) };

  for (const [name, version] of Object.entries(deps)) {
    if (!isWorkspaceSpec(version)) continue;
    const spec = fileSpecFrom(ROOT, name);
    if (spec) deps[name] = spec;
  }

  const serverPkgPath = path.join(ROOT, "apps/server/package.json");
  if (fs.existsSync(serverPkgPath)) {
    const server = JSON.parse(fs.readFileSync(serverPkgPath, "utf-8"));
    for (const [name, version] of Object.entries(server.dependencies ?? {})) {
      if (deps[name]) continue;
      if (isWorkspaceSpec(version) || name.startsWith("@justflows/")) {
        const spec = fileSpecFrom(ROOT, name);
        if (spec) deps[name] = spec;
      } else {
        deps[name] = version;
      }
    }
  }

  return deps;
}

function main() {
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true });
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  for (const dir of PACKAGE_DIRS) {
    const pkgPath = path.join(ROOT, dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;

    const backup = path.join(BACKUP_DIR, dir.replace(/\//g, "__") + ".json");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(pkgPath, backup);
    patchFile(pkgPath);
  }

  // Root: hoist production deps npm can install (including apps/server).
  const rootPkgPath = path.join(ROOT, "package.json");
  fs.copyFileSync(rootPkgPath, path.join(BACKUP_DIR, "root.json"));

  const root = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
  root.dependencies = hoistRootProductionDeps(root);
  root.scripts = root.scripts ?? {};
  root.scripts["build:server"] = "node scripts/install-all.js --build-only";
  delete root.workspaces;
  // Same reasoning as patchFile(): a root devDependency like the aliased
  // "typescript": "npm:@typescript/typescript6@..." collides with the real
  // typescript/vitest ensureBuildTooling() installs and crashes npm's
  // arborist ("Cannot read properties of undefined (reading 'extraneous')").
  delete root.devDependencies;
  fs.writeFileSync(rootPkgPath, `${JSON.stringify(root, null, 2)}\n`);

  console.log("[prepare-hosting] Patched package.json files for npm hosting.");
}

main();
