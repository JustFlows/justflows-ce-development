// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "../../../src/lib/ai/tools/catalog.js";
import { MANAGE_API_OPENAPI } from "../../../src/lib/http/openapi-manage.js";

/** Style presets reach the assistant and the management API (justflows-ce#301). */
describe("style preset tools", () => {
  const byName = new Map(CORE_TOOLS.map((tool) => [tool.name, tool]));

  it("exist for list, save, delete, usage, publish and discard, with the management API's capabilities", () => {
    expect(byName.get("style_presets_list")).toMatchObject({ operation: { method: "GET", path: "/style-presets" }, capabilities: ["content:read"] });
    expect(byName.get("style_presets_save")).toMatchObject({ operation: { method: "PUT", path: "/style-presets" }, capabilities: ["settings:manage"], targetArg: "id" });
    expect(byName.get("style_presets_delete")).toMatchObject({ operation: { method: "DELETE", path: "/style-presets/{id}" }, capabilities: ["settings:manage"] });
    expect(byName.get("style_presets_usage")).toMatchObject({ operation: { method: "GET", path: "/style-presets/{id}/usage" }, capabilities: ["content:read"] });
    expect(byName.get("style_presets_publish")).toMatchObject({ operation: { method: "POST", path: "/style-presets/publish" }, capabilities: ["settings:manage"] });
    expect(byName.get("style_presets_discard")).toMatchObject({ operation: { method: "POST", path: "/style-presets/discard" }, capabilities: ["settings:manage"] });
  });

  it("requires id, name and style when saving", () => {
    const schema = byName.get("style_presets_save")!.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(["id", "name", "style"]);
    expect(Object.keys(schema.properties)).toEqual(["id", "name", "style"]);
  });

  it("are documented in the management API spec", () => {
    const paths = (MANAGE_API_OPENAPI as { paths: Record<string, unknown> }).paths;
    for (const path of ["/style-presets", "/style-presets/{id}", "/style-presets/{id}/usage", "/style-presets/publish", "/style-presets/discard"]) {
      expect(paths[path], path).toBeDefined();
    }
  });
});
