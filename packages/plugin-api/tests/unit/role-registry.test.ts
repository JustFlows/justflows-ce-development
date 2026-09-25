import { describe, expect, it } from "vitest";
import { PluginRoleRegistry } from "../../src/role-registry.js";

describe("PluginRoleRegistry", () => {
  it("registers a role and removes it with its plugin", () => {
    const registry = new PluginRoleRegistry();
    registry.register("justflows.shop", {
      id: "customer",
      label: "Customer",
      description: "Registered shop customer.",
      capabilities: [],
    });
    expect(registry.get("customer")).toMatchObject({
      id: "customer",
      pluginId: "justflows.shop",
      label: "Customer",
      capabilities: [],
    });
    registry.removePlugin("justflows.shop");
    expect(registry.all()).toEqual([]);
  });

  it("rejects core overrides, invalid ids, and cross-plugin collisions", () => {
    const registry = new PluginRoleRegistry();
    expect(() => registry.register("acme.bad", { id: "subscriber", label: "Subscriber" })).toThrow(
      /core role/,
    );
    expect(() => registry.register("acme.bad", { id: "Bad Role", label: "Bad" })).toThrow(
      /lowercase/,
    );
    expect(() =>
      registry.register("acme.bad", { id: "customer", label: "Customer", capabilities: ["nope"] }),
    ).toThrow(/invalid capability/);
    registry.register("acme.one", { id: "customer", label: "Customer" });
    expect(() => registry.register("acme.two", { id: "customer", label: "Customer" })).toThrow(
      /already registered/,
    );
  });
});
