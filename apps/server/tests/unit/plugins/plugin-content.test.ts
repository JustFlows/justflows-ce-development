// SPDX-License-Identifier: MIT
import { resolveContentTypeSettings } from "@justflows/content";

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const run = vi.fn();

vi.mock("../../../src/lib/content/visibility-scope.js", () => {
  const open = { restricted: false, allows: () => true, sql: () => ({ sql: "1 = 1", params: [] }) };
  return { getVisibilityScope: async () => open, getAnonymousVisibilityScope: async () => open, isOpenToEveryone: async () => true };
});
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

vi.mock("../../../src/lib/search/search-db.js", () => ({
  indexSearchContent: vi.fn(),
}));

vi.mock("../../../src/lib/tenancy/quotas.js", () => ({
  enforceQuota: vi.fn().mockResolvedValue(null),
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
    const api = createPluginContentApi("justflows.store", "site-1");
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
      settings: resolveContentTypeSettings("post"),
      cacheControl: null,
      cacheControlEditable: true,
      createdAt: "",
      updatedAt: "",
    });
    const api = createPluginContentApi("justflows.store", "site-1");
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

describe("createPluginContentApi.deletePages", () => {
  beforeEach(() => {
    query.mockReset();
    run.mockReset();
    vi.mocked(invalidateContentCache).mockReset();
  });

  it("deletes the page, a trash copy, and its translations", async () => {
    query
      .mockResolvedValueOnce([
        { id: "page-1", type: "page", translation_group_id: "group-1" },
        { id: "trash-1", type: "page", translation_group_id: null },
      ])
      .mockResolvedValueOnce([
        { id: "page-1", type: "page" },
        { id: "nl-1", type: "page" },
      ]);
    const api = createPluginContentApi("justflows.desk", "site-1");
    await expect(api.deletePages({ type: "page", slug: "support" })).resolves.toEqual({ deleted: 3 });
    expect(run).toHaveBeenCalledWith(
      "DELETE FROM content WHERE site_id = ? AND id IN (?, ?, ?)",
      ["site-1", "page-1", "trash-1", "nl-1"],
    );
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
    settings: resolveContentTypeSettings("post"),
      cacheControl: null,
      cacheControlEditable: true,
    createdAt: "",
    updatedAt: "",
  };

  it("updates title when the page already exists", async () => {
    vi.mocked(getContentTypeBySlug).mockResolvedValue(shopType);
    query.mockResolvedValueOnce([{ id: "c1" }]);
    const api = createPluginContentApi("justflows.store", "site-1");
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
    const api = createPluginContentApi("justflows.store", "site-1");
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

  it("stores blocks and a private cache policy only when inserting", async () => {
    vi.mocked(getContentTypeBySlug).mockResolvedValue({ ...shopType, slug: "page", builtin: true });
    query.mockResolvedValue([]);
    const api = createPluginContentApi("justflows.desk", "site-1");
    const blocks = { version: 1 as const, blocks: [{ id: "support-form", type: "justflows.desk.new-ticket", version: 1, props: {} }] };
    await api.ensurePage({
      type: "page",
      title: "Support",
      slug: "support",
      status: "published",
      blocks,
      cacheControl: "private, no-store",
    });
    const insert = run.mock.calls.find((call) => String(call[0]).startsWith("INSERT INTO content"));
    expect(JSON.parse(String(insert?.[1]?.[8]))).toMatchObject({ blocks: [{ id: "support-form" }] });
    expect(JSON.parse(String(insert?.[1]?.[9]))).toEqual({ cacheControl: "private, no-store" });

    query.mockResolvedValueOnce([{ id: "c1" }]);
    run.mockClear();
    await api.ensurePage({
      type: "page",
      title: "Support",
      slug: "support",
      blocks,
      cacheControl: "private, no-store",
    });
    expect(String(run.mock.calls[0]?.[0])).not.toContain("blocks");
  });

  it("trashes a public page when the same slug becomes an account page", async () => {
    vi.mocked(getContentTypeBySlug).mockResolvedValue({ ...shopType, slug: "account", builtin: true });
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "old-page", type: "page" }]);
    const api = createPluginContentApi("justflows.desk", "site-1");
    await api.ensurePage({
      type: "account",
      title: "My tickets",
      slug: "my-tickets",
      status: "published",
      retireTypes: ["page"],
    });
    const trash = run.mock.calls.find((call) => String(call[0]).includes("status = 'trashed'"));
    expect(trash?.[1]?.[0]).toBe("page-trash-old-page");
  });

  it("does not insert when create is false and nothing matches", async () => {
    vi.mocked(getContentTypeBySlug).mockResolvedValue({ ...shopType, slug: "page", builtin: true });
    query.mockResolvedValue([]);
    const api = createPluginContentApi("justflows.store", "site-1");
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
    const api = createPluginContentApi("justflows.store", "site-1");
    const page = await api.getPublished!({ type: "shop", slug: "product" });
    expect(page).toMatchObject({ id: "p1", type: "shop", slug: "product", blocks: [{ id: "b-en-US" }] });
    expect(query.mock.calls[0]?.[1]).toEqual(["site-1", "shop", "product", "en-US"]);
  });

  it("prefers the visitor's published translation and falls back to the original", async () => {
    query.mockResolvedValueOnce([layout("p1", "en-US")]).mockResolvedValueOnce([layout("p2", "nl-NL", { slug: "product-nl" })]);
    const api = createPluginContentApi("justflows.store", "site-1");
    expect(await api.getPublished!({ type: "shop", slug: "product", locale: "nl-NL" })).toMatchObject({ id: "p2", blocks: [{ id: "b-nl-NL" }] });
    query.mockResolvedValueOnce([layout("p1", "en-US")]).mockResolvedValueOnce([]);
    expect(await api.getPublished!({ type: "shop", slug: "product", locale: "de-DE" })).toMatchObject({ id: "p1" });
  });

  it("returns null when nothing is published, or it is scheduled for later", async () => {
    query.mockResolvedValueOnce([]);
    const api = createPluginContentApi("justflows.store", "site-1");
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
