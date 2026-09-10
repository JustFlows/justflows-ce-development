// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { searchBlock } from "./search.js";
describe("core.search", () => {
  it("renders a usable GET form with bounded scope and pagination", () => {
    const html = searchBlock.render(
      searchBlock.validateProps({ contentType: "post", limit: 1000 }),
    );
    expect(html).toContain('action="/search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="type" value="post"');
    expect(html).toContain('name="limit" value="50"');
    expect(html).toContain('type="search"');
  });
  it("escapes every editable label and value", () => {
    const html = searchBlock.render(
      searchBlock.validateProps({
        label: '<img onerror="alert(1)">',
        term: '\" autofocus onfocus=alert(1)',
        showFilters: true,
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('value="&quot; autofocus');
    expect(html).toContain('type="date"');
  });
});
