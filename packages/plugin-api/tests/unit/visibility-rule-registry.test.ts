// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { PluginVisibilityRuleRegistry } from "../../src/visibility-rule-registry.js";

const rule = { id: "active-subscription", label: "Active subscription", evaluate: () => ({ effect: "allow" as const, reason: "ok" }) };

describe("visibility rule registry", () => {
  it("namespaces a rule under its plugin, so one plugin cannot answer for another", () => {
    const registry = new PluginVisibilityRuleRegistry();
    registry.register("justflows.shop", rule);
    registry.register("justflows.other", rule);
    expect(registry.get("justflows.shop:active-subscription")?.pluginId).toBe("justflows.shop");
    expect(registry.get("justflows.other:active-subscription")?.pluginId).toBe("justflows.other");
  });

  it("refuses duplicates and malformed definitions", () => {
    const registry = new PluginVisibilityRuleRegistry();
    registry.register("justflows.shop", rule);
    expect(() => registry.register("justflows.shop", rule)).toThrow(/already registered/);
    expect(() => registry.register("justflows.shop", { ...rule, id: "Bad Id" })).toThrow(/invalid id/);
    expect(() => registry.register("justflows.shop", { ...rule, id: "x", label: " " })).toThrow(/label/);
    expect(() => registry.register("justflows.shop", { ...rule, id: "y", evaluate: undefined as never })).toThrow(/evaluator/);
    expect(() => registry.register("justflows.shop", { ...rule, id: "z", scope: "site" as never })).toThrow(/scope/);
  });

  it("removes a rule through its disposer and when its plugin stops", () => {
    const registry = new PluginVisibilityRuleRegistry();
    registry.register("justflows.shop", rule)();
    expect(registry.all()).toEqual([]);
    registry.register("justflows.shop", rule);
    registry.removePlugin("justflows.shop");
    expect(registry.get("justflows.shop:active-subscription")).toBeUndefined();
  });
});
