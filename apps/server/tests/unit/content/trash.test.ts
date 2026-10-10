// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query }) }));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../src/lib/media/upload-store.js", () => ({ getUploadStore: vi.fn() }));
vi.mock("../../../src/lib/media/media-responsive.js", () => ({ moveVariantDir: vi.fn(), removeVariantDir: vi.fn() }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteSetting: vi.fn() }));
import { listTrash } from "../../../src/lib/content/trash.js";

beforeEach(() => { query.mockReset(); });

describe("trash media reference checks", () => {
  it.each([1, 100])("loads reference documents once for %i media files", async (count) => {
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      expect(params).toEqual(["site-a"]);
      if (sql.includes("FROM media")) return Array.from({ length: count }, (_, i) => ({
        id: `m${i}`, filename: `photo${i}`, mime_type: "image/jpeg", url: `/uploads/${i}.jpg`,
        storage_key: `${i}.jpg`, trashed_at: "2026-01-01",
      }));
      if (sql.startsWith("SELECT blocks")) return [
        { blocks: { image: "/uploads/0.jpg" }, fields: '{"image":"/uploads/1.jpg"}' },
      ];
      if (sql.startsWith("SELECT items")) return [{ items: { url: "/uploads/2.jpg" } }];
      return [];
    });
    const items = await listTrash("site-a");
    expect(items).toHaveLength(count);
    expect(items.slice(0, Math.min(count, 3)).every((item) => item.referenced)).toBe(true);
    expect(items.slice(3).every((item) => !item.referenced)).toBe(true);
    expect(query).toHaveBeenCalledTimes(6);
  });

  it("skips reference scans when the trash contains no media", async () => {
    query.mockResolvedValue([]);
    expect(await listTrash("site-b")).toEqual([]);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
