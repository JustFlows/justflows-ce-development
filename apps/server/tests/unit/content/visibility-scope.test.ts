// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANONYMOUS_VIEWER, ContentVisibilityPolicySchema, type ContentVisibilityPolicy } from "@justflows/content";
import { PluginVisibilityRuleRegistry } from "@justflows/plugin-api";

const state = vi.hoisted(() => ({
  types: new Map<string, { visibility: unknown }>(),
  overrides: [] as Array<{ group_id: string; policy: string; policy_hash: string }>,
  contentRows: [] as Array<Record<string, unknown>>,
  registry: null as unknown,
  tenant: undefined as unknown,
}));

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    query: async (sql: string) => {
      if (sql.includes("policy_hash FROM content_visibility")) return state.overrides;
      if (sql.includes("FROM content")) return state.contentRows;
      return [];
    },
  }),
}));
vi.mock("../../../src/lib/content/content-types-db.js", () => ({ getContentTypeSettingsMap: async () => state.types }));
vi.mock("../../../src/lib/cache/jf-cache.js", () => ({
  getJfCache: () => ({ remember: (_key: string, _ttl: number, load: () => Promise<unknown>) => load(), invalidate: async () => undefined }),
}));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  ensurePluginRuntime: async () => undefined,
  getPluginLoader: () => ({ visibilityRuleRegistry: state.registry }),
}));
vi.mock("../../../src/lib/tenancy/context.js", () => ({ getTenantContext: () => state.tenant }));
vi.mock("../../../src/lib/content/visibility-viewer.js", () => ({
  currentVisibilityViewer: async () => ANONYMOUS_VIEWER,
  visibilityRequestMemo: () => undefined,
}));

import { explainContentVisibility, getVisibilityScope, isOpenToEveryone } from "../../../src/lib/content/visibility-scope.js";
import { visibilityPolicyHash } from "../../../src/lib/content/visibility-policies.js";

const SITE = "site-1";
const USER = "11111111-1111-4111-8111-111111111111";
const member = { userId: USER, roles: ["member"], authenticated: true };
const parse = (input: Record<string, unknown>): ContentVisibilityPolicy => ContentVisibilityPolicySchema.parse(input);
const post = (id: string, translationGroupId: string | null = null) => ({ id, type: "post", translationGroupId });
const override = (groupId: string, input: Record<string, unknown>) => {
  const policy = parse(input);
  state.overrides.push({ group_id: groupId, policy: JSON.stringify(policy), policy_hash: visibilityPolicyHash(policy) });
};
const registry = () => state.registry as PluginVisibilityRuleRegistry;
const RULE = "justflows.shop:subscribed";

beforeEach(() => {
  state.types = new Map();
  state.overrides = [];
  state.contentRows = [];
  state.registry = new PluginVisibilityRuleRegistry();
  state.tenant = undefined;
});

describe("visibility scope", () => {
  it("costs nothing on a site with no rules", async () => {
    const scope = await getVisibilityScope(SITE);
    expect(scope.restricted).toBe(false);
    expect(scope.allows(post("a"))).toBe(true);
    expect(scope.sql("c")).toEqual({ sql: "1 = 1", params: [] });
  });

  it("does not count an open override as a restriction", async () => {
    override("a", { audience: "everyone" });
    expect((await getVisibilityScope(SITE)).restricted).toBe(false);
  });

  it("hides a type from anonymous visitors and shows it to a matching role", async () => {
    state.types.set("post", { visibility: parse({ audience: "nobody", allowRoles: ["member"] }) });
    const anonymous = await getVisibilityScope(SITE, ANONYMOUS_VIEWER);
    expect(anonymous.allows(post("a"))).toBe(false);
    expect(anonymous.allows({ id: "b", type: "page" })).toBe(true);
    expect(anonymous.sql("c").sql).toContain("c.type NOT IN (?)");
    expect((await getVisibilityScope(SITE, member)).allows(post("a"))).toBe(true);
    expect((await getVisibilityScope(SITE, member)).sql("c").sql).toBe("1 = 1");
  });

  it("lets an item override replace the type default in both directions", async () => {
    state.types.set("post", { visibility: parse({ audience: "authenticated" }) });
    override("open", { audience: "everyone" });
    override("locked", { audience: "nobody" });
    const anonymous = await getVisibilityScope(SITE, ANONYMOUS_VIEWER);
    expect(anonymous.allows(post("open"))).toBe(true);
    expect(anonymous.allows(post("other"))).toBe(false);
    const signedIn = await getVisibilityScope(SITE, member);
    expect(signedIn.allows(post("locked"))).toBe(false);
    expect(signedIn.allows(post("other"))).toBe(true);
  });

  it("applies one override to every translation in the group", async () => {
    override("group", { audience: "nobody" });
    const scope = await getVisibilityScope(SITE, ANONYMOUS_VIEWER);
    expect(scope.allows(post("en", "group"))).toBe(false);
    expect(scope.allows(post("nl", "group"))).toBe(false);
    expect(scope.sql().sql).toContain("COALESCE(translation_group_id, id) NOT IN");
  });

  it("locks an item whose stored rule cannot be read", async () => {
    state.overrides.push({ group_id: "bad", policy: "{not json", policy_hash: "h" });
    const scope = await getVisibilityScope(SITE, member);
    expect(scope.restricted).toBe(true);
    expect(scope.allows(post("bad"))).toBe(false);
  });

  it("keeps parameters aligned with placeholders in the SQL", async () => {
    state.types.set("post", { visibility: parse({ audience: "authenticated" }) });
    override("open", { audience: "everyone" });
    override("locked", { audience: "nobody" });
    const { sql, params } = (await getVisibilityScope(SITE, ANONYMOUS_VIEWER)).sql("c");
    expect(sql.split("?").length - 1).toBe(params.length);
  });

  describe("plugin rules", () => {
    const required = { audience: "everyone", rules: [{ id: RULE, mode: "require" }] };

    it("denies when the rule is not registered", async () => {
      override("a", required);
      expect((await getVisibilityScope(SITE, member)).allows(post("a"))).toBe(false);
    });

    it("denies when the owning plugin is off for this site", async () => {
      registry().register("justflows.shop", { id: "subscribed", label: "S", scope: "viewer", evaluate: () => ({ effect: "allow", reason: "ok" }) });
      override("a", required);
      state.tenant = { activePluginIds: new Set<string>() };
      expect((await getVisibilityScope(SITE, member)).allows(post("a"))).toBe(false);
      state.tenant = { activePluginIds: null };
      expect((await getVisibilityScope(SITE, member)).allows(post("a"))).toBe(false);
      state.tenant = { activePluginIds: new Set(["justflows.shop"]) };
      expect((await getVisibilityScope(SITE, member)).allows(post("a"))).toBe(true);
    });

    it.each([
      ["throws", () => { throw new Error("boom"); }],
      ["returns nothing", () => undefined],
      ["returns a bad effect", () => ({ effect: "maybe", reason: "ok" })],
      ["puts free text in the reason", () => ({ effect: "allow", reason: "Hello jane@example.com" })],
    ])("denies when the evaluator %s", async (_name, evaluate) => {
      registry().register("justflows.shop", { id: "subscribed", label: "S", scope: "viewer", evaluate: evaluate as never });
      override("a", required);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect((await getVisibilityScope(SITE, member)).allows(post("a"))).toBe(false);
      spy.mockRestore();
    });

    it("denies when the evaluator never answers", async () => {
      vi.useFakeTimers();
      registry().register("justflows.shop", { id: "subscribed", label: "S", scope: "viewer", evaluate: () => new Promise(() => undefined) });
      override("a", required);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const pending = getVisibilityScope(SITE, member);
      await vi.advanceTimersByTimeAsync(1100);
      expect((await pending).allows(post("a"))).toBe(false);
      spy.mockRestore();
      vi.useRealTimers();
    });

    it("gives a viewer-scoped rule one call however many items use it", async () => {
      const evaluate = vi.fn(() => ({ effect: "allow" as const, reason: "ok" }));
      registry().register("justflows.shop", { id: "subscribed", label: "S", scope: "viewer", evaluate });
      for (let index = 0; index < 25; index++) override(`g${index}`, required);
      const scope = await getVisibilityScope(SITE, member);
      expect(scope.allows(post("g7"))).toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0]).toMatchObject([{ content: null, viewer: { userId: USER }, siteId: SITE }]);
    });

    it("evaluates a per-item rule once per item, with metadata only", async () => {
      const evaluate = vi.fn(({ content }: { content: { id: string } | null }) => ({ effect: content?.id === "yes" ? ("allow" as const) : ("deny" as const), reason: "ok" }));
      registry().register("justflows.shop", { id: "subscribed", label: "S", evaluate: evaluate as never });
      state.types.set("post", { visibility: parse(required) });
      state.contentRows = [
        { id: "yes", type: "post", slug: "yes", locale: "en", translation_group_id: null, status: "published", author_id: null, blocks: "secret", fields: "secret" },
        { id: "no", type: "post", slug: "no", locale: "en", translation_group_id: null, status: "published", author_id: null },
      ];
      const scope = await getVisibilityScope(SITE, member);
      expect(scope.allows(post("yes"))).toBe(true);
      expect(scope.allows(post("no"))).toBe(false);
      expect(scope.allows(post("beyond-the-cap"))).toBe(false);
      const { sql, params } = scope.sql("c");
      expect(sql).toContain("c.id IN (?)");
      expect(params).toContain("yes");
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(Object.keys(evaluate.mock.calls[0]![0].content!).sort()).toEqual(["authorId", "id", "locale", "slug", "status", "translationGroupId", "type"]);
    });

    it("stops asking a rule that failed, so a long listing does not wait on it per item", async () => {
      const evaluate = vi.fn(() => { throw new Error("boom"); });
      registry().register("justflows.shop", { id: "subscribed", label: "S", evaluate: evaluate as never });
      state.types.set("post", { visibility: parse(required) });
      state.contentRows = Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, type: "post", slug: "s", locale: "en", status: "published" }));
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await getVisibilityScope(SITE, member);
      expect(evaluate).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("never lets a plugin change what it was handed", async () => {
      let frozen = false;
      registry().register("justflows.shop", {
        id: "subscribed", label: "S", scope: "viewer",
        evaluate: ({ viewer, params }) => { frozen = Object.isFrozen(viewer) && Object.isFrozen(params); return { effect: "allow", reason: "ok" }; },
      });
      override("a", required);
      await getVisibilityScope(SITE, member);
      expect(frozen).toBe(true);
    });
  });

  it("explains a decision with the rule source", async () => {
    state.types.set("post", { visibility: parse({ audience: "authenticated" }) });
    const row = { id: "a", type: "post", slug: "a", locale: "en", translation_group_id: null, status: "published", author_id: null };
    await expect(explainContentVisibility(SITE, row, ANONYMOUS_VIEWER)).resolves.toMatchObject({ allowed: false, reason: "authentication_required", source: "type" });
    override("a", { audience: "everyone", denyUsers: [USER] });
    await expect(explainContentVisibility(SITE, row, member)).resolves.toMatchObject({ allowed: false, reason: "user_denied", source: "item" });
  });

  it("keeps anything short of fully public away from external search", async () => {
    override("a", { denyRoles: ["member"] });
    await expect(isOpenToEveryone(SITE, post("a"))).resolves.toBe(false);
    await expect(isOpenToEveryone(SITE, post("b"))).resolves.toBe(true);
  });
});
