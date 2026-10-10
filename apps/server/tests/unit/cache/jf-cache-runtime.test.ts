// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJfCache, resetJfCache, withoutSharedCache } from "../../../src/lib/cache/jf-cache.js";

describe("getJfCache follows CACHE_ENABLED", () => {
  afterEach(() => {
    resetJfCache();
    delete process.env.CACHE_ENABLED;
  });

  it("does not enable caching when CACHE_ENABLED is unset", () => {
    delete process.env.CACHE_ENABLED;
    resetJfCache();
    expect(getJfCache().enabled).toBe(false);
  });

  it("rebuilds the singleton when CACHE_ENABLED is written after first use", () => {
    delete process.env.CACHE_ENABLED;
    resetJfCache();
    expect(getJfCache().enabled).toBe(false);

    process.env.CACHE_ENABLED = "1";
    expect(getJfCache().enabled).toBe(true);

    process.env.CACHE_ENABLED = "0";
    expect(getJfCache().enabled).toBe(false);
  });

  it("deletes leftover cache files when cache is disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jf-cache-wipe-"));
    const dir = path.join(root, ".cache");
    fs.mkdirSync(dir);
    const leftover = path.join(dir, "leftover.json");
    fs.writeFileSync(leftover, "{}");

    const prevRoot = process.env.JF_ROOT;
    const prevDir = process.env.CACHE_DIR;
    process.env.JF_ROOT = root;
    process.env.CACHE_DIR = dir;
    process.env.CACHE_ENABLED = "0";
    try {
      resetJfCache();
      expect(getJfCache().enabled).toBe(false);
      expect(fs.existsSync(leftover)).toBe(false);
    } finally {
      if (prevRoot === undefined) delete process.env.JF_ROOT;
      else process.env.JF_ROOT = prevRoot;
      if (prevDir === undefined) delete process.env.CACHE_DIR;
      else process.env.CACHE_DIR = prevDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


it("bypasses retained cache facades only inside private requests and preserves invalidation", async () => {
  const previousDriver = process.env.CACHE_DRIVER;
  process.env.CACHE_DRIVER = "memory"; process.env.CACHE_ENABLED = "1"; resetJfCache();
  try {
    const retained = getJfCache(); await retained.set("account-test-key", "public");
    await withoutSharedCache(async () => {
      expect(retained.enabled).toBe(false); expect(await retained.get("account-test-key")).toBeUndefined();
      await retained.set("account-test-key", "private");
      expect(await retained.remember("private-key", 60, async () => "private data")).toBe("private data");
    });
    const personal = await Promise.all([
      withoutSharedCache(() => retained.remember("same-personal-key", 60, async () => "user-a")),
      withoutSharedCache(() => retained.remember("same-personal-key", 60, async () => "user-b")),
    ]);
    expect(personal).toEqual(["user-a", "user-b"]);
    expect(retained.enabled).toBe(true); expect(await retained.get("account-test-key")).toBe("public");
    expect(await retained.get("private-key")).toBeUndefined();
    await withoutSharedCache(() => retained.delete("account-test-key"));
    expect(await retained.get("account-test-key")).toBeUndefined();
  } finally { if (previousDriver === undefined) delete process.env.CACHE_DRIVER; else process.env.CACHE_DRIVER = previousDriver; delete process.env.CACHE_ENABLED; resetJfCache(); }
});
