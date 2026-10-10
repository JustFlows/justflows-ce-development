// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { ContentTypeCacheControlSchema, cacheControlPolicy, ContentCacheFieldsSchema, effectiveContentCacheControl, validateContentCacheFields } from "../../src/service/cache-control.js";

describe("content-type Cache-Control", () => {
  it("inherits or canonicalizes bounded directives", () => {
    expect(ContentTypeCacheControlSchema.parse(null)).toBeNull();
    expect(ContentTypeCacheControlSchema.parse("PUBLIC, max-age=000300")).toBe("public, max-age=300");
    expect(cacheControlPolicy("public, max-age=300, s-maxage=60")).toMatchObject({ shared: true, ttl: 60 });
  });
  it.each(["private, max-age=300", "no-store", "no-cache, max-age=60", "public, max-age=0", "must-revalidate", "public, max-age=0, s-maxage=300"])("bypasses shared storage for %s", header => {
    expect(cacheControlPolicy(header).shared).toBe(false);
  });
  it.each(["", "public\r\nX-Header: unsafe", "public, private", "max-age=-1", "max-age=31536001", "max-age=10, max-age=20", "unknown", "no-store=1"])("rejects %s", header => {
    expect(ContentTypeCacheControlSchema.safeParse(header).success).toBe(false);
  });
});


describe("per-post cache policy", () => {
  it("applies post, type and site inheritance without weakening core privacy", () => {
    expect(effectiveContentCacheControl("post", { cacheControl: "private, no-store" }, "public, max-age=60")).toBe("private, no-store");
    expect(effectiveContentCacheControl("post", { cacheControl: null }, "public, max-age=60")).toBe("public, max-age=60");
    expect(effectiveContentCacheControl("post", {}, null)).toBeNull();
    expect(effectiveContentCacheControl("account", { cacheControl: "public, max-age=60" }, null)).toBe("private, no-store");
    expect(() => validateContentCacheFields("account", { cacheControl: "public, max-age=60" })).toThrow("locked");
  });
  it("validates metadata while preserving unrelated fields and fails closed on corrupt persisted values", () => {
    expect(ContentCacheFieldsSchema.parse({ title: "Untouched", cacheControl: "PUBLIC, max-age=60" })).toEqual({ title: "Untouched", cacheControl: "public, max-age=60" });
    expect(ContentCacheFieldsSchema.safeParse({ cacheControl: "public\r\nInjected: header" }).success).toBe(false);
    expect(effectiveContentCacheControl("page", { cacheControl: 100 }, "public, max-age=60")).toBe("private, no-store");
  });
});
