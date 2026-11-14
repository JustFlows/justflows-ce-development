// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

/**
 * Drafts never reach the shared public cache (justflows-ce#308): a preview
 * render always reads fresh data and stores nothing, so a cached page can
 * never show a draft, and a draft can never show stale published data.
 */

const remember = vi.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn());
vi.mock("../../../src/lib/cache/jf-cache.js", () => ({
  getJfCache: () => ({ enabled: true, remember }),
  cacheStorageDir: () => "/tmp/none",
}));
vi.mock("@justflows/core", () => ({ loadConfig: () => ({ cache: { publicTtl: 60 } }) }));

const { rememberPublic } = await import("../../../src/lib/cache/public-cache.js");

describe("public cache and previews", () => {
  it("bypasses the shared cache for previews, and uses it for published pages", async () => {
    let calls = 0;
    const load = async () => `draft ${++calls}`;
    expect(await rememberPublic("k:site-a:live", load, true)).toBe("draft 1");
    expect(await rememberPublic("k:site-a:live", load, true)).toBe("draft 2");
    expect(remember).not.toHaveBeenCalled();
    await rememberPublic("k:site-a:live", load, false);
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember.mock.calls[0]![0]).toBe("k:site-a:live");
  });
});
