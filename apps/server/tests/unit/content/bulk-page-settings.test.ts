// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const set = vi.fn();
const remove = vi.fn();
const invalidate = vi.fn();
vi.mock("../../../src/lib/settings/site-settings.js", () => ({
  getSiteSetting: (...args: unknown[]) => get(...args),
  setSiteSetting: (...args: unknown[]) => set(...args),
  deleteSiteSetting: (...args: unknown[]) => remove(...args),
}));
vi.mock("../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: (...args: unknown[]) => invalidate(...args) }));
import { clearHomePagesIfMatch } from "../../../src/lib/content/home-page.js";
import { clearBlogPagesIfMatch } from "../../../src/lib/content/blog-page.js";
import { clearErrorPagesIfMatch } from "../../../src/lib/rendering/error-pages.js";

const home = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blog = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
beforeEach(() => vi.clearAllMocks());

describe("clearing page selections for a content batch", () => {
  it("reads each selection once and preserves unrelated error-page configuration", async () => {
    get.mockImplementation(async (_site: string, key: string) => {
      if (key === "home_page_id") return home;
      if (key === "blog_page_id") return blog;
      return { "404": { source: "page", pageId: home }, "403": { source: "page", pageId: other }, maintenance: { enabled: true, heading: "Soon" } };
    });
    const ids = new Set([home, blog, ...Array.from({ length: 100 }, (_, i) => `content-${i}`)]);
    await clearHomePagesIfMatch("site-a", ids);
    await clearBlogPagesIfMatch("site-a", ids);
    await clearErrorPagesIfMatch("site-a", ids);
    expect(get).toHaveBeenCalledTimes(3);
    expect(remove.mock.calls).toEqual([["site-a", "home_page_id"], ["site-a", "blog_page_id"]]);
    expect(set).toHaveBeenCalledExactlyOnceWith("site-a", "error_pages", {
      "404": { source: "theme" }, "403": { source: "page", pageId: other }, maintenance: { enabled: true, heading: "Soon" },
    });
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("does not clear unmatched settings or read for an empty batch", async () => {
    get.mockResolvedValue(null);
    const ids = new Set<string>();
    await clearHomePagesIfMatch("site-a", ids);
    await clearBlogPagesIfMatch("site-a", ids);
    await clearErrorPagesIfMatch("site-a", ids);
    expect(get).not.toHaveBeenCalled();
    await clearHomePagesIfMatch("site-a", new Set([other]));
    expect(remove).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
