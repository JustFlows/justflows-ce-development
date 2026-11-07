// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), content: vi.fn(), state: vi.fn(), resolver: vi.fn(), policies: vi.fn() }));
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query: mocks.query }) }));
vi.mock("../../../src/lib/content/visibility-policies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/content/visibility-policies.js")>()),
  loadVisibilityPolicies: mocks.policies,
}));
vi.mock("../../../src/lib/navigation/permalinks-db.js", () => ({ permalinkContent: mocks.content, getPermalinkState: mocks.state, createContentPermalinkResolver: mocks.resolver }));
import { contentCacheRules, contentCacheExclusions, matchContentCacheRule } from "../../../src/lib/cache/content-type-cache.js";

describe("content cache URL policies", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockReset();
    mocks.policies.mockResolvedValue({ types: new Map(), overrides: new Map(), restricted: false });
    mocks.state.mockResolvedValue({ redirects: { "/old": "1" } });
    mocks.resolver.mockResolvedValue(async (content: { id: string }) => `/pages/${content.id}`);
  });
  it("avoids reading content when all types inherit", async () => {
    mocks.query.mockResolvedValue([]);
    expect(await contentCacheRules("site-a")).toEqual([]);
    expect(mocks.content).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["site-a"]);
  });
  it("keeps a page with visibility rules out of every shared cache, whatever its type allows", async () => {
    const policy = { audience: "authenticated", allowRoles: [], denyRoles: [], allowUsers: [], denyUsers: [], rules: [] };
    mocks.policies.mockResolvedValue({ types: new Map(), overrides: new Map([["1", { groupId: "1", hash: "h", policy }]]), restricted: true });
    mocks.query.mockResolvedValueOnce([{ slug: "page", cache_control: "public, max-age=600" }]).mockResolvedValueOnce([]);
    mocks.content.mockResolvedValue([{ id: "1", type: "page" }, { id: "2", type: "page" }]);
    const rules = await contentCacheRules("site-a");
    expect(rules.find(rule => rule.id === "1")).toMatchObject({ header: "private, no-store", shared: false, ttl: 0 });
    expect(rules.find(rule => rule.id === "2")).toMatchObject({ shared: true });
  });
  it("marks a restricted page even when no type sets a cache policy", async () => {
    const policy = { audience: "nobody", allowRoles: [], denyRoles: [], allowUsers: [], denyUsers: [], rules: [] };
    mocks.policies.mockResolvedValue({ types: new Map([["post", { hash: "h", policy }]]), overrides: new Map(), restricted: true });
    mocks.query.mockResolvedValue([]);
    mocks.content.mockResolvedValue([{ id: "1", type: "post" }, { id: "2", type: "page" }]);
    expect((await contentCacheRules("site-a")).map(rule => rule.id)).toEqual(["1"]);
  });
  it("resolves many pages once and covers aliases, ids and pagination", async () => {
    mocks.query.mockResolvedValueOnce([{ slug: "page", cache_control: "private, no-store" }]).mockResolvedValueOnce([]);
    mocks.content.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), type: "page" })));
    const rules = await contentCacheRules("site-a");
    expect(rules).toHaveLength(100);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.state).toHaveBeenCalledTimes(1);
    expect(mocks.resolver).toHaveBeenCalledTimes(1);
    expect(matchContentCacheRule(rules, "/old/page/2/")?.id).toBe("1");
    expect(matchContentCacheRule(rules, "/", "1")?.id).toBe("1");
    expect(contentCacheExclusions(rules)).toContainEqual({ path: "/old", match: "exact" });
  });
  it("allows export only with positive shared freshness", async () => {
    mocks.query.mockResolvedValueOnce([{ slug: "page", cache_control: "public, max-age=60" }]).mockResolvedValueOnce([]);
    mocks.content.mockResolvedValue([{ id: "1", type: "page" }]);
    expect(contentCacheExclusions(await contentCacheRules("site-a"))).toEqual([]);
  });

  it("uses published per-post metadata over its type default, with bounded reads", async () => {
  mocks.query.mockReset();
  mocks.query.mockResolvedValueOnce([{ slug: "page", cache_control: "public, max-age=60" }]).mockResolvedValueOnce([
    { id: "1", fields: JSON.stringify({ cacheControl: "private, no-store" }) },
    { id: "2", fields: { cacheControl: "public, max-age=10" } },
  ]);
  mocks.content.mockResolvedValue([{ id: "1", type: "page" }, { id: "2", type: "page" }, { id: "3", type: "page" }]);
  const rules = await contentCacheRules("site-a");
  expect(rules.map(rule => [rule.id, rule.shared, rule.ttl])).toEqual([["1", false, 0], ["2", true, 10], ["3", true, 60]]);
  expect(contentCacheExclusions(rules)).toContainEqual({ path: "/pages/1", match: "exact" });
  expect(mocks.query).toHaveBeenCalledTimes(2);
});

it.each(["postgres", "mysql", "mariadb"])("finds post overrides even when types inherit, using %s JSON syntax", async driver => {
  vi.stubEnv("DB_DRIVER", driver);
  mocks.query.mockReset();
  mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "1", fields: { cacheControl: "no-store" } }]);
  mocks.content.mockResolvedValue([{ id: "1", type: "post" }]);
  expect((await contentCacheRules("site-a"))[0]?.shared).toBe(false);
  expect(mocks.query.mock.calls[1]?.[0]).toContain(driver === "postgres" ? "fields->>'cacheControl'" : "JSON_TYPE");
  expect(mocks.query.mock.calls[1]?.[1]).toEqual(["site-a"]);
  vi.unstubAllEnvs();
});

});
