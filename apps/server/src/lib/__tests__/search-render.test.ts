// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { SearchQuerySchema, searchHighlight } from "@justflows/content";
vi.mock("../plugin-runtime.js", () => ({ getRuntimeHooks: vi.fn() }));
import { searchBody } from "../search-db.js";
import { renderSearchPage } from "../search-render.js";
describe("safe search presentation", () => {
  it("indexes visible block text without indexing attributes or arbitrary fields", () => {
    const text = searchBody({
      blocks: [
        {
          props: {
            content: "<script>secretScript()</script><p>Public text</p>",
            url: "private-url",
            defaultValue: "private-default",
          },
          children: [{ props: { heading: "Nested heading" } }],
        },
      ],
      fields: { token: "private-token" },
    });
    expect(text).toContain("Public text");
    expect(text).toContain("Nested heading");
    expect(text).not.toContain("secretScript");
    expect(text).not.toContain("private");
    expect(searchBody("bad JSON")).toBe("");
  });
  it("separates HTML text fragments and decodes entities without turning them into markup", () => {
    expect(
      searchBody({
        blocks: [{ props: { content: "<p>First &amp; next</p><p>Second &lt;literal&gt;</p>" } }],
      }),
    ).toBe("First & next Second <literal>");
  });
  it("escapes the query, highlights, result links, and filter values", () => {
    const title = '<script>alert("hello")</script>';
    const query = SearchQuerySchema.parse({ q: '<img onerror="alert(1)">', term: '\" autofocus' });
    const result = {
      items: [
        {
          id: "id",
          type: "post",
          locale: "en-US",
          slug: "slug",
          title,
          status: "published",
          updatedAt: "",
          publishedAt: null,
          url: "javascript:alert(1)",
          excerpt: title,
          highlights: {
            title: searchHighlight(title, "hello"),
            excerpt: searchHighlight(title, "hello"),
          },
        },
      ],
      total: 2,
      page: 1,
      limit: 1,
      hasMore: true,
      backend: "database",
      typoTolerance: false,
    };
    const html = renderSearchPage(query, result, "/search", (key) => key);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("<mark>hello</mark>");
    expect(html).toContain("page=2");
    expect(html).toContain("&quot; autofocus");
  });
});
