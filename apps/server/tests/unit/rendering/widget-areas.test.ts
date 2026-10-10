import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, { doc: unknown; draft: unknown }>();
const themeAreas: Array<{ key: string; label: string; description?: string }> = [];
const themeDefaults = new Map<string, unknown[]>();
let pluginFilter: (areas: unknown[]) => unknown[] = (areas) => areas;

vi.mock("../../../src/lib/rendering/template-parts-db.js", () => ({
  getTemplatePartDocs: async (_siteId: string, part: string) => {
    const row = rows.get(part);
    return { doc: row?.doc ?? null, draft: row?.draft ?? null };
  },
  saveTemplatePartDraft: async (_siteId: string, part: string, doc: unknown) => {
    rows.set(part, { doc: rows.get(part)?.doc ?? {}, draft: doc });
  },
  saveTemplatePartPublished: async (_siteId: string, part: string, doc: unknown) => {
    rows.set(part, { doc, draft: rows.get(part)?.draft ?? null });
  },
  publishTemplatePartDoc: async (_siteId: string, part: string, doc: unknown) => {
    rows.set(part, { doc, draft: null });
  },
  clearTemplatePartDraftDoc: async (_siteId: string, part: string) => {
    const row = rows.get(part);
    if (row) row.draft = null;
  },
}));

vi.mock("../../../src/lib/themes/themes-db.js", () => ({
  getActiveTheme: async () => ({ theme_id: "acme.theme" }),
  themeInstalledPath: () => null,
}));

vi.mock("../../../src/lib/themes/theme-files.js", () => ({
  loadThemeWidgetAreas: () => themeAreas,
  loadThemeWidgetDefault: (_theme: string, key: string) => themeDefaults.get(key) ?? null,
}));

vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  ensurePluginRuntime: async () => {},
  getRuntimeHooks: () => ({
    applyFilter: async (_name: string, value: unknown[]) => pluginFilter(value),
  }),
}));

import {
  blocksPlaceWidgetArea,
  getWidgetAreaDocs,
  layoutForContentType,
  listWidgetAreas,
  normalizeWidgetAreaDoc,
  normalizeWidgetLayout,
  readWidgetAreaForEditor,
  resolveWidgetAreaBlocks,
  saveWidgetAreaDoc,
  saveWidgetLayout,
  getWidgetLayout,
  widgetAreaHtml,
  withWidgetLayout,
  type WidgetArea,
} from "../../../src/lib/rendering/widget-areas.js";

const SITE = "11111111-1111-4111-8111-111111111111";

function text(id: string, value: string) {
  return { id, type: "core.paragraph", version: 1, props: { text: value } };
}

function area(overrides: Partial<WidgetArea> = {}): WidgetArea {
  return { key: "sidebar", label: "Sidebar", source: "core", defaultBlocks: [], ...overrides };
}

beforeEach(() => {
  rows.clear();
  themeAreas.length = 0;
  themeDefaults.clear();
  pluginFilter = (areas) => areas;
});

describe("listWidgetAreas", () => {
  it("always offers the core sidebar", async () => {
    const areas = await listWidgetAreas(SITE);
    expect(areas.map((row) => [row.key, row.source])).toEqual([["sidebar", "core"]]);
  });

  it("adds theme areas, lets a theme relabel the sidebar, and reads theme defaults", async () => {
    themeAreas.push({ key: "sidebar", label: "Blog sidebar" }, { key: "footer-1", label: "Footer column" });
    themeDefaults.set("footer-1", [text("a", "Hi")]);
    const areas = await listWidgetAreas(SITE);
    expect(areas.map((row) => [row.key, row.label, row.source])).toEqual([
      ["sidebar", "Blog sidebar", "core"],
      ["footer-1", "Footer column", "theme"],
    ]);
    expect(areas[1]!.defaultBlocks).toHaveLength(1);
  });

  it("adds plugin areas and drops invalid or duplicate ones", async () => {
    pluginFilter = (areas) => [
      ...areas,
      {
        key: "shop-sidebar",
        label: "Shop sidebar",
        defaultLayout: { contentTypes: ["shop", "Bad Type"], position: "left" },
      },
      { key: "shop-sidebar", label: "Duplicate" },
      { key: "Not Valid", label: "Nope" },
      { key: "no-label", label: "" },
      { key: "x".repeat(33), label: "Too long" },
    ];
    const areas = await listWidgetAreas(SITE);
    expect(areas.map((row) => row.key)).toEqual(["sidebar", "shop-sidebar"]);
    expect(areas[1]).toMatchObject({
      source: "plugin",
      label: "Shop sidebar",
      defaultLayout: { contentTypes: ["shop"], position: "left" },
    });
  });

  it("keeps a plugin area's default blocks", async () => {
    const filters = {
      id: "shop-sidebar-filters",
      type: "justflows.shop.product-filters",
      version: 1,
      props: { search: true, filterStyle: "dropdown" },
    };
    pluginFilter = (areas) => [...areas, { key: "shop-sidebar", label: "Shop sidebar", defaultBlocks: [filters] }];
    const shop = (await listWidgetAreas(SITE)).find((row) => row.key === "shop-sidebar");
    expect(shop?.defaultBlocks).toEqual([expect.objectContaining({ type: "justflows.shop.product-filters" })]);
    const found = await readWidgetAreaForEditor(SITE, "shop-sidebar");
    expect(found?.doc.blocks).toHaveLength(1);
  });

  it("falls back to core and theme areas when a filter returns garbage", async () => {
    pluginFilter = () => "nope" as unknown as unknown[];
    expect((await listWidgetAreas(SITE)).map((row) => row.key)).toEqual(["sidebar"]);
  });
});

describe("area documents", () => {
  it("keeps base blocks and valid locale overrides only", () => {
    const doc = normalizeWidgetAreaDoc({
      blocks: [text("a", "base")],
      locales: { "nl-NL": [text("b", "nl")], "../x": [text("c", "bad")], fr: "nope" },
    });
    expect(doc.blocks).toHaveLength(1);
    expect(Object.keys(doc.locales)).toEqual(["nl-NL"]);
  });

  it("treats a draft-only row as never published", async () => {
    await saveWidgetAreaDoc(SITE, "sidebar", { blocks: [text("a", "draft")] }, "draft");
    const docs = await getWidgetAreaDocs(SITE, "sidebar");
    expect(docs.doc).toBeNull();
    expect(docs.draft?.blocks).toHaveLength(1);
  });

  it("publishing drops the draft", async () => {
    await saveWidgetAreaDoc(SITE, "sidebar", { blocks: [text("a", "draft")] }, "draft");
    await saveWidgetAreaDoc(SITE, "sidebar", { blocks: [text("a", "live")] }, "publish");
    const docs = await getWidgetAreaDocs(SITE, "sidebar");
    expect(docs.draft).toBeNull();
    expect(docs.doc?.blocks[0]?.props).toMatchObject({ text: "live" });
  });

  it("rejects a malformed key", async () => {
    await expect(saveWidgetAreaDoc(SITE, "../evil", { blocks: [] }, "publish")).rejects.toThrow();
  });
});

describe("resolveWidgetAreaBlocks", () => {
  it("shows the default until the area is saved", async () => {
    const blocks = await resolveWidgetAreaBlocks(SITE, area({ defaultBlocks: [text("d", "default")] }), "en");
    expect(blocks[0]?.props).toMatchObject({ text: "default" });
  });

  it("uses a locale override when there is one, else the base blocks", async () => {
    await saveWidgetAreaDoc(
      SITE,
      "sidebar",
      { blocks: [text("a", "base")], locales: { nl: [text("b", "nl")] } },
      "publish",
    );
    expect((await resolveWidgetAreaBlocks(SITE, area(), "nl"))[0]?.props).toMatchObject({ text: "nl" });
    expect((await resolveWidgetAreaBlocks(SITE, area(), "de"))[0]?.props).toMatchObject({ text: "base" });
  });

  it("an empty saved area stays empty instead of showing the default", async () => {
    await saveWidgetAreaDoc(SITE, "sidebar", { blocks: [] }, "publish");
    expect(await resolveWidgetAreaBlocks(SITE, area({ defaultBlocks: [text("d", "default")] }), "en")).toEqual([]);
  });

  it("previews the draft", async () => {
    await saveWidgetAreaDoc(SITE, "sidebar", { blocks: [text("a", "live")] }, "publish");
    await saveWidgetAreaDoc(SITE, "sidebar", { blocks: [text("a", "draft")] }, "draft");
    expect((await resolveWidgetAreaBlocks(SITE, area(), "en", true))[0]?.props).toMatchObject({ text: "draft" });
    expect((await resolveWidgetAreaBlocks(SITE, area(), "en", false))[0]?.props).toMatchObject({ text: "live" });
  });
});

describe("widget layout", () => {
  const shop = area({
    key: "shop-sidebar",
    label: "Shop sidebar",
    source: "plugin",
    defaultLayout: { contentTypes: ["shop"], position: "left" },
  });

  it("drops bad types, areas, and positions", () => {
    expect(
      normalizeWidgetLayout({
        types: {
          post: { area: "sidebar", position: "left" },
          page: { area: null, position: "middle" },
          "Bad Type": { area: "sidebar", position: "left" },
          product: { area: "../x", position: "top" },
        },
      }),
    ).toEqual({
      post: { area: "sidebar", position: "left" },
      page: { area: null, position: "right" },
      product: { area: null, position: "top" },
    });
  });

  it("saves and reads rules", async () => {
    await saveWidgetLayout(SITE, { post: { area: "sidebar", position: "right" } });
    expect(await getWidgetLayout(SITE)).toEqual({ post: { area: "sidebar", position: "right" } });
  });

  it("uses a saved rule over an area default", () => {
    const rules = { shop: { area: "sidebar", position: "right" as const } };
    expect(layoutForContentType("shop", [area(), shop], rules)).toMatchObject({
      area: { key: "sidebar" },
      position: "right",
    });
  });

  it("falls back to the area default, and to nothing", () => {
    expect(layoutForContentType("shop", [area(), shop], {})).toMatchObject({
      area: { key: "shop-sidebar" },
      position: "left",
    });
    expect(layoutForContentType("post", [area(), shop], {})).toBeNull();
  });

  it("an explicit none or a missing area shows nothing", () => {
    expect(layoutForContentType("shop", [shop], { shop: { area: null, position: "left" } })).toBeNull();
    expect(layoutForContentType("post", [shop], { post: { area: "gone", position: "left" } })).toBeNull();
  });
});

describe("markup", () => {
  it("wraps content with the area after it in the source", () => {
    const html = withWidgetLayout("<p>body</p>", "left", widgetAreaHtml(area(), "<p>w</p>"));
    expect(html).toContain('class="jf-widget-layout jf-widget-layout--left"');
    expect(html.indexOf("<p>body</p>")).toBeLessThan(html.indexOf("<p>w</p>"));
    expect(html).toContain('aria-label="Sidebar"');
  });

  it("leaves content alone when the area is empty", () => {
    expect(withWidgetLayout("<p>body</p>", "right", widgetAreaHtml(area(), "   "))).toBe("<p>body</p>");
  });

  it("escapes the area label", () => {
    expect(widgetAreaHtml(area({ label: '"><script>' }), "<p>w</p>")).not.toContain("<script>");
  });

  it("finds a widget area block anywhere in a tree", () => {
    const nested = [{ ...text("a", "x"), children: [{ id: "w", type: "core.widget-area", version: 1, props: {} }] }];
    expect(blocksPlaceWidgetArea(nested)).toBe(true);
    expect(blocksPlaceWidgetArea([text("a", "x")])).toBe(false);
  });
});

describe("readWidgetAreaForEditor", () => {
  it("returns the default document while unsaved, and null for unknown areas", async () => {
    themeDefaults.set("sidebar", [text("d", "default")]);
    const found = await readWidgetAreaForEditor(SITE, "sidebar");
    expect(found?.fromDefault).toBe(true);
    expect(found?.doc.blocks).toHaveLength(1);
    expect(await readWidgetAreaForEditor(SITE, "missing")).toBeNull();
  });
});
