import { describe, expect, it } from "vitest";
import { PluginHttpRouter } from "../../src/http-router.js";

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

  it("stores the policy the plugin registered and drops it with the plugin", () => {
    const router = new PluginHttpRouter();
    router.register("acme.shop", "POST", "payments/hooks/:gateway/:token", async () => ({ body: "ok" }), {
      csrf: false,
      rawBody: true,
      rateLimit: { limit: 60, windowMs: 60_000, key: "payment-hook" },
    });

    const matched = router.match("POST", "/ext/acme.shop/payments/hooks/stripe/token");
    expect(matched?.route.csrf).toBe(false);
    expect(matched?.route.rawBody).toBe(true);
    expect(matched?.route.rateLimit).toEqual({ limit: 60, windowMs: 60_000, key: "payment-hook" });

    router.removePlugin("acme.shop");
    expect(router.match("POST", "/ext/acme.shop/payments/hooks/stripe/token")).toBeUndefined();
  });

  it("keeps a binary body limit for uploads and refuses one out of range", () => {
    const router = new PluginHttpRouter();
    router.register("acme.shop", "POST", "files/:id", async () => ({ body: "ok" }), { binaryBody: { maxBytes: 50_000_000 } });
    expect(router.match("POST", "/ext/acme.shop/files/1")?.route.binaryBody).toEqual({ maxBytes: 50_000_000 });
    expect(() =>
      router.register("acme.shop", "POST", "big", async () => ({ body: "x" }), { binaryBody: { maxBytes: 2 * 1024 ** 3 } }),
    ).toThrow(/maxBytes/);
    expect(() =>
      router.register("acme.shop", "POST", "both", async () => ({ body: "x" }), { rawBody: true, binaryBody: { maxBytes: 10 } }),
    ).toThrow(/cannot combine/);
  });

  it("rejects a rate limit that would not hold", () => {
    const router = new PluginHttpRouter();
    expect(() =>
      router.register("acme.shop", "POST", "cart/items", async () => ({ body: "ok" }), {
        rateLimit: { limit: 0, windowMs: 60_000 },
      }),
    ).toThrow(/rate limit/);
    expect(() =>
      router.register("acme.shop", "POST", "cart/items", async () => ({ body: "ok" }), {
        rateLimit: { limit: 30, windowMs: 60_000, key: "../cart" },
      }),
    ).toThrow(/rate-limit key/);
  });
});


describe("neutral plugin API namespaces", () => {
  it("shares handlers, parameters and policies with legacy aliases", () => {
    const router = new PluginHttpRouter(); router.setApiNamespace("justflows.shop", "shop");
    const handler = async () => ({ body: "ok" });
    router.register("justflows.shop", "POST", "checkout/:id", handler, { csrf: false, rawBody: true, rateLimit: { limit: 20, windowMs: 60000 } });
    const alias = router.match("POST", "/api/shop/checkout/123");
    const legacy = router.match("POST", "/ext/justflows.shop/checkout/123");
    expect(alias).toEqual(legacy); expect(alias?.route.handler).toBe(handler);
    expect(router.url("justflows.shop", "checkout")).toBe("/api/shop/checkout");
    expect(alias?.route.rawBody).toBe(true); expect(alias?.route.csrf).toBe(false);
    router.removePlugin("justflows.shop"); expect(router.match("POST", "/api/shop/checkout/123")).toBeUndefined();
    router.setApiNamespace("justflows.other", "shop");
  });
  it("rejects reserved namespaces, duplicate owners and overlapping explicit routes", () => {
    const router = new PluginHttpRouter();
    expect(() => router.setApiNamespace("justflows.shop", "users")).toThrow(/reserved/);
    router.setApiNamespace("justflows.shop", "shop");
    expect(() => router.setApiNamespace("justflows.other", "shop")).toThrow(/claimed/);
    expect(() => router.register("justflows.other", "GET", "/api/shop/checkout", async () => ({}))).toThrow(/claimed/);
    router.register("justflows.shop", "GET", "checkout", async () => ({}));
    expect(() => router.register("justflows.shop", "GET", "/api/shop/checkout", async () => ({}))).toThrow(/claimed/);
  });
  it("preserves legacy defaults for plugins without a namespace", () => {
    const router = new PluginHttpRouter();
    expect(router.url("justflows.example", "read")).toBe("/ext/justflows.example/read");
    expect(router.isPublicApiPath("/api/users")).toBe(false);
  });
});
