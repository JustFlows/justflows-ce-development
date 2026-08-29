// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const run = vi.fn();

vi.mock("../db.js", () => ({
  getDb: async () => ({ query, run }),
}));

vi.mock("../content-types-db.js", () => ({
  createContentType: vi.fn(),
  getContentTypeBySlug: vi.fn(),
}));

vi.mock("../i18n/languages-db.js", () => ({
  getDefaultLocale: async () => "en-US",
}));

vi.mock("../home-page.js", () => ({
  clearHomePageIfMatches: vi.fn(),
}));

vi.mock("../blog-page.js", () => ({
  clearBlogPageIfMatches: vi.fn(),
}));

vi.mock("../content-public.js", () => ({
  invalidateContentCache: vi.fn(),
}));

vi.mock("../plugin-kv.js", () => ({
  getPluginHostItem: vi.fn().mockResolvedValue(undefined),
  setPluginHostItem: vi.fn(),
  PLUGIN_HOST_CONTENT_TYPES_ITEM: "contentTypes",
}));

import { getContentTypeBySlug } from "../content-types-db.js";
import { clearHomePageIfMatches } from "../home-page.js";
import { clearBlogPageIfMatches } from "../blog-page.js";
import { invalidateContentCache } from "../content-public.js";
import { contentTypeSlugsFromManifest, createPluginContentApi } from "../plugin-content.js";

describe("createPluginContentApi.deleteType", () => {
  beforeEach(() => {
    query.mockReset();
    run.mockReset();
    vi.mocked(getContentTypeBySlug).mockReset();
    vi.mocked(clearHomePageIfMatches).mockReset();
    vi.mocked(clearBlogPageIfMatches).mockReset();
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
      createdAt: "",
      updatedAt: "",
    });
    const api = createPluginContentApi("justflows.shop", "site-1");
    await expect(api.deleteType("shop")).resolves.toEqual({ pages: 2, typeDeleted: true });
    expect(clearHomePageIfMatches).toHaveBeenCalledWith("site-1", "c1");
    expect(clearBlogPageIfMatches).toHaveBeenCalledWith("site-1", "c2");
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

describe("contentTypeSlugsFromManifest", () => {
  it("reads unique non-builtin slugs", () => {
    expect(
      contentTypeSlugsFromManifest({ contentTypes: ["shop", "product", "page", "shop", "Not Valid!"] }),
    ).toEqual(["shop", "product"]);
  });
});
