// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getControlDb,
  getDb,
  resetDb,
  runWithControlDatabase,
  runWithDatabase,
  type DbClient,
} from "../../../src/lib/database/db.js";
const client = (): DbClient => ({
  query: vi.fn(),
  run: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
});
afterEach(() => vi.unstubAllEnvs());
describe("held storage transaction context", () => {
  it("reuses the control connection and preserves a separate site database", async () => {
    const control = client();
    const separate = client();
    await runWithControlDatabase(control, async () => {
      expect(await getControlDb()).toBe(control);
      expect(await getDb()).toBe(control);
      await runWithDatabase(separate, async () => {
        expect(await getControlDb()).toBe(control);
        expect(await getDb()).toBe(separate);
      });
    });
  });
  it("does not let delayed tasks reuse a committed transaction", async () => {
    vi.stubEnv("DB_DRIVER", "test-invalid-driver");
    const control = client();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed!: Promise<DbClient>;
    await runWithControlDatabase(control, async () => {
      delayed = (async () => {
        await wait;
        return getControlDb();
      })();
    });
    release();
    const result = await delayed;
    expect(result).not.toBe(control);
    await result.close();
    resetDb();
    expect(control.query).not.toHaveBeenCalled();
  });
});
