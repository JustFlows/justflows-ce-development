// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVISION_PRUNE_BATCH } from "@justflows/content";

const query = vi.fn();
const run = vi.fn();
const setting = vi.fn();
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query, run }) }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteSetting: (...args: unknown[]) => setting(...args) }));
import { pruneHistoricalBatch, pruneHistoricalForContent } from "../../../src/lib/content/content-revisions.js";

const revisions = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: `r${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)).toISOString(),
}));
beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  run.mockReset().mockResolvedValue(undefined);
  setting.mockReset().mockResolvedValue(2);
});
afterEach(() => vi.unstubAllEnvs());

describe("historical revision pruning", () => {
  it.each(["postgres", "mysql", "mariadb"])("keeps the newest revisions and limits one guarded delete on %s", async (driver) => {
    vi.stubEnv("DB_DRIVER", driver);
    query.mockResolvedValue(revisions(REVISION_PRUNE_BATCH + 10));
    expect(await pruneHistoricalForContent("content-a", "site-a", 2)).toBe(REVISION_PRUNE_BATCH);
    expect(run).toHaveBeenCalledOnce();
    const [sql, params] = run.mock.calls[0]!;
    expect(sql).toContain(driver === "postgres" ? "kind = 'historical'" : "`kind` = 'historical'");
    expect(params).toEqual(["site-a", ...Array.from({ length: REVISION_PRUNE_BATCH }, (_, i) => `r${i + 2}`)]);
    expect(params).not.toContain("r0");
    expect(params).not.toContain("r1");
  });

  it("reads retention once per site in a multi-content job", async () => {
    query.mockImplementation(async (sql: string) => sql.includes("SELECT DISTINCT")
      ? [{ id: "a", site_id: "site-a" }, { id: "b", site_id: "site-a" }, { id: "c", site_id: "site-b" }]
      : revisions(3));
    expect(await pruneHistoricalBatch()).toBe(3);
    expect(setting.mock.calls).toEqual([["site-a", "revisions.max_history"], ["site-b", "revisions.max_history"]]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("avoids empty delete statements when history fits the limit", async () => {
    query.mockResolvedValue(revisions(2));
    expect(await pruneHistoricalForContent("content-a", "site-a", 2)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
