// SPDX-License-Identifier: MIT
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { S3StorageAdapter } from "@justflows/media";
const mocks = vi.hoisted(() => ({
  root: "",
  query: vi.fn(),
  privateUsage: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../../../src/lib/runtime/jf-root.js", () => ({
  uploadsDir: () => path.join(mocks.root, "uploads"),
}));
vi.mock("../../../src/lib/files/private-storage.js", () => ({
  privateLocalRoot: () => path.join(mocks.root, "private"),
  privateStorageUsage: mocks.privateUsage,
}));
vi.mock("../../../src/lib/database/db.js", () => ({
  getControlDb: async () => ({ query: mocks.query }),
  getDb: async () => ({ query: mocks.query }),
}));
vi.mock("../../../src/lib/tenancy/registry.js", () => ({
  installationRootSiteId: async () => "00000000-0000-4000-8000-000000000001",
}));
vi.mock("../../../src/lib/tenancy/provision.js", () => ({
  runWithSiteDatabase: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("../../../src/lib/static-export/config.js", () => ({
  getStaticExportConfig: () => ({ outDir: path.join(mocks.root, "static-export") }),
}));
vi.mock("@justflows/media", () => ({
  S3StorageAdapter: class {
    listObjects = mocks.list;
  },
}));
import {
  getSiteStorageUsage,
  measureLocalDirectory,
  measureS3Prefix,
  sumStorageAmounts,
} from "../../../src/lib/storage/storage-usage.js";
const SITE = "00000000-0000-4000-8000-000000000002";
beforeEach(async () => {
  mocks.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jf-storage-")));
  mocks.query.mockImplementation(async (sql: string) =>
    sql.includes("site_domains")
      ? [{ hostname: "demo.example.com" }]
      : sql.includes("private_files")
        ? [{ bytes: 30 }]
        : [{ bytes: 20 }],
  );
  mocks.privateUsage.mockResolvedValue({
    local: { bytes: 30, files: 1 },
    external: { bytes: 0, files: 0 },
  });
  mocks.list.mockImplementation(async (prefix: string) =>
    prefix.includes(".trash/")
      ? []
      : [{ key: `${prefix}data`, size: prefix.includes("static-export") ? 40 : 20 }],
  );
  for (const [key, value] of Object.entries({
    STORAGE_DRIVER: "s3",
    STORAGE_S3_BUCKET: "test",
    STORAGE_S3_ENDPOINT: "https://example.test",
    STORAGE_S3_ACCESS_KEY_ID: "dummy",
    STORAGE_S3_SECRET_ACCESS_KEY: "dummy",
    STORAGE_S3_PREFIX: "install",
  }))
    vi.stubEnv(key, value);
});
afterEach(async () => {
  await fs.rm(mocks.root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("physical storage accounting", () => {
  it("counts real bytes, nested/trash files, and empty directories", async () => {
    const folder = path.join(mocks.root, "folder");
    await fs.mkdir(path.join(folder, ".trash"), { recursive: true });
    await fs.writeFile(path.join(folder, "live"), "abc");
    await fs.writeFile(path.join(folder, ".trash", "old"), "12345");
    expect(await measureLocalDirectory(folder)).toEqual({ bytes: 8, files: 2 });
    expect(await measureLocalDirectory(path.join(mocks.root, "missing"))).toEqual({
      bytes: 0,
      files: 0,
    });
    await fs.symlink(folder, path.join(folder, "loop"));
    expect(await measureLocalDirectory(folder)).toBeNull();
  });
  it("does not treat failed or out-of-prefix remote inventories as zero", async () => {
    const adapter = { listObjects: mocks.list } as unknown as S3StorageAdapter;
    mocks.list.mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await measureS3Prefix(adapter, "site/")).toBeNull();
    mocks.list.mockResolvedValueOnce([{ key: "another-site/file", size: 7 }]);
    expect(await measureS3Prefix(adapter, "site/")).toBeNull();
    expect(sumStorageAmounts([{ bytes: 1, files: 1 }, null])).toBeNull();
  });
  it("separates site-local, external, retained export and logical bytes", async () => {
    await fs.mkdir(path.join(mocks.root, "uploads", SITE), { recursive: true });
    await fs.writeFile(path.join(mocks.root, "uploads", SITE, "old-local-copy"), "123");
    const oldExport = path.join(mocks.root, "static-export-sites", "former.example.com");
    await fs.mkdir(oldExport, { recursive: true });
    const marker = JSON.stringify({ siteId: SITE });
    await fs.writeFile(path.join(oldExport, "_static-export.json"), marker);
    await fs.writeFile(path.join(oldExport, "index.html"), "html");
    const usage = await getSiteStorageUsage(SITE);
    expect(usage.local!.bytes).toBe(3 + 30 + Buffer.byteLength(marker) + 4);
    expect(usage.external!.bytes).toBe(60);
    expect(usage.logicalBytes).toBe(50);
    expect(mocks.list).toHaveBeenCalledWith(`install/${SITE}/`);
    expect(mocks.list).toHaveBeenCalledWith(`install/static-export/sites/${SITE}/`);
  });
  it("leaves total usage unknown if any required provider cannot be measured", async () => {
    mocks.privateUsage.mockRejectedValue(new Error("connection cannot be decrypted"));
    const usage = await getSiteStorageUsage(SITE);
    expect(usage.totalBytes).toBeNull();
  });
});
