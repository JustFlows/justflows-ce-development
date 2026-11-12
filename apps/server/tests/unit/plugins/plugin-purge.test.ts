// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appliedSchemaPasswordKey,
  appliedSchemaSettingKey,
  pluginSettingsLikePattern,
  purgeOtherPluginVersions,
  purgePluginFiles,
} from "../../../src/lib/plugins/plugin-purge.js";

describe("plugin purge keys", () => {
  it("scopes settings deletes to the plugin's colon prefix", () => {
    expect(pluginSettingsLikePattern("justflows.store")).toBe("plugin.justflows.store:%");
    expect(pluginSettingsLikePattern("justflows.store")).not.toContain("justflows.shopping");
    expect(appliedSchemaSettingKey("justflows.store")).toBe("plugin_schema:justflows.store");
    expect(appliedSchemaPasswordKey("justflows.store")).toBe("plugin_schema:justflows.store:password");
  });
});

describe("purgePluginFiles", () => {
  let root: string;
  const savedPackagesDir = process.env.PACKAGES_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jf-purge-files-"));
    process.env.PACKAGES_DIR = path.join(root, "packages-installed");
  });

  afterEach(() => {
    if (savedPackagesDir === undefined) delete process.env.PACKAGES_DIR;
    else process.env.PACKAGES_DIR = savedPackagesDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deletes the installed directory and prunes now-empty parents", () => {
    const installedPath = path.join(
      root,
      "packages-installed",
      "plugins",
      "acme.demo",
      "1.0.0",
      "abcdef0123456789",
    );
    fs.mkdirSync(installedPath, { recursive: true });
    fs.writeFileSync(path.join(installedPath, "justflows.json"), "{}");

    const result = purgePluginFiles({ installedPath });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(installedPath)).toBe(false);
    // `<id>` and `<id>/<version>` had nothing else in them, so they go too.
    expect(fs.existsSync(path.join(root, "packages-installed", "plugins", "acme.demo"))).toBe(false);
    expect(fs.existsSync(path.join(root, "packages-installed", "plugins"))).toBe(true);
  });

  it("keeps a parent that still holds another build", () => {
    const base = path.join(root, "packages-installed", "plugins", "acme.demo", "1.0.0");
    const gone = path.join(base, "1111111111111111");
    const kept = path.join(base, "2222222222222222");
    fs.mkdirSync(gone, { recursive: true });
    fs.mkdirSync(kept, { recursive: true });

    expect(purgePluginFiles({ installedPath: gone }).ok).toBe(true);

    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("refuses to touch a path outside packages-installed", () => {
    const outside = path.join(root, "not-packages", "payload");
    fs.mkdirSync(outside, { recursive: true });

    const result = purgePluginFiles({ installedPath: outside });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("is a no-op for a bundled plugin with no installedPath", () => {
    expect(purgePluginFiles({ bundledPath: "/somewhere/plugins/acme.demo" }).ok).toBe(true);
    expect(purgePluginFiles(undefined).ok).toBe(true);
  });
});

describe("purgeOtherPluginVersions", () => {
  let root: string;
  const savedPackagesDir = process.env.PACKAGES_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jf-purge-versions-"));
    process.env.PACKAGES_DIR = path.join(root, "packages-installed");
  });

  afterEach(() => {
    if (savedPackagesDir === undefined) delete process.env.PACKAGES_DIR;
    else process.env.PACKAGES_DIR = savedPackagesDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes older versions and keeps the live build and other plugins", () => {
    const plugins = path.join(root, "packages-installed", "plugins");
    const live = path.join(plugins, "acme.demo", "2.0.0", "2222222222222222");
    const old = path.join(plugins, "acme.demo", "1.0.0", "1111111111111111");
    const legacy = path.join(plugins, "acme.demo", "0.9.0");
    const other = path.join(plugins, "acme.other", "1.0.0", "3333333333333333");
    for (const dir of [live, old, legacy, other]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(legacy, "justflows.json"), "{}");

    const result = purgeOtherPluginVersions(live);

    expect(result.ok).toBe(true);
    expect(result.removed.sort()).toEqual(["0.9.0", "1.0.0"]);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(path.join(plugins, "acme.demo", "1.0.0"))).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("leaves paths with an unexpected layout alone", () => {
    const plugins = path.join(root, "packages-installed", "plugins");
    const flat = path.join(plugins, "acme.demo", "1.0.0");
    const sibling = path.join(plugins, "acme.demo", "0.9.0");
    fs.mkdirSync(flat, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const outside = path.join(root, "elsewhere", "plugins", "acme.demo", "1.0.0", "abc");
    fs.mkdirSync(outside, { recursive: true });

    expect(purgeOtherPluginVersions(flat).removed).toEqual([]);
    expect(purgeOtherPluginVersions(outside).removed).toEqual([]);
    expect(fs.existsSync(sibling)).toBe(true);
  });
});
