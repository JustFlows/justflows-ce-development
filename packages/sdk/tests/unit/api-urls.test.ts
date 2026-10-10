// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { pluginApiUrl, isValidPluginApiNamespace } from "../../src/api-urls.js";
import { PluginManifestSchema } from "../../src/plugin.js";
describe("plugin API URLs", () => {
  it("validates and retains an explicit namespace", () => {
    const manifest = PluginManifestSchema.parse({ id: "justflows.shop", name: "Shop", version: "1.0.0", license: "MIT", main: "index.js", permissions: [], apiNamespace: "shop" });
    expect(manifest.apiNamespace).toBe("shop");
    expect(pluginApiUrl("shop", "checkout?locale=nl")).toBe("/api/shop/checkout?locale=nl");
  });
  it.each(["users", "auth", "account", "../shop", "SHOP", "shop/checkout", ""])("rejects namespace %s", namespace => expect(isValidPluginApiNamespace(namespace)).toBe(false));
  it.each(["/checkout", "../users", "%2e%2e/users", "foo/%2fusers", "foo\\bar"])("rejects ambiguous path %s", path => expect(() => pluginApiUrl("shop", path)).toThrow());
});
