import { describe, expect, it } from "vitest";
import { checkAccessibility, contrastRatio, createBlockRegistrySync, parseColor, textDirection } from "../../src/index.js";

/** Authoring checks, text direction and public semantics (justflows-ce#307). */

const b = (id: string, type: string, props: Record<string, unknown> = {}, children?: unknown[]) => ({ id, type, version: 1, props, ...(children ? { children } : {}) });
const codes = (blocks: unknown[], options?: Parameters<typeof checkAccessibility>[1]) =>
  checkAccessibility(blocks, options).map((i) => `${i.blockId}:${i.code}:${i.severity}`);

describe("accessibility checks", () => {
  it("finds images without alt text and links or buttons without text", () => {
    expect(
      codes([
        b("i1", "core.image", { src: "/a.jpg", alt: "" }),
        b("i2", "core.image", { src: "/b.jpg", alt: "A dog" }),
        b("i3", "core.image", { src: "" }),
        b("b1", "core.button", { label: "", url: "/x" }),
        b("b2", "core.button", { label: "Go", url: "#" }),
        b("h1", "core.hero", { heading: "Hi", buttonLabel: "", buttonUrl: "/go" }),
        b("l1", "core.link-list", { heading: "", items: [{ label: "Ok", url: "/a" }, { label: " ", url: "/b" }] }),
      ]),
    ).toEqual(["i1:image-alt:warning", "b1:link-text:error", "b2:link-target:warning", "h1:link-text:error", "l1:link-text:error"]);
  });

  it("follows headings in reading order, inside containers too", () => {
    const issues = checkAccessibility([
      b("t", "core.hero", { heading: "Welcome" }),
      b("s", "core.section", {}, [b("a", "core.heading", { level: 2, text: "Intro" }), b("c", "core.heading", { level: 4, text: "Detail" })]),
      b("e", "core.heading", { level: 3, text: "<b> </b>" }),
      b("f", "core.heading", { level: 1, text: "Second title" }),
    ]);
    expect(issues.map((i) => `${i.blockId}:${i.code}`)).toEqual(["c:heading-skip", "e:heading-empty", "f:heading-level-one"]);
    expect(issues[0]).toMatchObject({ field: "level", params: { from: 2, to: 4 } });
  });

  it("computes contrast only from colours the document sets, and says when it can't", () => {
    const issues = checkAccessibility([
      b("s", "core.section", { style: { background: "#ffffff" } }, [
        b("p1", "core.paragraph", { text: "x", style: { textColor: "#777777" } }),
        b("p2", "core.paragraph", { text: "x", style: { textColor: "#cccccc" } }),
        b("p3", "core.paragraph", { text: "x", style: { textColor: "#222" } }),
        b("p4", "core.paragraph", { text: "x", style: { textColor: "var(--brand)" } }),
      ]),
      b("p5", "core.paragraph", { text: "x" }),
    ]);
    expect(issues.map((i) => `${i.blockId}:${i.code}:${i.severity}`)).toEqual([
      "p1:contrast:warning",
      "p2:contrast:error",
      "p4:contrast-unknown:unavailable",
    ]);
    expect(issues[0]!.params).toEqual({ ratio: 4.4 });
    expect(contrastRatio(parseColor("#000")!, parseColor("#fff")!)).toBeCloseTo(21);
    expect(parseColor("rgba(0,0,0,0.5)")).toBeNull();
    expect(parseColor("#00000080")).toBeNull();
  });

  it("flags hidden content, reading order changes, and blocks it cannot look inside", () => {
    const issues = codes(
      [
        b("h", "core.heading", { level: 2, text: "Desktop only", devices: ["desktop", "tablet"] }),
        b("o", "core.group", { breakpoints: { mobile: { order: 2 } } }),
        b("g", "core.grid", { columns: 12 }, [
          b("g1", "core.paragraph", { text: "first", gridPlacement: { col: 1, span: 6, row: 2 } }),
          b("g2", "core.paragraph", { text: "second", gridPlacement: { col: 1, span: 6, row: 1 } }),
        ]),
        b("p1", "acme.card", {}),
        b("p2", "acme.card", {}),
        b("t", "core.table", { header: false }),
      ],
      { isOpaqueType: (type) => type.startsWith("acme.") },
    );
    expect(issues).toEqual([
      "h:hidden-on-mobile:warning",
      "o:reading-order:warning",
      "g:reading-order:warning",
      "p1:content-unchecked:unavailable",
      "t:table-header:warning",
    ]);
  });
});

describe("text direction", () => {
  it("is right to left for languages and scripts written that way", () => {
    for (const rtl of ["ar", "ar-EG", "he", "fa_IR", "ur", "ku-Arab", "yi"]) expect(textDirection(rtl), rtl).toBe("rtl");
    for (const ltr of ["en", "nl", "ru", "uk", "ku-Latn", "zh-Hant", "", undefined, "??"]) expect(textDirection(ltr), String(ltr)).toBe("ltr");
  });
});

describe("public renderer semantics", () => {
  const registry = createBlockRegistrySync();
  const html = (type: string, props: Record<string, unknown>, children: unknown[] = []) => registry.renderNode({ id: "n", type, props, children } as never);

  it("always writes alt text on images, and keeps decorative icons out of the accessibility tree", () => {
    expect(html("core.image", { src: "/a.jpg", alt: "" })).toMatch(/<img [^>]*alt=""/);
    expect(html("core.image", { src: "/a.jpg", alt: "A dog" })).toContain('alt="A dog"');
    expect(html("core.icon", { name: "star", decorative: true })).toContain('aria-hidden="true"');
    expect(html("core.icon", { name: "star", decorative: false, label: "Favourite" })).toContain('role="img" aria-label="Favourite"');
  });

  it("writes the heading level the author chose, and real links and buttons", () => {
    expect(html("core.heading", { level: 3, text: "Hi" })).toMatch(/^<h3[^>]*>Hi<\/h3>$/);
    expect(html("core.button", { label: "Go", url: "/x" })).toMatch(/^<a [^>]*href="\/x"[^>]*>Go<\/a>$/);
    expect(html("core.hero", { heading: "Hi", buttonLabel: "Go", buttonUrl: "/x" })).toMatch(/<h1[^>]*>Hi<\/h1>/);
  });

  it("names navigation landmarks and keeps disclosure widgets native", () => {
    expect(html("core.social-links", { label: "Social profiles", links: [{ network: "x", url: "https://x.com/a" }] })).toContain('aria-label="Social profiles"');
    expect(html("core.details", { summary: "More" }, [{ id: "p", type: "core.paragraph", props: { text: "x" } }])).toMatch(/^<details[^>]*><summary>More<\/summary>/);
    expect(html("core.table", { rows: [["A", "B"], ["1", "2"]], header: true })).toContain('<th scope="col">A</th>');
  });
});
