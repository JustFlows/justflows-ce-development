import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_DOMAINS,
  buildNavDomains,
  canAccessPath,
  contentEditorNav,
  filterDomainsByRole,
  isDomainActive,
  navRuleFor,
  parsePluginSections,
} from "../../src/config/admin-nav";

describe("navRuleFor", () => {
  it("matches a nested route to its owning nav rule", () => {
    expect(navRuleFor("/admin/users")).toBe("/admin/users");
    expect(navRuleFor("/admin/users/some-id")).toBe("/admin/users");
    expect(navRuleFor("/admin/security/headers")).toBe("/admin/security/headers");
    expect(navRuleFor("/admin/security")).toBe("/admin/security");
  });

  it("returns null for a page with no core rule", () => {
    expect(navRuleFor("/admin/content")).toBeNull();
    expect(navRuleFor("/admin/settings")).toBeNull();
  });
});

describe("canAccessPath", () => {
  it("denies everything without a role", () => {
    expect(canAccessPath(null, "/admin/content")).toBe(false);
    expect(canAccessPath(undefined, "/admin")).toBe(false);
  });

  it("allows any admin-eligible role onto a page with no core rule", () => {
    for (const role of ["administrator", "editor", "author", "contributor"]) {
      expect(canAccessPath(role, "/admin/content")).toBe(true);
      expect(canAccessPath(role, "/admin/settings")).toBe(true);
    }
  });

  it("gates Users to administrator and editor only", () => {
    expect(canAccessPath("administrator", "/admin/users")).toBe(true);
    expect(canAccessPath("editor", "/admin/users")).toBe(true);
    expect(canAccessPath("author", "/admin/users")).toBe(false);
    expect(canAccessPath("contributor", "/admin/users")).toBe(false);
  });

  it("gates Media to everyone but a contributor", () => {
    expect(canAccessPath("author", "/admin/media")).toBe(true);
    expect(canAccessPath("contributor", "/admin/media")).toBe(false);
  });

  it("gates the admin-only sections to administrator alone", () => {
    for (const path of ["/admin/marketplace", "/admin/tools", "/admin/health", "/admin/updates", "/admin/security", "/admin/security/audit"]) {
      expect(canAccessPath("administrator", path)).toBe(true);
      expect(canAccessPath("editor", path)).toBe(false);
    }
  });

  it("leaves the Security > Account page open to every admin-eligible role", () => {
    for (const role of ["administrator", "editor", "author", "contributor"]) {
      expect(canAccessPath(role, "/admin/security/account")).toBe(true);
    }
  });
});

describe("filterDomainsByRole", () => {
  it("drops items an author can't open, and empties domains left with none", () => {
    const filtered = filterDomainsByRole(ADMIN_NAV_DOMAINS, "author");
    const paths = filtered.flatMap((d) => d.items.map((i) => i.to));

    expect(paths).toContain("/admin/content");
    expect(paths).toContain("/admin/media");
    expect(paths).not.toContain("/admin/comments");
    expect(paths).not.toContain("/admin/users");
    // Extensions domain (plugins + marketplace) has nothing an author can open.
    expect(filtered.find((d) => d.slug === "extensions")).toBeUndefined();
  });

  it("keeps every populated domain for an administrator", () => {
    const filtered = filterDomainsByRole(ADMIN_NAV_DOMAINS, "administrator");
    expect(filtered.map((d) => d.slug)).toEqual(
      ADMIN_NAV_DOMAINS.filter((d) => d.items.length > 0).map((d) => d.slug),
    );
    expect(filtered.find((d) => d.slug === "commerce")).toBeUndefined();
  });
});

describe("content editor plugin sections", () => {
  it("lists each published section instead of one plugin screen", () => {
    const nav = contentEditorNav({
      contentLabel: "Content",
      seoLabel: "SEO",
      discussionLabel: "Discussion",
      revisionsLabel: "Revisions",
      advancedLabel: "Advanced",
      pluginLabel: "Product data",
      pluginSections: [
        { id: "images", label: "Images" },
        { id: "pricing", label: "Pricing" },
      ],
    });
    expect(nav.map((item) => item.label)).toEqual([
      "Content",
      "Images",
      "Pricing",
      "SEO",
      "Discussion",
      "Revisions",
      "Advanced",
    ]);
    expect(nav.map((item) => item.id)).toContain("plugin:pricing");
  });

  it("keeps the single plugin label when the frame has not published sections", () => {
    const nav = contentEditorNav({
      contentLabel: "Content",
      seoLabel: "SEO",
      discussionLabel: "Discussion",
      revisionsLabel: "Revisions",
      advancedLabel: "Advanced",
      pluginLabel: "Product data",
    });
    expect(nav.map((item) => item.label)).toContain("Product data");
  });

  it("drops unsafe section ids and labels", () => {
    expect(
      parsePluginSections([
        { id: "images", label: "Images" },
        { id: "../x", label: "Bad" },
        { id: "pricing", label: "   " },
        { id: "images", label: "Again" },
      ]),
    ).toEqual([{ id: "images", label: "Images" }]);
  });
});

describe("buildNavDomains", () => {
  it("places a commerce plugin page in the commerce sidebar domain", () => {
    const domains = buildNavDomains([
      {
        pluginId: "justflows.shop",
        id: "shop",
        label: "Shop",
        path: "/admin/plugins/justflows.shop",
        icon: "🛍",
        domain: "commerce",
        end: true,
      },
      {
        pluginId: "justflows.shop",
        id: "products",
        label: "Products",
        path: "/admin/plugins/justflows.shop/products",
        icon: "📦",
        domain: "commerce",
      },
    ]);
    const commerce = domains.find((d) => d.slug === "commerce");
    expect(commerce?.items.map((item) => item.to)).toEqual(["/admin/plugins/justflows.shop", "/admin/plugins/justflows.shop/products"]);
    expect(commerce?.items[0]?.end).toBe(true);
    expect(filterDomainsByRole(domains, "administrator").map((d) => d.slug)).toContain("commerce");
    const shopPath = "/admin/plugins/justflows.shop";
    expect(isDomainActive(commerce!, shopPath)).toBe(true);
    expect(isDomainActive(domains.find((d) => d.slug === "extensions")!, shopPath)).toBe(false);
  });

  it("keeps an unknown plugin domain out of a new sidebar group", () => {
    const domains = buildNavDomains([
      {
        pluginId: "acme.seo",
        id: "reports",
        label: "Reports",
        path: "/admin/reports",
        icon: "📊",
        domain: "made-up",
      },
    ]);
    expect(domains.find((d) => d.slug === "made-up")).toBeUndefined();
    expect(
      domains.find((d) => d.slug === "extensions")?.items.map((item) => item.to),
    ).toContain("/admin/reports");
  });
});
