import { describe, expect, it } from "vitest";
import { coreBlocks, normalizeInlineValue, resolveInlineFields, sanitizePluginPreviewHtml } from "../../src/index.js";

describe("resolveInlineFields", () => {
  it("keeps valid declarations and drops unknown modes, formats, and names", () => {
    expect(
      resolveInlineFields(
        {
          title: { mode: "plain", maxLength: 80 },
          body: { mode: "rich", formats: ["bold", "script"], multiline: true },
          "bad name": { mode: "plain" },
          other: { mode: "html" },
        },
        true,
      ),
    ).toEqual({ title: { mode: "plain", maxLength: 80 }, body: { mode: "rich", formats: ["bold"], multiline: true } });
  });

  it("downgrades rich fields from untrusted (plugin) blocks to plain", () => {
    expect(resolveInlineFields({ body: { mode: "rich", formats: ["bold"] } })).toEqual({ body: { mode: "plain" } });
  });

  it("caps maxLength and ignores invalid values", () => {
    expect(resolveInlineFields({ a: { mode: "plain", maxLength: 10_000_000 }, b: { mode: "plain", maxLength: -1 } })).toEqual({
      a: { mode: "plain", maxLength: 20_000 },
      b: { mode: "plain" },
    });
  });

  it("is declared by the core text blocks", () => {
    const declared = Object.fromEntries(coreBlocks.filter((b) => b.inline).map((b) => [b.type, Object.keys(b.inline!)]));
    expect(declared).toMatchObject({
      "core.paragraph": ["text"],
      "core.heading": ["text"],
      "core.quote": ["text", "attribution"],
      "core.button": ["label"],
      "core.image": ["caption", "alt"],
      "core.list-item": ["text"],
      "core.video": ["caption"],
      "core.audio": ["caption"],
      "core.file": ["label", "caption"],
    });
  });
});

describe("normalizeInlineValue", () => {
  it("keeps plain text single-line unless multiline", () => {
    expect(normalizeInlineValue({ mode: "plain" }, "  Hello\n  world  ")).toBe("Hello world");
    expect(normalizeInlineValue({ mode: "plain", multiline: true }, "a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("strips control characters and enforces maxLength", () => {
    expect(normalizeInlineValue({ mode: "plain", maxLength: 5 }, "ab\u0000cdefgh")).toBe("abcde");
  });

  it("treats markup in plain fields as text, never as HTML", () => {
    expect(normalizeInlineValue({ mode: "plain" }, "<b>x</b>")).toBe("<b>x</b>");
  });

  it("sanitizes rich text and re-sanitizes after trimming", () => {
    expect(normalizeInlineValue({ mode: "rich" }, '<b onclick="x()">hi</b><script>bad()</script>')).toBe("<b>hi</b>");
    const trimmed = normalizeInlineValue({ mode: "rich", maxLength: 12 }, '<a href="https://example.com/long">link</a>');
    expect(trimmed).not.toMatch(/<a [^>]*$/);
  });
});

describe("sanitizePluginPreviewHtml", () => {
  it("keeps the inline marker but nothing unsafe", () => {
    const html = sanitizePluginPreviewHtml('<p data-jf-inline="title" onclick="x()">Hi</p><script>bad()</script><img src="javascript:x">');
    expect(html).toContain('data-jf-inline="title"');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("script");
    expect(html).not.toContain("javascript:");
  });
});
