import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DB_DRIVER = "postgres";

/**
 * One site_settings row. `interleave` simulates another editor writing between
 * our read and our conditional update, which must make the update miss and retry.
 */
let row: { value: string | null } | null = null;
let interleave: Array<() => void> = [];
const updates: string[] = [];

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    async query() {
      const result = row ? [{ value: row.value }] : [];
      const next = interleave.shift();
      next?.();
      return result;
    },
    async execute(sql: string, params: unknown[] = []) {
      updates.push(sql);
      if (/^\s*INSERT/i.test(sql)) {
        if (row) return 0;
        row = { value: String(params[3]) };
        return 1;
      }
      if (/value IS NULL/.test(sql)) {
        if (!row || row.value !== null) return 0;
        row = { value: String(params[0]) };
        return 1;
      }
      const expected = params[4] as string;
      if (!row || row.value === null || JSON.stringify(JSON.parse(row.value)) !== JSON.stringify(JSON.parse(expected))) return 0;
      row = { value: String(params[0]) };
      return 1;
    },
    async run() {},
  }),
}));

const { updateSiteSettingAtomically, SiteSettingContentionError } = await import("../../../src/lib/settings/site-settings.js");

beforeEach(() => {
  row = null;
  interleave = [];
  updates.length = 0;
});

const add = (item: string) => (current: string[] | null) => [...(current ?? []), item];

describe("updateSiteSettingAtomically", () => {
  it("creates the setting when it does not exist", async () => {
    expect(await updateSiteSettingAtomically("s", "k", add("a"))).toEqual(["a"]);
    expect(JSON.parse(row!.value!)).toEqual(["a"]);
  });

  it("keeps a concurrent writer's change by re-reading and re-applying", async () => {
    row = { value: JSON.stringify(["a"]) };
    /** Another editor appends "theirs" right after our first read. */
    interleave = [() => (row = { value: JSON.stringify(["a", "theirs"]) })];
    expect(await updateSiteSettingAtomically("s", "k", add("mine"))).toEqual(["a", "theirs", "mine"]);
    expect(JSON.parse(row!.value!)).toEqual(["a", "theirs", "mine"]);
  });

  it("does not write when nothing changes", async () => {
    row = { value: JSON.stringify(["a"]) };
    await updateSiteSettingAtomically<string[]>("s", "k", (current) => current ?? []);
    expect(updates).toEqual([]);
  });

  it("matches a stored NULL explicitly", async () => {
    row = { value: null };
    expect(await updateSiteSettingAtomically("s", "k", add("a"))).toEqual(["a"]);
  });

  it("gives up after repeated contention instead of overwriting", async () => {
    row = { value: JSON.stringify([]) };
    let n = 0;
    interleave = Array.from({ length: 10 }, () => () => (row = { value: JSON.stringify([`other-${n++}`]) }));
    await expect(updateSiteSettingAtomically("s", "k", add("mine"))).rejects.toBeInstanceOf(SiteSettingContentionError);
  });
});
