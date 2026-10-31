import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_DOMAINS,
  buildNavDomains,
  canAccessPath,
  contentEditorNav,
  filterDomainsByRole,
  isDomainActive,
  localizedLabel,
  navLabel,
  navRuleFor,
  pluginPageRoles,
  pluginSectionSlug,
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

  it("hides an admin path when the website turned that feature off", () => {
    expect(canAccessPath("administrator", "/admin/comments", { disabledPaths: ["/admin/comments"] })).toBe(false);
    expect(canAccessPath("administrator", "/admin/security/account", { disabledPaths: ["/admin/security/headers"] })).toBe(true);
    expect(canAccessPath("administrator", "/admin/security/headers", { disabledPaths: ["/admin/security/headers"] })).toBe(false);
  });

  it("leaves the Security > Account page open to every admin-eligible role", () => {
    for (const role of ["administrator", "editor", "author", "contributor"]) {
      expect(canAccessPath(role, "/admin/security/account")).toBe(true);
    }
  });

  it("hides installation pages from a site that is not the main site", () => {
    const site = { installationRoot: false, platformOperator: false };
    expect(canAccessPath("administrator", "/admin/updates", site)).toBe(false);
    expect(canAccessPath("administrator", "/admin/health", site)).toBe(false);
    expect(canAccessPath("administrator", "/admin/marketplace", site)).toBe(false);
    expect(canAccessPath("administrator", "/admin/marketplace", { installationRoot: true })).toBe(true);
    expect(canAccessPath("administrator", "/admin/platform", site)).toBe(false);
    expect(canAccessPath("administrator", "/admin/platform/sites/site-a", site)).toBe(false);
    expect(canAccessPath("administrator", "/admin/platform/sites/site-a", { installationRoot: true, platformOperator: true })).toBe(true);
    expect(canAccessPath("administrator", "/admin/settings", site)).toBe(true);
    expect(canAccessPath("administrator", "/admin/tools", site)).toBe(true);
    expect(canAccessPath("administrator", "/admin/security/account", site)).toBe(true);
    const filtered = filterDomainsByRole(ADMIN_NAV_DOMAINS, "administrator", site);
    const paths = filtered.flatMap((domain) => domain.items.map((item) => item.to));
    expect(paths).not.toContain("/admin/updates");
    expect(paths).not.toContain("/admin/health");
    expect(paths).not.toContain("/admin/security/web-server");
    expect(paths).not.toContain("/admin/security/integrity");
    expect(paths).not.toContain("/admin/marketplace");
    expect(paths).not.toContain("/admin/platform/workspaces");
    expect(paths).not.toContain("/admin/platform/sites");
    expect(paths).not.toContain("/admin/platform/defaults");
    expect(paths).toContain("/admin/tools");
    expect(paths).toContain("/admin/settings");
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
      discussionLabel: "Discussion",
      revisionsLabel: "Revisions",
      advancedLabel: "Advanced",
      pluginLabel: "Product data",
      pluginSections: [
        { id: "images", label: "Images" },
        { id: "pricing", label: "Pricing" },
      ],
      panels: [{ id: "panel:justflows.seo:seo", label: "SEO" }],
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
      discussionLabel: "Discussion",
      revisionsLabel: "Revisions",
      advancedLabel: "Advanced",
      pluginLabel: "Product data",
    });
    expect(nav.map((item) => item.label)).toContain("Product data");
  });

  it("picks a panel label in the admin language", () => {
    const label = { en: "SEO", nl: "Zoekmachines" };
    expect(localizedLabel(label, "nl")).toBe("Zoekmachines");
    expect(localizedLabel(label, "nl-BE")).toBe("Zoekmachines");
    expect(localizedLabel(label, "de")).toBe("SEO");
    expect(localizedLabel("Plain", "de")).toBe("Plain");
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

  it("gives Helpdesk its own sidebar domain instead of an Extensions tab", () => {
    const domains = buildNavDomains([
      {
        pluginId: "justflows.helpdesk",
        id: "inbox",
        label: "Helpdesk",
        path: "/admin/plugins/justflows.helpdesk",
        icon: "💬",
        domain: "helpdesk",
        end: true,
      },
    ]);
    const helpdesk = domains.find((d) => d.slug === "helpdesk");
    expect(helpdesk?.items.map((item) => item.to)).toEqual(["/admin/plugins/justflows.helpdesk"]);
    expect(domains.find((d) => d.slug === "extensions")?.items.some((item) => item.to.includes("helpdesk"))).toBe(false);
  });

  it("lets a plugin page name the roles that may open it", () => {
    const items = [
      {
        pluginId: "justflows.helpdesk",
        id: "inbox",
        label: "Helpdesk",
        path: "/admin/plugins/justflows.helpdesk",
        icon: "💬",
        domain: "helpdesk",
        roles: ["administrator", "editor", "support-agent"],
      },
    ];
    const audience = { pluginPageRoles: pluginPageRoles(items) };
    expect(canAccessPath("support-agent", "/admin/plugins/justflows.helpdesk/tickets/7", audience)).toBe(true);
    expect(canAccessPath("author", "/admin/plugins/justflows.helpdesk", audience)).toBe(false);
    /** Without declared roles the page keeps the plugin-page rule. */
    expect(canAccessPath("support-agent", "/admin/plugins/justflows.helpdesk")).toBe(false);
    expect(canAccessPath("editor", "/admin/plugins/justflows.forms", audience)).toBe(true);
  });

  it("gives a plugin in the plugin domain its own section above Extensions", () => {
    const section = { label: "Acme", labels: { nl: "Acme NL" }, icon: "/ext/justflows.acme/admin/logo.png" };
    const domains = buildNavDomains([
      {
        pluginId: "justflows.acme",
        id: "overview",
        label: "Acme",
        path: "/admin/plugins/justflows.acme",
        icon: "⚡",
        domain: "plugin",
        end: true,
        section,
      },
      {
        pluginId: "justflows.acme",
        id: "connect",
        label: "Connection",
        path: "/admin/plugins/justflows.acme/connect",
        icon: "🔗",
        domain: "plugin",
        section,
      },
      {
        pluginId: "justflows.forms",
        id: "forms",
        label: "Forms",
        path: "/admin/plugins/justflows.forms",
        icon: "forms",
        domain: "extensions",
      },
    ]);
    const slugs = domains.map((d) => d.slug);
    expect(slugs.indexOf(pluginSectionSlug("justflows.acme"))).toBe(slugs.indexOf("extensions") - 1);
    const acme = domains.find((d) => d.slug === pluginSectionSlug("justflows.acme"));
    expect(acme?.icon).toBe("/ext/justflows.acme/admin/logo.png");
    expect(acme ? navLabel((key) => key, acme, "nl") : "").toBe("Acme NL");
    expect(acme ? navLabel((key) => key, acme, "en") : "").toBe("Acme");
    expect(acme?.items.map((item) => item.to)).toEqual([
      "/admin/plugins/justflows.acme",
      "/admin/plugins/justflows.acme/connect",
    ]);
    const extensions = domains.find((d) => d.slug === "extensions")?.items.map((item) => item.to) ?? [];
    expect(extensions.some((path) => path.includes("justflows.acme"))).toBe(false);
    expect(extensions).toContain("/admin/plugins/justflows.forms");
  });

  it("puts a plugin domain page without a section under Extensions", () => {
    const domains = buildNavDomains([
      { pluginId: "justflows.acme", id: "overview", label: "Acme", path: "/admin/plugins/justflows.acme", icon: "⚡", domain: "plugin" },
    ]);
    expect(domains.find((d) => d.slug === "extensions")?.items.map((item) => item.to)).toContain("/admin/plugins/justflows.acme");
    expect(domains.some((d) => d.slug.startsWith("plugin:"))).toBe(false);
  });

  it("gives Shared files its own sidebar domain instead of a Plugins tab", () => {
    const domains = buildNavDomains([
      {
        pluginId: "justflows.shared-files",
        id: "files",
        label: "Shared files",
        path: "/admin/plugins/justflows.shared-files",
        icon: "files",
        domain: "files",
        end: true,
      },
    ]);
    const files = domains.find((d) => d.slug === "files");
    expect(files?.items).toHaveLength(1);
    expect(files?.items[0]?.to).toBe("/admin/plugins/justflows.shared-files");
    expect(domains.find((d) => d.slug === "extensions")?.items.some((item) => item.to.includes("shared-files"))).toBe(false);
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


describe("security feature navigation", () => {
  it("hides header pages while keeping the Security Center and account security", () => {
    const audience = { installationRoot: false, disabledPaths: [
      "/admin/security/headers", "/admin/security/header-grade", "/admin/security/advanced",
      "/admin/security/admin-path", "/admin/security/audit",
    ] };
    expect(canAccessPath("administrator", "/admin/security", audience)).toBe(true);
    expect(canAccessPath("administrator", "/admin/security/header-grade", audience)).toBe(false);
    expect(canAccessPath("administrator", "/admin/security/account", audience)).toBe(true);
    const security = filterDomainsByRole(ADMIN_NAV_DOMAINS, "administrator", audience)
      .find((domain) => domain.slug === "security");
    expect(security?.items.map((item) => item.to)).toEqual(["/admin/security", "/admin/security/account"]);
  });

  it("keeps overview when headers are allowed", () => {
    expect(canAccessPath("administrator", "/admin/security", { disabledPaths: [] })).toBe(true);
    expect(filterDomainsByRole(ADMIN_NAV_DOMAINS, "administrator", { disabledPaths: [] })
      .find((domain) => domain.slug === "security")?.items[0]?.to).toBe("/admin/security");
  });
});

describe("navLabel", () => {
  const t = (key: string) => (key === "nav.forms" ? "Formulieren (core)" : key);
  const item = {
    key: "nav.forms",
    label: "Forms",
    labels: { nl: "Formulieren", "pt-BR": "Formulários" },
    to: "/admin/plugins/justflows.forms",
    icon: "✉",
  };

  it("prefers the plugin's own label for the admin locale", () => {
    expect(navLabel(t, item, "nl")).toBe("Formulieren");
    expect(navLabel(t, item, "nl-BE")).toBe("Formulieren");
  });

  it("falls back to the core catalog, then the English label", () => {
    expect(navLabel(t, item, "de")).toBe("Formulieren (core)");
    expect(navLabel((key) => key, { ...item, key: "plugin.justflows.forms.forms" }, "de")).toBe("Forms");
  });
});
