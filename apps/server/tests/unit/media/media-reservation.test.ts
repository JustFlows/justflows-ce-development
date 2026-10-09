// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";

const MB = 1024 * 1024;
const rows = vi.hoisted(() => new Map<string, { size: number; derivative: number }>());
const release = vi.hoisted(() => ({ fn: () => {} }));

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    async query(sql: string) {
      if (sql.includes("SUM(size_bytes + derivative_bytes)")) {
        let total = 0;
        for (const row of rows.values()) total += row.size + row.derivative;
        return [{ total }];
      }
      return [];
    },
    async run(sql: string, params: unknown[]) {
      if (sql.startsWith("INSERT INTO media")) {
        rows.set(String(params[0]), { size: Number(params[4]), derivative: Number(params[5]) });
      } else if (sql.startsWith("DELETE FROM media")) {
        rows.delete(String(params[0]));
      } else if (sql.startsWith("UPDATE media SET derivatives = ?, derivative_bytes = ?")) {
        const row = rows.get(String(params[7]));
        if (row) row.derivative = Number(params[1]);
      } else if (sql.startsWith("UPDATE media SET derivative_bytes = 0")) {
        const row = rows.get(String(params[0]));
        if (row) row.derivative = 0;
      }
    },
  }),
}));
vi.mock("../../../src/lib/media/upload-store.js", () => ({
  getUploadStore: () => ({ put: async () => undefined, delete: async () => undefined }),
  readUpload: async () => null,
}));
vi.mock("../../../src/lib/tenancy/quotas.js", () => ({ enforceQuota: async () => null }));
vi.mock("../../../src/lib/media/media-responsive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/media/media-responsive.js")>()),
  // Variants take as much space as the original, and generation is held
  // until the test releases it, as when the image queue is busy.
  generateAndStoreVariants: async () => {
    await new Promise<void>((resolve) => {
      const previous = release.fn;
      release.fn = () => {
        previous();
        resolve();
      };
    });
    return {
      base: { w: 10, h: 10, format: "png" },
      variants: [{ w: 10, h: 10, format: "webp", url: "/x", bytes: MB }],
      widths: [10],
      formats: ["webp"],
      generatedAt: new Date().toISOString(),
      totalBytes: MB,
    };
  },
}));

vi.mock("../../../src/lib/storage/storage-quota.js", async () => {
  const { createKeyedLock } = await import("../../../src/lib/security/upload-admission.js");
  return { withSiteStorageLock: createKeyedLock(), enforceStorageGrowth: vi.fn() };
});

import { storeMediaUpload } from "../../../src/lib/media/media-write.js";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MB - 8)]);
const actor = { siteId: "00000000-0000-4000-8000-000000000001", userId: "u", role: "author" };

afterEach(() => {
  rows.clear();
  vi.unstubAllEnvs();
});

describe("media quota reservations", () => {
  it("keeps the variant reservation while variants are still being generated", async () => {
    vi.stubEnv("JF_MAX_LIBRARY_MB", "3");
    const upload = () =>
      storeMediaUpload({ originalname: "a.png", mimetype: "image/png", size: png.length, buffer: png }, actor);
    const first = upload();
    const second = upload();
    // Let both reach the generation step, then release it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release.fn();
    const statuses = (await Promise.all([first, second])).map((result) => result.status).sort();
    expect(statuses).toEqual([201, 413]);
    let total = 0;
    for (const row of rows.values()) total += row.size + row.derivative;
    expect(total).toBeLessThanOrEqual(3 * MB);
  });
});
