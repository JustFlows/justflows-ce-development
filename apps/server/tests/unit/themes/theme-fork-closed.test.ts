// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const active = vi.hoisted(() => ({ manifest: {} as Record<string, unknown> }));

vi.mock("../../../src/lib/themes/themes-db.js", () => ({
  getActiveTheme: vi.fn(async () => ({
    theme_id: "acme.studio",
    name: "Acme Studio",
    manifest: active.manifest,
  })),
  getTheme: vi.fn(),
  insertTheme: vi.fn(),
  themeInstalledPath: vi.fn(() => null),
}));

vi.mock("../../../src/lib/themes/theme-files.js", () => ({
  resolveThemeDir: vi.fn(() => null),
}));

const { ClosedThemeCopyError, forkActiveTheme } = await import("../../../src/lib/themes/theme-fork.js");

const SITE = "033fcfcc-8948-417d-928f-62f5b7954b67";

describe("save as new theme with a closed license (justflows-ce#281)", () => {
  beforeEach(() => {
    active.manifest = {};
  });

  it("refuses to copy a theme with a closed LicenseRef- license", async () => {
    active.manifest = { license: "LicenseRef-Acme-Commercial" };
    await expect(forkActiveTheme(SITE, "My copy")).rejects.toBeInstanceOf(ClosedThemeCopyError);
    await expect(forkActiveTheme(SITE, "My copy")).rejects.toThrow(
      '"Acme Studio" has a closed license, so it cannot be saved as a new theme.',
    );
  });

  it("lets an open-licensed theme past the license check", async () => {
    active.manifest = { license: "GPL-2.0-or-later" };
    /** The mocked theme has no files, so the fork stops at the next step instead. */
    await expect(forkActiveTheme(SITE, "My copy")).rejects.toThrow("Active theme files not found");
  });
});
