#!/usr/bin/env node
/**
 * One-command production setup for Plesk / cPanel / VPS.
 *
 * Usage (from app root):
 *   npm run install:all
 *   node scripts/install-all.js
 *
 * What it does:
 *   1. Patch workspace manifests for npm (no pnpm required)
 *   2. npm install — production deps at root + linked packages
 *   3. Build packages + admin UI + server (if dist/ is missing or --rebuild)
 *   4. Touch tmp/restart.txt for Passenger
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_BUILD_ORDER = [
  "packages/blocks",
  "packages/core",
  "packages/cache",
  "packages/sdk",
  "packages/database",
  "packages/auth",
  "packages/installer",
  "packages/plugin-api",
  "packages/content",
  "packages/media",
];

function log(msg) {
  console.log(`\n==> ${msg}`);
}

function run(cmd, args, opts = {}) {
  console.log(`    ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" },
    ...opts,
  });
  return result.status ?? 1;
}

function runOrFail(cmd, args, opts = {}) {
  const code = run(cmd, args, opts);
  if (code !== 0) process.exit(code);
}

function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

function needsBuild() {
  return (
    process.argv.includes("--rebuild") ||
    !exists("apps/server/dist/server.js") ||
    !exists("apps/server/admin-ui/dist/client/index.html") ||
    !exists("apps/server/admin-ui/dist/server/entry-server.js")
  );
}

function tscBin() {
  const local = path.join(ROOT, "node_modules/typescript/bin/tsc");
  if (fs.existsSync(local)) return local;
  return null;
}

function runTsc(tsconfigPath) {
  const bin = tscBin();
  if (bin) {
    return run("node", [bin, "-p", tsconfigPath]);
  }
  // Avoid `npx tsc` — npm may resolve the unrelated "tsc" package instead of typescript.
  return run("npx", ["--package=typescript", "tsc", "-p", tsconfigPath]);
}

function buildPackage(relDir) {
  const pkgPath = path.join(ROOT, relDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  const tsconfig = path.join(ROOT, relDir, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) return;

  const code = runTsc(tsconfig);
  if (code !== 0) {
    console.warn(`    (skipped ${relDir} — build failed, may be optional)`);
  }
}

function buildServer() {
  log("Building admin UI…");
  runOrFail("npx", ["vite", "build", "--config", "apps/server/admin-ui/vite.config.ts"]);

  log("Building Express server…");
  const bin = tscBin();
  if (!bin) {
    console.error("typescript not installed — run ensureBuildTooling first");
    process.exit(1);
  }
  runOrFail("node", [bin, "-p", "apps/server/tsconfig.json"]);

  const distI18n = path.join(ROOT, "apps/server/dist/lib/i18n");
  fs.mkdirSync(distI18n, { recursive: true });

  for (const name of ["site-catalogs", "admin-catalogs"]) {
    const src = path.join(ROOT, "apps/server/src/lib/i18n", name);
    const dest = path.join(distI18n, name);
    if (fs.existsSync(src)) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    }
  }

  const viewsSrc = path.join(ROOT, "apps/server/src/views");
  const viewsDest = path.join(ROOT, "apps/server/dist/views");
  if (fs.existsSync(viewsSrc)) {
    fs.rmSync(viewsDest, { recursive: true, force: true });
    fs.cpSync(viewsSrc, viewsDest, { recursive: true });
  }
}

function ensureBuildTooling() {
  if (!needsBuild()) return;

  log("Installing build tools (typescript, vite)…");
  runOrFail("npm", [
    "install",
    "--no-save",
    "--ignore-scripts",
    "typescript@^7.0.2",
    "vite@^8.2.1",
    "@vitejs/plugin-react@^5.0.2",
    "@types/node@^26.2.0",
    "@types/express@^5.0.3",
    "@types/cookie-parser@^1.4.9",
    "@types/ejs@^3.1.5",
    "@types/multer@^2.0.0",
    "react@^19.2.8",
    "react-dom@^19.2.8",
    "react-router-dom@^7.8.2",
    "@types/react@^19.2.18",
    "@types/react-dom@^19.2.4",
  ]);
}

function bundleServer() {
  const bundleScript = path.join(ROOT, "scripts/bundle-server.js");
  if (!fs.existsSync(bundleScript)) return;

  log("Bundling server for faster boot…");
  run("node", ["scripts/bundle-server.js"]);
}

function touchPassengerRestart() {
  const tmp = path.join(ROOT, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "restart.txt"), `${Date.now()}\n`);
}

function hasPnpmNodeModules() {
  return fs.existsSync(path.join(ROOT, "node_modules", ".pnpm"));
}

function stashPnpmNodeModules() {
  if (!hasPnpmNodeModules()) return null;
  const hidden = path.join(ROOT, "node_modules.pnpm-hidden");
  log("Moving pnpm node_modules aside so npm can install a production tree…");
  fs.rmSync(hidden, { recursive: true, force: true });
  fs.renameSync(path.join(ROOT, "node_modules"), hidden);
  return hidden;
}

function restorePnpmNodeModules(hidden) {
  if (!hidden || !fs.existsSync(hidden)) return;
  fs.rmSync(path.join(ROOT, "node_modules"), { recursive: true, force: true });
  fs.renameSync(hidden, path.join(ROOT, "node_modules"));
}

function restoreDevManifests() {
  if (!fs.existsSync(path.join(ROOT, ".git"))) return;
  run("node", ["scripts/restore-hosting.js"]);
}

function main() {
  const buildOnly = process.argv.includes("--build-only");
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) {
    console.error(`Node.js 20+ required (you have ${process.version}).`);
    process.exit(1);
  }

  if (!buildOnly) {
    log("Patching package.json files for npm…");
    runOrFail("node", ["scripts/prepare-hosting.js"]);

    const pnpmTree = stashPnpmNodeModules();

    log("Installing production dependencies…");
    const installCode = run("npm", ["install", "--omit=dev", "--ignore-scripts"]);

    // The patched manifests (file: paths, no devDependencies) are only needed
    // for the npm install above; node_modules is what the rest of this script
    // and any later `pnpm turbo run build` actually use. Restore them now so a
    // successful hosting install doesn't leave a dev checkout unbuildable.
    restoreDevManifests();

    if (installCode !== 0) {
      restorePnpmNodeModules(pnpmTree);
      process.exit(installCode);
    }
    if (pnpmTree) {
      fs.rmSync(pnpmTree, { recursive: true, force: true });
    }
  }

  if (needsBuild()) {
    ensureBuildTooling();

    for (const dir of PACKAGE_BUILD_ORDER) {
      if (exists(dir)) {
        log(`Building ${dir}…`);
        buildPackage(dir);
      }
    }

    log("Building apps/server…");
    buildServer();
    bundleServer();
  } else {
    log("Build artifacts present — skipping compile (use --rebuild to force).");
  }

  if (!buildOnly) {
    touchPassengerRestart();
  }

  if (buildOnly) return;

  console.log(`
✓ Justflows is ready.

Plesk Node.js settings:
  • Application startup file: server.js
  • Application mode: production
  • Click "Restart App"

Open your domain in a browser to finish setup.
  (Optional terminal fallback: npm run install:all)

Test in browser:
  https://your-domain/               ← first-run page, then /install
  https://your-domain/api/healthz

Clean up if present: .next/  — and any .htaccess you did not write (Justflows
installs and manages its own site-root .htaccess once setup completes; a
leftover one from another app is kept as-is and can break routing).
`);
}

main();
