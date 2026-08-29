import { describe, expect, it } from "vitest";
import { PackageManifestSchema } from "./package-manifest.js";

const base = {
  schemaVersion: 1 as const,
  type: "plugin" as const,
  id: "test.plugin",
  name: "Test",
  version: "1.0.0",
  publisher: "Test",
  license: "GPL-2.0-or-later",
};

const menuItem = {
  id: "reports",
  label: "Reports",
  labelKey: "nav.reports",
  path: "/admin/reports",
  icon: "📊",
  domain: "extensions" as const,
};

describe("PackageManifestSchema adminMenu", () => {
  it("keeps declared admin pages so they survive install", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      permissions: ["admin:extend"],
      adminMenu: [menuItem],
    });

    expect(parsed.adminMenu).toEqual([menuItem]);
  });

  it("keeps contentType on an admin page so the host can list those CMS entries", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      permissions: ["admin:extend"],
      adminMenu: [{ ...menuItem, contentType: "product" }],
    });

    expect(parsed.adminMenu?.[0]?.contentType).toBe("product");
  });

  it("rejects admin pages without the admin:extend permission", () => {
    const result = PackageManifestSchema.safeParse({ ...base, adminMenu: [menuItem] });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "adminMenu")).toBe(true);
  });

  it("rejects a menu path outside /admin/", () => {
    const result = PackageManifestSchema.safeParse({
      ...base,
      permissions: ["admin:extend"],
      adminMenu: [{ ...menuItem, path: "/wp-admin/reports" }],
    });

    expect(result.success).toBe(false);
  });
});

describe("PackageManifestSchema version", () => {
  it("accepts plain and prerelease semver", () => {
    for (const version of ["1.0.0", "0.1.3-rc", "1.2.3-beta.1", "10.20.30+build.5"]) {
      expect(PackageManifestSchema.safeParse({ ...base, version }).success).toBe(true);
    }
  });

  // The pattern used to be anchored only at the start, so everything after the
  // patch number was unconstrained — and the installer joins this value into the
  // destination path.
  it("rejects a version carrying path traversal", () => {
    const result = PackageManifestSchema.safeParse({
      ...base,
      version: "1.0.0/../../../../../../tmp/pwned",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "version")).toBe(true);
  });

  it("rejects trailing junk after the patch number", () => {
    for (const version of ["1.0.0/etc", "1.0.0\\..\\..", "1.0.0 ", "1.0.0../x"]) {
      expect(PackageManifestSchema.safeParse({ ...base, version }).success).toBe(false);
    }
  });
});

describe("PackageManifestSchema registry", () => {
  it("defaults a free listed listing when registry is omitted", () => {
    const parsed = PackageManifestSchema.parse(base);
    expect(parsed.registry).toBeUndefined();
  });

  it("keeps commercial, visibility, and paid price", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      registry: {
        commercialMarketplace: true,
        listed: false,
        free: false,
        price: { amount: 49, currency: "EUR", interval: "year" },
      },
    });
    expect(parsed.registry).toMatchObject({
      commercialMarketplace: true,
      listed: false,
      free: false,
      comingSoon: false,
      price: { amount: 49, currency: "EUR", interval: "year" },
    });
  });

  it("keeps a comingSoon listing visible but not installable", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      registry: {
        commercialMarketplace: false,
        listed: true,
        free: true,
        comingSoon: true,
      },
    });
    expect(parsed.registry).toMatchObject({ comingSoon: true, listed: true, free: true });
  });

  it("keeps declared CMS content types", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      permissions: ["content:delete"],
      contentTypes: ["product", "shop"],
    });
    expect(parsed.contentTypes).toEqual(["product", "shop"]);
  });

  it("rejects a paid listing without a price", () => {
    const result = PackageManifestSchema.safeParse({
      ...base,
      registry: { free: false },
    });
    expect(result.success).toBe(false);
  });
});
