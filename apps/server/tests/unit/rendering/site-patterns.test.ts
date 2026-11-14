// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

let stored: unknown = null;
const saveReusableBlock = vi.fn();

vi.mock("../../../src/lib/settings/site-settings.js", () => ({
  getSiteSetting: vi.fn(async () => stored),
  setSiteSetting: vi.fn(async (_siteId: string, _key: string, value: unknown) => {
    stored = value;
  }),
  updateSiteSettingAtomically: vi.fn(async (_siteId: string, _key: string, mutate: (current: unknown) => unknown) => {
    stored = mutate(stored);
    return stored;
  }),
}));
vi.mock("../../../src/lib/rendering/reusable-blocks.js", () => ({ saveReusableBlock }));

const { exportPatternSet, importPatternSet, listSitePatterns, saveSitePattern } =
  await import("../../../src/lib/rendering/site-patterns.js");
const blocks = [{ id: "copy", type: "core.paragraph", version: 1, props: { text: "Hello" } }];

describe("site patterns", () => {
  beforeEach(() => {
    stored = null;
    saveReusableBlock.mockReset();
  });

  it("stores sanitized metadata and localizes an exact or base locale", async () => {
    await saveSitePattern("site", {
      id: "welcome",
      title: "Welcome",
      blocks,
      locales: { nl: { title: "Welkom" } },
    });
    expect((await listSitePatterns("site", "nl-NL"))[0]?.title).toBe("Welkom");
  });

  it("backs synced patterns with the reusable-block resolver", async () => {
    await saveSitePattern("site", { id: "shared", title: "Shared", blocks, synced: true });
    expect(saveReusableBlock).toHaveBeenCalledWith(
      "site",
      expect.objectContaining({ id: "shared", blocks }),
    );
  });

  it("round-trips portable pattern sets without site-only metadata", async () => {
    await importPatternSet("site", {
      schemaVersion: 1,
      patterns: [{ id: "welcome", title: "Welcome", blocks }],
    });
    const exported = await exportPatternSet("site");
    expect(exported.patterns[0]).not.toHaveProperty("source");
    expect(exported.patterns[0]?.id).toBe("welcome");
  });
});
