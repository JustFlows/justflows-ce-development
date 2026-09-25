// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import path from "node:path";
import { listThemePatterns, loadThemePattern } from "../../../src/lib/themes/theme-files.js";
import { isEmptyBlockDocument } from "../../../src/lib/content/default-content-blocks.js";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("default theme patterns", () => {
  it("ships the accessible starter section set through the theme registry", () => {
    const previous = process.env.JF_ROOT;
    process.env.JF_ROOT = repoRoot;
    try {
      const ids = listThemePatterns("justflows.default").map((pattern) => pattern.id);
      for (const id of ["hero", "feature-grid", "pricing", "testimonial", "cta", "faq"]) {
        expect(ids).toContain(id);
        expect(loadThemePattern("justflows.default", id)?.blocks.length).toBeGreaterThan(0);
      }
    } finally {
      if (previous === undefined) delete process.env.JF_ROOT;
      else process.env.JF_ROOT = previous;
    }
  });

  it("treats missing or empty block documents as empty", () => {
    expect(isEmptyBlockDocument(undefined)).toBe(true);
    expect(isEmptyBlockDocument({ version: 1, blocks: [] })).toBe(true);
    expect(isEmptyBlockDocument({ version: 1, blocks: [{ type: "core.heading" }] })).toBe(false);
  });
});
