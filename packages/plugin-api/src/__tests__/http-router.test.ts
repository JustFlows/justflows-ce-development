import { describe, expect, it } from "vitest";
import { PluginHttpRouter } from "../http-router.js";

describe("PluginHttpRouter", () => {
  it("rejects well-known path conflicts", () => {
    const router = new PluginHttpRouter();
    router.register("justflows.seo", "GET", "/sitemap.xml", async () => ({ body: "a" }));
    expect(() =>
      router.register("justflows.other", "GET", "/sitemap.xml", async () => ({ body: "b" })),
    ).toThrow(/already claimed/);
  });

  it("matches path parameters and prefers the more specific pattern", () => {
    const router = new PluginHttpRouter();
    router.register("acme.shop", "GET", "/api/v1/shop/products/:id", async () => ({ body: "one" }));
    router.register("acme.shop", "PATCH", "products/:id", async () => ({ body: "patch" }));

    const named = router.match("GET", "/api/v1/shop/products/sku-1");
    expect(named?.params).toEqual({ id: "sku-1" });

    const prefixed = router.match("PATCH", "/ext/acme.shop/products/sku-1");
    expect(prefixed?.route.pluginId).toBe("acme.shop");
    expect(prefixed?.params).toEqual({ id: "sku-1" });
  });
});
