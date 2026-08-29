import { beforeEach, describe, expect, it, vi } from "vitest";

const contentRows = [
  {
    id: "page-contact",
    slug: "contact",
    locale: "en",
    title: "Contact",
    translation_group_id: "group-contact",
  },
  {
    id: "page-contact-nl",
    slug: "contact",
    locale: "nl",
    title: "Contact",
    translation_group_id: "group-contact",
  },
  {
    id: "page-about",
    slug: "about-us",
    locale: "en",
    title: "About us",
    translation_group_id: "group-about",
  },
  {
    id: "product-mug",
    slug: "ceramic-mug",
    locale: "en",
    title: "Mug",
    translation_group_id: "group-mug",
  },
  {
    id: "product-mug-nl",
    slug: "keramische-mok",
    locale: "nl",
    title: "Mok",
    translation_group_id: "group-mug",
  },
];

vi.mock("../db.js", () => ({
  getDb: async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (/translation_group_id IN/i.test(sql)) {
        const locale = params[params.length - 1];
        const groups = params.slice(0, -1);
        return contentRows.filter(
          (row) => groups.includes(row.translation_group_id) && row.locale === locale,
        );
      }
      if (/id IN/i.test(sql)) {
        return contentRows.filter((row) => params.includes(row.id));
      }
      return [];
    },
    run: async () => {},
    close: async () => {},
  }),
  resetDb: () => {},
}));

vi.mock("../i18n/languages-db.js", () => ({
  getActiveLocaleCodes: async () => ["en", "nl"],
}));

const { resolveMenuItems } = await import("../menus-db.js");

describe("resolveMenuItems locale prefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps page links on the current locale even when the item points at the default-language page", async () => {
    const items = await resolveMenuItems(
      [
        { id: "1", label: "contact", type: "page", contentId: "page-contact" },
        { id: "2", label: "About us", type: "page", contentId: "page-about" },
      ],
      "nl",
      "en",
    );

    expect(items.map((item) => item.url)).toEqual(["/nl/contact", "/nl/about-us"]);
  });

  it("prefixes custom internal URLs with the current locale", async () => {
    const items = await resolveMenuItems(
      [{ id: "1", label: "contact", type: "custom", url: "/contact" }],
      "nl",
      "en",
    );

    expect(items[0]?.url).toBe("/nl/contact");
  });

  it("does not prefix the default locale", async () => {
    const items = await resolveMenuItems(
      [{ id: "1", label: "contact", type: "page", contentId: "page-contact" }],
      "en",
      "en",
    );

    expect(items[0]?.url).toBe("/contact");
  });

  it("resolves product content links the same way as pages", async () => {
    const items = await resolveMenuItems(
      [{ id: "1", label: "Mug", type: "product", contentId: "product-mug" }],
      "nl",
      "en",
    );

    expect(items[0]?.url).toBe("/nl/keramische-mok");
  });
});
