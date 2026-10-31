// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { workspacePanelsFromManifest } from "../../../src/lib/admin/workspace-panels.js";

const panel = { id: "server", title: { en: "Server", nl: "Server" }, app: "workspace" };

describe("workspacePanelsFromManifest", () => {
  it("keeps valid panels and the plugin's catalogs", () => {
    expect(
      workspacePanelsFromManifest(
        { permissions: ["admin:extend"], workspacePanels: [panel], adminApp: { locales: { en: "locales/en.json" } } },
        "justflows.example",
      ),
    ).toEqual([{ ...panel, pluginId: "justflows.example", catalogs: { en: "/ext/justflows.example/admin/locales/en.json" } }]);
  });

  it("adds nothing without admin:extend", () => {
    expect(workspacePanelsFromManifest({ permissions: [], workspacePanels: [panel] }, "justflows.example")).toEqual([]);
  });

  it("drops a panel whose app path escapes the plugin", () => {
    const bad = { ...panel, app: "../platform" };
    expect(
      workspacePanelsFromManifest({ permissions: ["admin:extend"], workspacePanels: [bad, panel] }, "justflows.example"),
    ).toHaveLength(1);
  });
});
