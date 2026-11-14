import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ sql: string; params: unknown[] }> = [];
vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return [];
    },
  }),
}));

const { isMediaListKind, listMediaItems } = await import("../../../src/lib/media/media-write.js");

beforeEach(() => {
  calls.length = 0;
});

describe("listMediaItems kind filter", () => {
  it("filters by MIME type prefix in the query, scoped to the site", async () => {
    await listMediaItems("site-1", 80, "video");
    expect(calls[0]!.sql).toContain("mime_type LIKE ?");
    expect(calls[0]!.params).toEqual(["site-1", "video/%", 80]);
  });

  it("lists every kind when no filter is given", async () => {
    await listMediaItems("site-1", 40);
    expect(calls[0]!.sql).not.toContain("mime_type LIKE");
    expect(calls[0]!.params).toEqual(["site-1", 40]);
  });

  it("only accepts known kinds", () => {
    expect(isMediaListKind("audio")).toBe(true);
    expect(isMediaListKind("video/%")).toBe(false);
    expect(isMediaListKind(["image"])).toBe(false);
  });
});
