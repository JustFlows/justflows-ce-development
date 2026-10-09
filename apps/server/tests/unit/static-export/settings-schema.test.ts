// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { StaticExportSettingsSchema } from "../../../src/lib/static-export/settings.js";

const base = {
  enabled: true,
  dir: "",
  baseUrl: "",
  crawlUrl: "",
  originUrl: "",
  allowedOrigins: "",
  maxPages: 2000,
  concurrency: 4,
  auto: false,
  debounceMs: 5000,
};

describe("StaticExportSettingsSchema", () => {
  it("defaults to local and accepts only supported storage drivers", () => {
    expect(StaticExportSettingsSchema.parse(base).storageDriver).toBe("local");
    expect(StaticExportSettingsSchema.parse({ ...base, storageDriver: "s3" }).storageDriver).toBe(
      "s3",
    );
    expect(StaticExportSettingsSchema.safeParse({ ...base, storageDriver: "swift" }).success).toBe(
      false,
    );
  });

  it("accepts blank URLs and a plain relative dir", () => {
    expect(StaticExportSettingsSchema.safeParse({ ...base, dir: "build/site" }).success).toBe(true);
    expect(
      StaticExportSettingsSchema.safeParse({ ...base, originUrl: "https://origin.example.com" })
        .success,
    ).toBe(true);
  });

  it("rejects a URL carrying HTML-breaking characters", () => {
    const evil = 'https://x/"></script><script>alert(1)</script>';
    for (const field of ["baseUrl", "crawlUrl", "originUrl"]) {
      expect(StaticExportSettingsSchema.safeParse({ ...base, [field]: evil }).success).toBe(false);
    }
    expect(
      StaticExportSettingsSchema.safeParse({
        ...base,
        allowedOrigins: `https://ok.example.com, ${evil}`,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-http scheme", () => {
    expect(
      StaticExportSettingsSchema.safeParse({ ...base, originUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("rejects an absolute or traversing export dir", () => {
    for (const dir of [".", "..", "../up", "/var/www", "a/../b"]) {
      expect(StaticExportSettingsSchema.safeParse({ ...base, dir }).success).toBe(false);
    }
  });

  it("clamps out-of-range ints via coercion bounds", () => {
    const parsed = StaticExportSettingsSchema.safeParse({ ...base, maxPages: 10 ** 9 });
    expect(parsed.success).toBe(false);
  });
});
