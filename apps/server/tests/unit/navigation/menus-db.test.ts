// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    query: async () => [],
    run: async () => {},
    close: async () => {},
  }),
  resetDb: () => {},
}));

vi.mock("../../../src/lib/i18n/languages-db.js", () => ({
  getActiveLocaleCodes: async () => ["en", "nl"],
}));

const hookState: {
  handlers: Record<string, Array<(...args: unknown[]) => unknown>>;
} = { handlers: {} };

vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  ensurePluginRuntime: async () => {},
  getRuntimeHooks: () => ({
    has: (name: string) => Boolean(hookState.handlers[name]?.length),
    applyFilter: async (name: string, value: unknown, ctx: unknown) => {
      let current = value;
      for (const handler of hookState.handlers[name] ?? []) {
        current = await handler(current, ctx);
      }
      return current;
    },
  }),
}));

const {
  resolveMenuItems,
  getEffectiveMenuItems,
  getEffectiveMenuDesign,
  validateMenuTreeShape,
  MenuTreeShapeError,
  sanitizeMegaMenuRegions,
  menuHasVisibilityRules,
  DEFAULT_MENU_DESIGN,
  parseMenuDesign,
} = await import("../../../src/lib/navigation/menus-db.js");

describe("resolveMenuItems visibility", () => {
  beforeEach(() => {
    hookState.handlers = {};
  });

  it("hides an authenticated-only item from a guest and shows it to a signed-in visitor", async () => {
    const items = [
      { id: "1", label: "Members", type: "custom", url: "/members", visibility: { auth: "authenticated" as const } },
      { id: "2", label: "Home", type: "custom", url: "/" },
    ];

    const guestView = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "guest" },
    });
    expect(guestView.map((i) => i.id)).toEqual(["2"]);

    const memberView = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "authenticated" },
    });
    expect(memberView.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("hides a guest-only item from a signed-in visitor", async () => {
    const items = [
      { id: "1", label: "Log in", type: "custom", url: "/login", visibility: { auth: "guest" as const } },
    ];
    const result = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "authenticated" },
    });
    expect(result).toEqual([]);
  });

  it("enforces a role gate and requires an exact role match", async () => {
    const items = [
      { id: "1", label: "Admin tools", type: "custom", url: "/tools", visibility: { roles: ["administrator" as const] } },
    ];
    const asEditor = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "authenticated", role: "editor" },
    });
    expect(asEditor).toEqual([]);

    const asAdmin = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "authenticated", role: "administrator" },
    });
    expect(asAdmin.map((i) => i.id)).toEqual(["1"]);
  });

  it("opens a role gate for an additional role, such as a plugin's membership role", async () => {
    const items = [{ id: "1", label: "Publisher docs", type: "custom", url: "/publishers", visibility: { roles: ["publisher"] } }];
    const member = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "authenticated", role: "subscriber", roles: ["subscriber"] },
    });
    expect(member).toEqual([]);
    const publisher = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "authenticated", role: "subscriber", roles: ["subscriber", "publisher"] },
    });
    expect(publisher.map((i) => i.id)).toEqual(["1"]);
  });

  it("enforces a locale gate", async () => {
    const items = [
      { id: "1", label: "NL only", type: "custom", url: "/nl-page", visibility: { locales: ["nl"] } },
    ];
    expect(await resolveMenuItems(items, "en", "en")).toEqual([]);
    const nl = await resolveMenuItems(items, "nl", "en");
    expect(nl.map((i) => i.id)).toEqual(["1"]);
  });

  it("drops an entire subtree when the parent fails a visibility check", async () => {
    const items = [
      {
        id: "1",
        label: "Members",
        type: "custom",
        url: "/members",
        visibility: { auth: "authenticated" as const },
        children: [{ id: "1a", label: "Child", type: "custom", url: "/members/child" }],
      },
    ];
    const result = await resolveMenuItems(items, "en", "en", false, {
      visibility: { authState: "guest" },
    });
    expect(result).toEqual([]);
  });

  it("denies by default when a plugin condition is not recognized by any handler", async () => {
    const items = [
      {
        id: "1",
        label: "Tier gated",
        type: "custom",
        url: "/vip",
        visibility: { condition: { id: "acme.shop:tier" } },
      },
    ];
    const result = await resolveMenuItems(items, "en", "en");
    expect(result).toEqual([]);
  });

  it("shows an item when a plugin's menu.visibility.evaluate handler allows it", async () => {
    hookState.handlers["menu.visibility.evaluate"] = [
      (allowed: unknown, ctx: unknown) => {
        const { condition } = ctx as { condition: { id: string } };
        return condition.id === "acme.shop:tier" ? true : allowed;
      },
    ];
    const items = [
      {
        id: "1",
        label: "Tier gated",
        type: "custom",
        url: "/vip",
        visibility: { condition: { id: "acme.shop:tier" } },
      },
    ];
    const result = await resolveMenuItems(items, "en", "en");
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });

  it("always adds noopener noreferrer for target=_blank regardless of author-supplied rel", async () => {
    const items = [
      { id: "1", label: "Ext", type: "custom", url: "https://example.com", target: "_blank" as const, rel: "sponsored noopener" },
    ];
    const result = await resolveMenuItems(items, "en", "en");
    expect(result[0]?.rel).toBe("noopener noreferrer sponsored");
  });
});

describe("draft/publish precedence", () => {
  const base = {
    id: "m1",
    site_id: "s1",
    slug: "primary",
    name: "Primary",
    items: [{ id: "1", label: "Published", type: "custom" as const }],
    design: { ...DEFAULT_MENU_DESIGN },
    schemaVersion: 1,
  };

  it("prefers the draft only when previewing and a draft exists", () => {
    const withDraft = {
      ...base,
      draftItems: [{ id: "2", label: "Draft", type: "custom" as const }],
      draftDesign: { ...DEFAULT_MENU_DESIGN, layout: "mega" as const },
    };
    expect(getEffectiveMenuItems(withDraft, true).map((i) => i.label)).toEqual(["Draft"]);
    expect(getEffectiveMenuItems(withDraft, false).map((i) => i.label)).toEqual(["Published"]);
    expect(getEffectiveMenuDesign(withDraft, true).layout).toBe("mega");
    expect(getEffectiveMenuDesign(withDraft, false).layout).toBe("horizontal");
  });

  it("falls back to published when there is no draft", () => {
    const withoutDraft = { ...base, draftItems: null, draftDesign: null };
    expect(getEffectiveMenuItems(withoutDraft, true).map((i) => i.label)).toEqual(["Published"]);
  });
});

describe("validateMenuTreeShape", () => {
  it("throws when nesting exceeds the design's maxDepth", () => {
    const items = [{ id: "1", label: "A", type: "custom", children: [{ id: "2", label: "B", type: "custom", children: [{ id: "3", label: "C", type: "custom" }] }] }];
    expect(() => validateMenuTreeShape(items, { ...DEFAULT_MENU_DESIGN, maxDepth: 2 })).toThrow(MenuTreeShapeError);
    expect(() => validateMenuTreeShape(items, { ...DEFAULT_MENU_DESIGN, maxDepth: 3 })).not.toThrow();
  });

  it("throws when a level exceeds maxItemsPerLevel", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: "x", type: "custom" }));
    expect(() => validateMenuTreeShape(items, { ...DEFAULT_MENU_DESIGN, maxItemsPerLevel: 4 })).toThrow(MenuTreeShapeError);
  });

  it("never allows a design to exceed the hard cap", () => {
    const items = [{ id: "1", label: "A", type: "custom", children: [{ id: "2", label: "B", type: "custom", children: [{ id: "3", label: "C", type: "custom", children: [{ id: "4", label: "D", type: "custom", children: [{ id: "5", label: "E", type: "custom" }] }] }] }] }];
    expect(() => validateMenuTreeShape(items, { ...DEFAULT_MENU_DESIGN, maxDepth: 99 })).toThrow(MenuTreeShapeError);
  });
});

describe("sanitizeMegaMenuRegions", () => {
  it("keeps allowed block kinds and drops disallowed ones (e.g. core.html)", () => {
    const regions = sanitizeMegaMenuRegions([
      {
        id: "r1",
        heading: "Featured",
        blocks: [
          { id: "b1", type: "core.paragraph", version: 1, props: { text: "hi" } },
          { id: "b2", type: "core.html", version: 1, props: { html: "<script>evil()</script>" } },
        ],
      },
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.blocks.map((b) => b.type)).toEqual(["core.paragraph"]);
  });

  it("caps the number of regions", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, blocks: [] }));
    expect(sanitizeMegaMenuRegions(many).length).toBeLessThanOrEqual(6);
  });
});

describe("menuHasVisibilityRules", () => {
  it("detects a security-sensitive rule anywhere in the tree", () => {
    expect(menuHasVisibilityRules([{ id: "1", label: "x", type: "custom" }])).toBe(false);
    expect(
      menuHasVisibilityRules([
        { id: "1", label: "x", type: "custom", children: [{ id: "2", label: "y", type: "custom", visibility: { auth: "authenticated" } }] },
      ]),
    ).toBe(true);
  });

  it("does not flag a device-only (presentation) visibility rule", () => {
    expect(
      menuHasVisibilityRules([{ id: "1", label: "x", type: "custom", visibility: { devices: ["mobile"] } }]),
    ).toBe(false);
  });
});

describe("parseMenuDesign", () => {
  it("returns the defaults for empty/malformed input", () => {
    expect(parseMenuDesign(null)).toEqual(DEFAULT_MENU_DESIGN);
    expect(parseMenuDesign("not json")).toEqual(DEFAULT_MENU_DESIGN);
    expect(parseMenuDesign({})).toEqual(DEFAULT_MENU_DESIGN);
  });

  it("clamps maxDepth to the hard cap even if the stored value is larger", () => {
    expect(parseMenuDesign({ maxDepth: 999 }).maxDepth).toBeLessThanOrEqual(4);
  });

  it("migrates the legacy 'drawer' mobile pattern and rejects unknown values", () => {
    expect(parseMenuDesign({ mobilePattern: "drawer" }).mobilePattern).toBe("drawer-right");
    expect(parseMenuDesign({ mobilePattern: "drawer-left" }).mobilePattern).toBe("drawer-left");
    expect(parseMenuDesign({ mobilePattern: "fullscreen" }).mobilePattern).toBe("fullscreen");
    expect(parseMenuDesign({ mobilePattern: "sideswipe" }).mobilePattern).toBe(DEFAULT_MENU_DESIGN.mobilePattern);
  });
});
