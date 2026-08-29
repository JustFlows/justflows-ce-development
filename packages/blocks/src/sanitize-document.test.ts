import { describe, expect, it } from "vitest";
import { sanitizeBlockDocument } from "./sanitize-document.js";

describe("sanitizeBlockDocument", () => {
  it("strips script tags from html blocks", () => {
    const result = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "1",
          type: "core.html",
          version: 1,
          props: { html: '<p>ok</p><script>alert(1)</script>' },
        },
      ],
    });
    const html = (result.blocks[0] as { props: { html: string } }).props.html;
    expect(html).toContain("<p>ok</p>");
    expect(html).not.toContain("script");
  });

  it("keeps layout classes on html blocks", () => {
    const result = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "1",
          type: "core.html",
          version: 1,
          props: { html: '<p class="jf-product-price">{{price}}</p>' },
        },
      ],
    });
    const html = (result.blocks[0] as { props: { html: string } }).props.html;
    expect(html).toContain('class="jf-product-price"');
    expect(html).toContain("{{price}}");
  });

  it("rejects javascript: urls", () => {
    const result = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "1",
          type: "core.button",
          version: 1,
          props: { url: "javascript:alert(1)", label: "Go" },
        },
      ],
    });
    expect((result.blocks[0] as { props: { url: string } }).props.url).toBe("#");
  });

  it("strips javascript image sources on shop gallery blocks", () => {
    const result = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "1",
          type: "justflows.shop.gallery",
          version: 1,
          props: {
            layout: "thumbs",
            images: [
              { src: "javascript:alert(1)", alt: "bad" },
              { src: "https://example.com/p.jpg", alt: "ok" },
            ],
            cartUrl: "javascript:alert(1)",
          },
        },
      ],
    });
    const props = (result.blocks[0] as { props: { images: Array<{ src: string }>; cartUrl: string } }).props;
    expect(props.images[0]?.src).toBe("");
    expect(props.images[1]?.src).toBe("https://example.com/p.jpg");
    expect(props.cartUrl).toBe("#");
  });

  it("strips javascript links and unsafe swatches on shop product-list blocks", () => {
    const result = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "1",
          type: "justflows.shop.product-list",
          version: 1,
          props: {
            layout: "swatches",
            ctaHref: "javascript:alert(1)",
            items: [
              {
                name: "Tee",
                href: "javascript:alert(1)",
                imageSrc: "javascript:alert(1)",
                colors: [{ name: "Red", colorBg: "expression(alert(1))" }],
              },
            ],
          },
        },
      ],
    });
    const props = (
      result.blocks[0] as {
        props: {
          ctaHref: string;
          items: Array<{ href: string; imageSrc: string; colors: Array<{ colorBg: string }> }>;
        };
      }
    ).props;
    expect(props.ctaHref).toBe("#");
    expect(props.items[0]?.href).toBe("#");
    expect(props.items[0]?.imageSrc).toBe("");
    expect(props.items[0]?.colors[0]?.colorBg).toBe("");
  });

  it("keeps only allowlisted animation fields", () => {
    const result = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "1",
          type: "core.paragraph",
          version: 1,
          props: {
            text: "Hello",
            animation: { entrance: "fade-up", hover: "explode", duration: 0.4, onclick: "alert(1)" },
          },
        },
      ],
    });
    expect((result.blocks[0] as { props: Record<string, unknown> }).props["animation"]).toEqual({
      entrance: "fade-up",
      duration: 0.4,
    });
  });
});

describe("sanitizeBlockDocument block styling", () => {
  function props(input: Record<string, unknown>): Record<string, unknown> {
    const doc = sanitizeBlockDocument({ version: 1, blocks: [{ type: "core.paragraph", props: input }] });
    return (doc.blocks[0] as { props: Record<string, unknown> }).props;
  }

  it("keeps usable classes and CSS", () => {
    expect(props({ className: "lead", css: "& { color: red }" })).toEqual({
      className: "lead",
      css: "& { color: red }",
    });
  });

  it("drops CSS that fetches or executes rather than storing it", () => {
    expect(props({ css: "@import url(//attacker.example/x);" })).toEqual({});
  });

  it("strips characters that would break out of the class attribute", () => {
    expect(props({ className: 'a" onclick="x' })).toEqual({ className: "a onclickx" });
  });

  it("drops the keys entirely when nothing survives", () => {
    expect(props({ className: "\"\"", css: "   " })).toEqual({});
  });
});

describe("sanitizeBlockDocument grid placement vs. a block's own `layout` prop", () => {
  function propsOf(type: string, input: Record<string, unknown>): Record<string, unknown> {
    const doc = sanitizeBlockDocument({ version: 1, blocks: [{ type, props: input }] });
    return (doc.blocks[0] as { props: Record<string, unknown> }).props;
  }

  it("leaves a plugin block's own `layout` value alone (regression: masonry reverting to grid)", () => {
    expect(
      propsOf("justflows.gallery.grid", { items: [], layout: "masonry", columns: 3, lightbox: true }),
    ).toMatchObject({ layout: "masonry" });
  });

  it("still sanitizes real grid placement, now stored under gridPlacement", () => {
    expect(propsOf("core.paragraph", { gridPlacement: { col: 4, span: 5 } })).toEqual({
      gridPlacement: { col: 4, span: 5 },
    });
  });

  it("drops a default-width gridPlacement instead of storing it", () => {
    expect(propsOf("core.paragraph", { gridPlacement: { col: 1, span: 12 } })).toEqual({});
  });

  it("migrates legacy object-shaped placement stored under the old `layout` key", () => {
    expect(propsOf("core.paragraph", { layout: { col: 4, span: 5 } })).toEqual({
      gridPlacement: { col: 4, span: 5 },
    });
  });
});
