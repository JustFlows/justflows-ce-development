import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/media/placeholders.js", () => ({
  renderPlaceholder: async (kind: string) => `<img data-jf-placeholder="${kind}">`,
}));
import {
  FEATURED_IMAGE_BLOCK_TYPE,
  POST_CONTENT_BLOCK_TYPE,
  POST_EXCERPT_BLOCK_TYPE,
  POST_META_BLOCK_TYPE,
  POST_TITLE_BLOCK_TYPE,
  TEMPLATE_BLOCK_TYPES,
  TEMPLATE_PART_BLOCK_TYPE,
  WIDGET_AREA_BLOCK_TYPE,
  registerTemplateBlocks,
  renderTemplateBlockHtml,
  type TemplateBlockContext,
} from "../../../src/lib/rendering/template-blocks.js";
import { getRuntimeBlockRegistry } from "../../../src/lib/rendering/runtime-blocks.js";

function ctx(overrides: Partial<TemplateBlockContext> = {}): TemplateBlockContext {
  return {
    content: {
      id: "c1",
      type: "post",
      title: "Hello & <World>",
      slug: "hello",
      excerpt: "An excerpt",
      fields: { seoImage: "/media/hero.jpg" },
      publishedAt: "2026-01-02T00:00:00Z",
    },
    formattedDate: "January 2, 2026",
    contentBodyHtml: "<p>body</p>",
    renderPart: async (slug) => `<!--part:${slug}-->`,
    renderWidgetArea: async (key) => `<!--area:${key}-->`,
    ...overrides,
  };
}

describe("renderTemplateBlockHtml", () => {
  it("post-content emits the already-rendered content body verbatim", async () => {
    expect(await renderTemplateBlockHtml(POST_CONTENT_BLOCK_TYPE, {}, ctx())).toBe("<p>body</p>");
  });

  it("post-content wrap prop reproduces the built-in single/page shells", async () => {
    expect(await renderTemplateBlockHtml(POST_CONTENT_BLOCK_TYPE, { wrap: "post" }, ctx())).toBe(
      '<div class="block-content"><p>body</p></div>',
    );
    expect(await renderTemplateBlockHtml(POST_CONTENT_BLOCK_TYPE, { wrap: "page" }, ctx())).toBe(
      '<div class="block-content block-content--page"><p>body</p></div>',
    );
    expect(await renderTemplateBlockHtml(POST_CONTENT_BLOCK_TYPE, { wrap: "bogus" }, ctx())).toBe(
      "<p>body</p>",
    );
  });

  it("post-title escapes and honours the level prop", async () => {
    expect(await renderTemplateBlockHtml(POST_TITLE_BLOCK_TYPE, { level: 2 }, ctx())).toBe(
      '<h2 class="post-title">Hello &amp; &lt;World&gt;</h2>',
    );
    expect(await renderTemplateBlockHtml(POST_TITLE_BLOCK_TYPE, {}, ctx())).toMatch(/^<h1 /);
  });

  it("post-meta renders the formatted date, or nothing when absent", async () => {
    expect(await renderTemplateBlockHtml(POST_META_BLOCK_TYPE, {}, ctx())).toBe(
      '<p class="post-meta">January 2, 2026</p>',
    );
    expect(
      await renderTemplateBlockHtml(POST_META_BLOCK_TYPE, {}, ctx({ formattedDate: null })),
    ).toBe("");
  });

  it("post-excerpt renders the excerpt, or nothing when absent", async () => {
    expect(await renderTemplateBlockHtml(POST_EXCERPT_BLOCK_TYPE, {}, ctx())).toBe(
      '<p class="post-excerpt">An excerpt</p>',
    );
    expect(
      await renderTemplateBlockHtml(
        POST_EXCERPT_BLOCK_TYPE,
        {},
        ctx({ content: { ...ctx().content!, excerpt: null } }),
      ),
    ).toBe("");
  });

  it("featured-image reads fields.seoImage and shows the placeholder without one", async () => {
    expect(await renderTemplateBlockHtml(FEATURED_IMAGE_BLOCK_TYPE, {}, ctx())).toContain(
      'src="/media/hero.jpg"',
    );
    const empty = ctx({ content: { ...ctx().content!, fields: {} } });
    expect(await renderTemplateBlockHtml(FEATURED_IMAGE_BLOCK_TYPE, {}, empty)).toBe(
      '<figure class="post-featured-image"><img data-jf-placeholder="featured"></figure>',
    );
    expect(
      await renderTemplateBlockHtml(FEATURED_IMAGE_BLOCK_TYPE, { placeholder: false }, empty),
    ).toBe("");
  });

  it("template-part delegates to ctx.renderPart for known slugs only", async () => {
    expect(await renderTemplateBlockHtml(TEMPLATE_PART_BLOCK_TYPE, { slug: "footer" }, ctx())).toBe(
      "<!--part:footer-->",
    );
    expect(
      await renderTemplateBlockHtml(TEMPLATE_PART_BLOCK_TYPE, { slug: "sidebar" }, ctx()),
    ).toBe("");
  });

  it("degrades to empty string when there is no content in context", async () => {
    const empty = ctx({ content: null });
    expect(await renderTemplateBlockHtml(POST_TITLE_BLOCK_TYPE, {}, empty)).toBe("");
    expect(await renderTemplateBlockHtml(FEATURED_IMAGE_BLOCK_TYPE, {}, empty)).toBe("");
  });
});

describe("registerTemplateBlocks", () => {
  it("registers every context block as a builder stub", () => {
    registerTemplateBlocks();
    const registry = getRuntimeBlockRegistry();
    for (const type of TEMPLATE_BLOCK_TYPES) {
      const def = registry.get(type);
      expect(def, type).toBeDefined();
      expect(def!.render({}, "")).toContain("theme template");
    }
  });

  it("is idempotent", () => {
    expect(() => {
      registerTemplateBlocks();
      registerTemplateBlocks();
    }).not.toThrow();
  });
});

describe("widget area block", () => {
  it("renders the named area through the template context", async () => {
    expect(await renderTemplateBlockHtml(WIDGET_AREA_BLOCK_TYPE, { area: "sidebar" }, ctx())).toBe(
      "<!--area:sidebar-->",
    );
  });

  it("ignores a key that is not a widget area key", async () => {
    const renderWidgetArea = vi.fn(async () => "x");
    expect(
      await renderTemplateBlockHtml(WIDGET_AREA_BLOCK_TYPE, { area: "../etc" }, ctx({ renderWidgetArea })),
    ).toBe("");
    expect(renderWidgetArea).not.toHaveBeenCalled();
  });

  it("is a template block", () => {
    expect(TEMPLATE_BLOCK_TYPES.has(WIDGET_AREA_BLOCK_TYPE)).toBe(true);
  });
});
