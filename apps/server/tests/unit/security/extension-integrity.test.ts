// SPDX-License-Identifier: MIT

import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyCoreIntegrity, writeCoreManifest } from "../../../src/lib/security/core-integrity.js";
import {
  extensionAllowsLoad,
  invalidateIntegrityCache,
  recordInstalledPackageBaseline,
  verifyInstalledDirectory,
} from "../../../src/lib/security/extension-integrity.js";

const DIGEST = "a".repeat(64);
const saved = {
  JF_ROOT: process.env.JF_ROOT,
  PACKAGES_DIR: process.env.PACKAGES_DIR,
};

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jf-integrity-"));
  process.env.JF_ROOT = root;
  process.env.PACKAGES_DIR = path.join(root, "packages-installed");
  invalidateIntegrityCache();
});

afterEach(async () => {
  if (saved.JF_ROOT === undefined) delete process.env.JF_ROOT;
  else process.env.JF_ROOT = saved.JF_ROOT;
  if (saved.PACKAGES_DIR === undefined) delete process.env.PACKAGES_DIR;
  else process.env.PACKAGES_DIR = saved.PACKAGES_DIR;
  invalidateIntegrityCache();
  await fs.rm(root, { recursive: true, force: true });
});

async function plantPackage(name = "index.js", contents = "hello"): Promise<string> {
  const dir = path.join(root, "packages-installed", "plugins", "demo.plugin", "1.0.0");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "justflows.json"), JSON.stringify({
    id: "demo.plugin",
    version: "1.0.0",
    type: "plugin",
  }));
  await fs.writeFile(path.join(dir, name), contents);
  return dir;
}

async function baseline(dir: string): Promise<void> {
  await recordInstalledPackageBaseline({
    packageDir: dir,
    packageId: "demo.plugin",
    packageType: "plugin",
    version: "1.0.0",
    archiveDigest: DIGEST,
  });
}

describe("extension integrity", () => {
  it("records a baseline outside the package and detects a later change", async () => {
    const dir = await plantPackage();
    await baseline(dir);
    const inventory = path.join(root, "storage", "integrity", "extensions");
    expect(inventory.startsWith(dir)).toBe(false);
    expect((await verifyInstalledDirectory(dir))?.status).toBe("verified");
    expect(await extensionAllowsLoad(dir)).toBe(true);

    await fs.writeFile(path.join(dir, "index.js"), "changed");
    const modified = await verifyInstalledDirectory(dir);
    expect(modified?.status).toBe("modified");
    expect(modified?.modified).toEqual(["index.js"]);
    expect(await extensionAllowsLoad(dir)).toBe(false);

    await fs.writeFile(path.join(dir, "index.js"), "hello");
    await fs.rm(path.join(dir, "index.js"));
    expect((await verifyInstalledDirectory(dir))?.status).toBe("missing");

    await fs.writeFile(path.join(dir, "index.js"), "hello");
    await fs.writeFile(path.join(dir, "extra.txt"), "extra");
    const unexpected = await verifyInstalledDirectory(dir);
    expect(unexpected?.status).toBe("unexpected");
    expect(unexpected?.unexpected).toContain("extra.txt");
  });

  it("treats a package with no baseline as unverified and still loadable", async () => {
    const dir = await plantPackage();
    const report = await verifyInstalledDirectory(dir);
    expect(report?.status).toBe("unverifiable");
    expect(await extensionAllowsLoad(dir)).toBe(true);
  });

  it("does not follow a link or write the baseline from it", async () => {
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "secret");
    const dir = await plantPackage();
    await fs.symlink(outside, path.join(dir, "linked.txt"));
    await expect(baseline(dir)).rejects.toThrow(/link|special|unreadable/i);
    expect(await fs.readFile(outside, "utf8")).toBe("secret");
    const names = await fs.readdir(path.join(root, "storage", "integrity", "extensions")).catch(() => []);
    expect(names).toEqual([]);
  });
});

describe("core integrity", () => {
  it("distinguishes a signed manifest, a local baseline, and a missing manifest", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await fs.writeFile(path.join(root, "server.js"), "console.log('ok');\n");
    await fs.mkdir(path.join(root, "plugins", "demo"), { recursive: true });
    await fs.writeFile(path.join(root, "plugins", "demo", "index.js"), "plugin");
    expect((await verifyCoreIntegrity({ root })).status).toBe("absent");

    await writeCoreManifest({ root, kind: "local", version: "1.2.3" });
    expect((await verifyCoreIntegrity({ root })).status).toBe("local");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeCoreManifest({ root, kind: "official", privateKeyPem, version: "1.2.3" });
    const manifest = JSON.parse(await fs.readFile(path.join(root, "core-integrity.json"), "utf8")) as {
      files: Array<{ path: string }>;
    };
    expect(manifest.files.some((file) => file.path.startsWith("plugins/"))).toBe(false);
    expect((await verifyCoreIntegrity({ root, publicKeys: [publicPem] })).status).toBe("verified");

    await fs.writeFile(path.join(root, "server.js"), "console.log('tampered');\n");
    const failed = await verifyCoreIntegrity({ root, publicKeys: [publicPem] });
    expect(failed.status).toBe("failed");
    expect(failed.mismatched).toContain("server.js");
  });
});
