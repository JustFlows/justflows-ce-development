// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const run = vi.fn();

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({ query, run }),
}));

vi.mock("../../../src/lib/content/content-types-db.js", () => ({
  createContentType: vi.fn(),
  getContentTypeBySlug: vi.fn(),
}));

vi.mock("../../../src/lib/i18n/languages-db.js", () => ({
  getDefaultLocale: async () => "en-US",
}));

vi.mock("../../../src/lib/content/home-page.js", () => ({
  clearHomePagesIfMatch: vi.fn(),
}));

vi.mock("../../../src/lib/content/blog-page.js", () => ({
  clearBlogPagesIfMatch: vi.fn(),
}));

vi.mock("../../../src/lib/rendering/error-pages.js", () => ({
  clearErrorPagesIfMatch: vi.fn(),
}));

vi.mock("../../../src/lib/content/content-public.js", () => ({
  invalidateContentCache: vi.fn(),
}));

vi.mock("../../../src/lib/plugins/plugin-kv.js", () => ({
  getPluginHostItem: vi.fn().mockResolvedValue(undefined),
  setPluginHostItem: vi.fn(),
  PLUGIN_HOST_CONTENT_TYPES_ITEM: "contentTypes",
}));

import { getContentTypeBySlug } from "../../../src/lib/content/content-types-db.js";
import { clearHomePagesIfMatch } from "../../../src/lib/content/home-page.js";
import { clearBlogPagesIfMatch } from "../../../src/lib/content/blog-page.js";
import { clearErrorPagesIfMatch } from "../../../src/lib/rendering/error-pages.js";
import { invalidateContentCache } from "../../../src/lib/content/content-public.js";
import { contentTypeSlugsFromManifest, createPluginContentApi } from "../../../src/lib/plugins/plugin-content.js";

describe("createPluginContentApi.deleteType", () => {
  beforeEach(() => {
    query.mockReset();
    run.mockReset();
    vi.mocked(getContentTypeBySlug).mockReset();
    vi.mocked(clearHomePagesIfMatch).mockReset();
    vi.mocked(clearBlogPagesIfMatch).mockReset();
    vi.mocked(clearErrorPagesIfMatch).mockReset();
    vi.mocked(invalidateContentCache).mockReset();
  });

  it("refuses built-in types", async () => {
    const api = createPluginContentApi("justflows.shop", "site-1");
    await expect(api.deleteType("page")).rejects.toThrow(/built-in/);
    expect(run).not.toHaveBeenCalled();
  });

  it("deletes every entry of the type, then the type", async () => {
    query.mockResolvedValueOnce([{ id: "c1" }, { id: "c2" }]);
    vi.mocked(getContentTypeBySlug).mockResolvedValue({
      id: "t1",
      siteId: "site-1",
      slug: "shop",
      label: "Shop",
      description: "",
      builtin: false,
      fields: [],
      cacheControl: null,
      cacheControlEditable: true,
      createdAt: "",
      updatedAt: "",
    });
    const api = createPluginContentApi("justflows.shop", "site-1");
    await expect(api.deleteType("shop")).resolves.toEqual({ pages: 2, typeDeleted: true });
    expect(clearHomePagesIfMatch).toHaveBeenCalledWith("site-1", new Set(["c1", "c2"]));
    expect(clearBlogPagesIfMatch).toHaveBeenCalledWith("site-1", new Set(["c1", "c2"]));
    expect(clearErrorPagesIfMatch).toHaveBeenCalledWith("site-1", new Set(["c1", "c2"]));
    expect(run).toHaveBeenCalledWith(
      "DELETE FROM revisions WHERE site_id = ? AND content_id IN (?, ?)",
      ["site-1", "c1", "c2"],
    );
    expect(run).toHaveBeenCalledWith("DELETE FROM content WHERE site_id = ? AND type = ?", [
      "site-1",
      "shop",
    ]);
    expect(run).toHaveBeenCalledWith("DELETE FROM content_types WHERE site_id = ? AND slug = ?", [
      "site-1",
      "shop",
    ]);
    expect(invalidateContentCache).toHaveBeenCalled();
  });
});

describe("createPluginContentApi.ensurePage", () => {
  beforeEach(() => {
    query.mockReset();
    run.mockReset();
    vi.mocked(getContentTypeBySlug).mockReset();
    vi.mocked(invalidateContentCache).mockReset();
  });

  const shopType = {
    id: "t1",
    siteId: "site-1",
    slug: "shop",
    label: "Shop",
    description: "",
    builtin: false,
    fields: [],
      cacheControl: null,
      cacheControlEditable: true,
    createdAt: "",
    updatedAt: "",
  };

  it("updates title when the page already exists", async () => {
    vi.mocked(getContentTypeBySlug).mockResolvedValue(shopType);
    query.mockResolvedValueOnce([{ id: "c1" }]);
    const api = createPluginContentApi("justflows.shop", "site-1");
    await expect(
      api.ensurePage({ type: "shop", title: "Product detail", slug: "product" }),
    ).resolves.toEqual({ created: false, id: "c1", slug: "product" });
    expect(run).toHaveBeenCalledWith(
      "UPDATE content SET title = ?, slug = ?, excerpt = ?, updated_at = ? WHERE id = ? AND site_id = ?",
      ["Product detail", "product", null, expect.any(String), "c1", "site-1"],
    );
  });

  it("renames a misspelled alias without inserting", async () => {
    vi.mocked(getContentTypeBySlug).mockResolvedValue({ ...shopType, slug: "page", builtin: true });
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "c-typo" }]);
    const api = createPluginContentApi("justflows.shop", "site-1");
    await expect(
      api.ensurePage({
        type: "page",
        title: "Product detail page",
        slug: "product-detail-page",
        aliases: ["prodcut-detail-page"],
        create: false,
      }),
    ).resolves.toEqual({ created: false, id: "c-typo", slug: "product-detail-page" });
    expect(run).toHaveBeenCalledWith(
      "UPDATE content SET title = ?, slug = ?, excerpt = ?, updated_at = ? WHERE id = ? AND site_id = ?",
      ["Product detail page", "product-detail-page", null, expect.any(String), "c-typo", "site-1"],
    );
  });

  it("does not insert when create is false and nothing matches", async () => {
    vi.mocked(getContentTypeBySlug).mockResolvedValue({ ...shopType, slug: "page", builtin: true });
    query.mockResolvedValue([]);
    const api = createPluginContentApi("justflows.shop", "site-1");
    await expect(
      api.ensurePage({
        type: "page",
        title: "Product detail page",
        slug: "product-detail-page",
        aliases: ["prodcut-detail-page"],
        create: false,
      }),
    ).resolves.toEqual({ created: false, id: "", slug: "product-detail-page" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("createPluginContentApi.getPublished", () => {
  const layout = (id: string, locale: string, extra: Record<string, unknown> = {}) => ({
    id,
    site_id: "site-1",
    type: "shop",
    title: "Product detail",
    slug: "product",
    locale,
    translation_group_id: "p1",
    status: "published",
    blocks: JSON.stringify({ version: 1, blocks: [{ id: `b-${locale}`, type: "core.paragraph", version: 1, props: {} }] }),
    fields: "{}",
    published_at: "2026-01-01 00:00:00",
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...extra,
  });

  beforeEach(() => {
    query.mockReset();
  });

  it("returns the published entry with its blocks", async () => {
    query.mockResolvedValueOnce([layout("p1", "en-US")]);
    const api = createPluginContentApi("justflows.shop", "site-1");
    const page = await api.getPublished!({ type: "shop", slug: "product" });
    expect(page).toMatchObject({ id: "p1", type: "shop", slug: "product", blocks: [{ id: "b-en-US" }] });
    expect(query.mock.calls[0]?.[1]).toEqual(["site-1", "shop", "product", "en-US"]);
  });

  it("prefers the visitor's published translation and falls back to the original", async () => {
    query.mockResolvedValueOnce([layout("p1", "en-US")]).mockResolvedValueOnce([layout("p2", "nl-NL", { slug: "product-nl" })]);
    const api = createPluginContentApi("justflows.shop", "site-1");
    expect(await api.getPublished!({ type: "shop", slug: "product", locale: "nl-NL" })).toMatchObject({ id: "p2", blocks: [{ id: "b-nl-NL" }] });
    query.mockResolvedValueOnce([layout("p1", "en-US")]).mockResolvedValueOnce([]);
    expect(await api.getPublished!({ type: "shop", slug: "product", locale: "de-DE" })).toMatchObject({ id: "p1" });
  });

  it("returns null when nothing is published, or it is scheduled for later", async () => {
    query.mockResolvedValueOnce([]);
    const api = createPluginContentApi("justflows.shop", "site-1");
    expect(await api.getPublished!({ type: "shop", slug: "product" })).toBeNull();
    query.mockResolvedValueOnce([layout("p1", "en-US", { published_at: "2999-01-01 00:00:00" })]);
    expect(await api.getPublished!({ type: "shop", slug: "product" })).toBeNull();
  });
});

describe("contentTypeSlugsFromManifest", () => {
  it("reads unique non-builtin slugs", () => {
    expect(
      contentTypeSlugsFromManifest({ contentTypes: ["shop", "product", "page", "shop", "Not Valid!"] }),
    ).toEqual(["shop", "product"]);
  });
});
