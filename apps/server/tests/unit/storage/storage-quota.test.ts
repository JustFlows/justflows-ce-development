// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  run: vi.fn(),
  enforce: vi.fn(),
  bytes: 0,
  tail: Promise.resolve(),
}));
vi.mock("../../../src/lib/database/db.js", () => ({
  getControlDb: async () => ({
    transaction: async (
      work: (tx: { query: typeof mocks.query; run: typeof mocks.run }) => Promise<unknown>,
    ) => {
      const previous = mocks.tail;
      let release!: () => void;
      mocks.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work({ query: mocks.query, run: mocks.run });
      } finally {
        release();
      }
    },
  }),
  runWithControlDatabase: async (_client: unknown, work: () => Promise<unknown>) => work(),
}));
vi.mock("../../../src/lib/storage/storage-snapshots.js", () => ({
  invalidateStorageSnapshots: vi.fn(),
}));
vi.mock("../../../src/lib/tenancy/quotas.js", () => ({
  enforceQuota: mocks.enforce,
  QuotaRefusalError: class extends Error {
    constructor(block: { error: string }) {
      super(block.error);
    }
  },
}));
import {
  enforceStorageGrowth,
  withSiteStorageLock,
} from "../../../src/lib/storage/storage-quota.js";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.bytes = 0;
  mocks.tail = Promise.resolve();
  mocks.query.mockResolvedValue([{ id: "site" }]);
  mocks.enforce.mockImplementation(async (_key: string, _site: string, delta: number) =>
    mocks.bytes + delta <= 10 ? null : { error: "Storage limit exceeded" },
  );
});
describe("storage admission", () => {
  it("serializes different storage writers so only one can spend remaining capacity", async () => {
    const add = () =>
      withSiteStorageLock("site", async () => {
        await enforceStorageGrowth("site", 6);
        await Promise.resolve();
        mocks.bytes += 6;
      });
    const results = await Promise.allSettled([add(), add()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(mocks.bytes).toBe(6);
    expect(mocks.query).toHaveBeenCalledWith(
      "SELECT site_id FROM storage_quota_locks WHERE site_id = ? FOR UPDATE",
      ["site"],
    );
  });
  it("allows an exact cap, rejects growth beyond it, and allows non-growing changes", async () => {
    await enforceStorageGrowth("site", 10);
    mocks.bytes = 10;
    await expect(enforceStorageGrowth("site", 1)).rejects.toThrow("Storage limit exceeded");
    mocks.bytes = 20;
    await expect(enforceStorageGrowth("site", 0)).resolves.toBeUndefined();
  });
  it("fails closed if quota usage is unavailable", async () => {
    mocks.enforce.mockResolvedValue({ error: "Usage could not be read" });
    await expect(enforceStorageGrowth("site", 1)).rejects.toThrow("Usage could not be read");
    await expect(enforceStorageGrowth("site", -1)).rejects.toThrow("Invalid storage growth");
  });
  it("reuses a held lock for nested writes and refuses nonexistent sites", async () => {
    await withSiteStorageLock("site", () => withSiteStorageLock("site", async () => undefined));
    expect(mocks.query).toHaveBeenCalledTimes(2);
    mocks.query.mockResolvedValue([]);
    await expect(withSiteStorageLock("missing", async () => undefined)).rejects.toThrow(
      "Storage site was not found",
    );
  });
});
