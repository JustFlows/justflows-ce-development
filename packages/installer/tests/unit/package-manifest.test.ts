import { describe, expect, it } from "vitest";
import { PackageManifestSchema } from "../../src/package-manifest.js";

const base = {
  schemaVersion: 1 as const,
  type: "plugin" as const,
  id: "justflows.plugin",
  name: "Test",
  version: "1.0.0",
  publisher: "Test",
  license: "GPL-2.0-or-later",
};

const menuItem = {
  id: "reports",
  label: "Reports",
  labelKey: "nav.reports",
  path: "reports",
  icon: "📊",
  domain: "extensions" as const,
};

describe("PackageManifestSchema adminMenu", () => {
  it("resolves a relative admin path against the plugin namespace on install", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      permissions: ["admin:extend"],
      adminMenu: [menuItem, { id: "root", label: "Root" }],
    });

    expect(parsed.adminMenu?.[0]?.path).toBe("/admin/plugins/justflows.plugin/reports");
    expect(parsed.adminMenu?.[1]?.path).toBe("/admin/plugins/justflows.plugin");
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

  it("rejects an absolute menu path", () => {
    const result = PackageManifestSchema.safeParse({
      ...base,
      permissions: ["admin:extend"],
      adminMenu: [{ ...menuItem, path: "/admin/plugins/justflows.plugin/reports" }],
    });

    expect(result.success).toBe(false);
  });
});

describe("PackageManifestSchema adminApp", () => {
  it("keeps a declared admin app and resolves its route path on install", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      permissions: ["admin:extend"],
      adminApp: { locales: { en: "locales/en.json" }, routes: [{ entry: "index.html", title: "Forms" }] },
    });

    expect(parsed.adminApp?.routes?.[0]?.entry).toBe("index.html");
    expect(parsed.adminApp?.routes?.[0]?.path).toBe("/admin/plugins/justflows.plugin");
  });

  it("rejects an admin app without the admin:extend permission", () => {
    const result = PackageManifestSchema.safeParse({
      ...base,
      adminApp: { routes: [{ path: "submissions", entry: "index.html" }] },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "adminApp")).toBe(true);
  });

  it("rejects a non-html entry", () => {
    const result = PackageManifestSchema.safeParse({
      ...base,
      permissions: ["admin:extend"],
      adminApp: { routes: [{ path: "submissions", entry: "app.js" }] },
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

describe("PackageManifestSchema engines", () => {
  it("keeps the canonical Justflows compatibility range", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      engines: { justflows: ">=0.1.8 <0.2.0" },
    });
    expect(parsed.engines?.justflows).toBe(">=0.1.8 <0.2.0");
  });

  it("rejects an empty Justflows compatibility range", () => {
    expect(PackageManifestSchema.safeParse({ ...base, engines: { justflows: "" } }).success).toBe(
      false,
    );
  });
});

describe("PackageManifestSchema theme patterns", () => {
  it("keeps safe theme pattern registrations", () => {
    const parsed = PackageManifestSchema.parse({
      ...base,
      type: "theme",
      patterns: { hero: "./patterns/hero.json" },
    });
    expect(parsed.patterns).toEqual({ hero: "./patterns/hero.json" });
  });

  it("rejects pattern registrations on plugins and unsafe paths", () => {
    expect(
      PackageManifestSchema.safeParse({ ...base, patterns: { hero: "./patterns/hero.json" } })
        .success,
    ).toBe(false);
    expect(
      PackageManifestSchema.safeParse({
        ...base,
        type: "theme",
        patterns: { hero: "../hero.json" },
      }).success,
    ).toBe(false);
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
