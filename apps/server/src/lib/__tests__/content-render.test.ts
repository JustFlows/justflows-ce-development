// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const ensurePluginRuntime = vi.fn(async () => undefined);
const applyFilter = vi.fn(async (_hook: string, value: unknown) => value);

vi.mock("../plugin-runtime.js", () => ({
  ensurePluginRuntime: () => ensurePluginRuntime(),
  getRuntimeHooks: () => ({ applyFilter }),
}));

import { applyContentBlocks, applyContentRender } from "../content-render.js";

const content = {
  id: "0a389d79-dab3-4ea4-ba1f-162e5c6e09b4",
  siteId: "site-1",
  type: "product",
  title: "Demo product one",
  excerpt: "Soft cotton.",
  translationGroupId: "0a389d79-dab3-4ea4-ba1f-162e5c6e09b4",
};

describe("applyContentRender", () => {
  beforeEach(() => {
    ensurePluginRuntime.mockClear();
    applyFilter.mockClear();
    applyFilter.mockImplementation(async (_hook: string, value: unknown) => value);
  });

  it("starts the plugin runtime and applies content.render", async () => {
    applyFilter.mockImplementation(async (_hook, html: unknown) =>
      String(html).replace("{{sku}}", "SKU01"),
    );
    await expect(applyContentRender("<p>SKU {{sku}}</p>", content)).resolves.toBe("<p>SKU SKU01</p>");
    expect(ensurePluginRuntime).toHaveBeenCalledOnce();
    expect(applyFilter).toHaveBeenCalledWith(
      "content.render",
      "<p>SKU {{sku}}</p>",
      expect.objectContaining({
        contentId: content.id,
        type: "product",
        title: "Demo product one",
        translationGroupId: content.id,
      }),
      expect.objectContaining({ siteId: "site-1", source: "http" }),
    );
  });

  it("decodes HTML-entity braces before the filter", async () => {
    await applyContentRender("<h1>&#123;&#123;title&#125;&#125;</h1>", content);
    expect(applyFilter.mock.calls[0]?.[1]).toBe("<h1>{{title}}</h1>");
  });

  it("skips the filter when there are no tags", async () => {
    await expect(applyContentRender("<p>Hello</p>", content)).resolves.toBe("<p>Hello</p>");
    expect(applyFilter).not.toHaveBeenCalled();
    expect(ensurePluginRuntime).not.toHaveBeenCalled();
  });
});

describe("applyContentBlocks", () => {
  beforeEach(() => {
    ensurePluginRuntime.mockClear();
    applyFilter.mockClear();
    applyFilter.mockImplementation(async (_hook: string, value: unknown) => value);
  });

  it("starts the plugin runtime and applies content.blocks", async () => {
    const blocks = [{ type: "core.heading", props: { text: "{{title}}", level: 1 } }];
    applyFilter.mockImplementation(async () => [{ type: "core.heading", props: { text: "Demo product one", level: 1 } }]);
    await expect(applyContentBlocks(blocks, content)).resolves.toEqual([
      { type: "core.heading", props: { text: "Demo product one", level: 1 } },
    ]);
    expect(ensurePluginRuntime).toHaveBeenCalledOnce();
    expect(applyFilter).toHaveBeenCalledWith(
      "content.blocks",
      blocks,
      expect.objectContaining({ contentId: content.id, title: "Demo product one" }),
      expect.objectContaining({ siteId: "site-1" }),
    );
  });
});
