// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { panelsFromManifest } from "../../../src/lib/admin/editor-panels.js";

const panel = {
  id: "seo",
  title: { en: "SEO", nl: "SEO" },
  indexableOnly: true,
  fields: [{ key: "seoTitle", type: "text", label: "SEO title", placeholder: "{title}" }],
};

describe("panelsFromManifest", () => {
  it("keeps valid panels from a plugin with admin:extend", () => {
    expect(panelsFromManifest({ permissions: ["admin:extend"], editorPanels: [panel] }, "justflows.seo")).toEqual([
      { ...panel, pluginId: "justflows.seo" },
    ]);
  });

  it("adds nothing without admin:extend", () => {
    expect(panelsFromManifest({ permissions: [], editorPanels: [panel] }, "justflows.seo")).toEqual([]);
  });

  it("keeps a panel that embeds an admin screen", () => {
    expect(
      panelsFromManifest(
        { permissions: ["admin:extend"], editorPanels: [{ id: "workflow", title: "Workflow", app: "comments" }] },
        "justflows.example",
      ),
    ).toEqual([{ id: "workflow", title: "Workflow", app: "comments", pluginId: "justflows.example" }]);
  });

  it("drops a panel that no longer matches the schema", () => {
    const bad = { ...panel, fields: [{ key: "../x", type: "script", label: "" }] };
    expect(panelsFromManifest({ permissions: ["admin:extend"], editorPanels: [bad, panel] }, "justflows.seo")).toHaveLength(1);
  });
});
