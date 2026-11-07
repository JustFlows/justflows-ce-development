// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import {
  ANONYMOUS_VIEWER,
  ContentVisibilityPolicySchema,
  decideContentVisibility,
  isOpenVisibilityPolicy,
  type ContentVisibilityPolicy,
  type ContentVisibilityRuleOutcome,
} from "../../src/index.js";

const USER = "11111111-1111-4111-8111-111111111111";
const member = { userId: USER, roles: ["member"], authenticated: true };
const policy = (input: Record<string, unknown>): ContentVisibilityPolicy => ContentVisibilityPolicySchema.parse(input);
const allow: ContentVisibilityRuleOutcome = { effect: "allow", reason: "subscribed" };
const refuse: ContentVisibilityRuleOutcome = { effect: "deny", reason: "no_subscription" };
const broken: ContentVisibilityRuleOutcome = { effect: "deny", reason: "rule_error", failed: true };
const rule = (mode: "require" | "grant") => ({ id: "justflows.shop:subscription", mode });
const never = () => Promise.reject(new Error("rule must not run"));

describe("content visibility precedence", () => {
  it("treats no policy, and a policy that keeps nobody out, as public without running rules", async () => {
    expect(isOpenVisibilityPolicy(null)).toBe(true);
    expect(isOpenVisibilityPolicy(policy({ rules: [rule("grant")] }))).toBe(true);
    await expect(decideContentVisibility(null, ANONYMOUS_VIEWER, never)).resolves.toMatchObject({ allowed: true, reason: "public" });
  });

  it("lets a denied user lose to nothing, even an allowed role or an allowed entry", async () => {
    const decision = await decideContentVisibility(
      policy({ audience: "everyone", denyUsers: [USER], allowUsers: [USER], allowRoles: ["member"] }),
      member,
      never,
    );
    expect(decision).toEqual({ allowed: false, reason: "user_denied", decidedBy: "user" });
  });

  it("lets an allowed user pass a denied role and a required rule that is down", async () => {
    const decision = await decideContentVisibility(
      policy({ audience: "nobody", allowUsers: [USER], denyRoles: ["member"], rules: [rule("require")] }),
      member,
      never,
    );
    expect(decision).toEqual({ allowed: true, reason: "user_allowed", decidedBy: "user" });
  });

  it("puts a denied role above an allowed role", async () => {
    const decision = await decideContentVisibility(
      policy({ audience: "everyone", denyRoles: ["member"], allowRoles: ["member"] }),
      member,
      never,
    );
    expect(decision.reason).toBe("role_denied");
  });

  it("checks required rules before an allowed role", async () => {
    const decision = await decideContentVisibility(
      policy({ audience: "nobody", allowRoles: ["member"], rules: [rule("require")] }),
      member,
      async () => refuse,
    );
    expect(decision).toEqual({ allowed: false, reason: "no_subscription", decidedBy: "plugin", ruleId: rule("require").id });
  });

  it("then applies an allowed role, a grant rule, and the audience, in that order", async () => {
    const roleWins = await decideContentVisibility(policy({ audience: "nobody", allowRoles: ["member"], rules: [rule("grant")] }), member, never);
    expect(roleWins.reason).toBe("role_allowed");
    const grantWins = await decideContentVisibility(policy({ audience: "nobody", rules: [rule("grant")] }), member, async () => allow);
    expect(grantWins).toMatchObject({ allowed: true, decidedBy: "plugin", reason: "subscribed" });
    const audience = await decideContentVisibility(policy({ audience: "authenticated" }), member, never);
    expect(audience.reason).toBe("audience_authenticated");
  });

  it("denies a required rule that failed, for every viewer", async () => {
    for (const viewer of [ANONYMOUS_VIEWER, member]) {
      const decision = await decideContentVisibility(policy({ rules: [rule("require")] }), viewer, async () => broken);
      expect(decision).toMatchObject({ allowed: false, reason: "rule_error" });
    }
  });

  it("does not let a failed grant rule open or close anything by itself", async () => {
    const open = await decideContentVisibility(policy({ audience: "authenticated", rules: [rule("grant")] }), member, async () => broken);
    expect(open.allowed).toBe(true);
    const closed = await decideContentVisibility(policy({ audience: "nobody", rules: [rule("grant")] }), member, async () => broken);
    expect(closed).toMatchObject({ allowed: false, reason: "rule_error" });
  });

  it("keeps anonymous visitors out of everything that needs an identity", async () => {
    expect((await decideContentVisibility(policy({ audience: "authenticated" }), ANONYMOUS_VIEWER, never)).reason).toBe("authentication_required");
    expect((await decideContentVisibility(policy({ audience: "nobody", allowRoles: ["member"] }), ANONYMOUS_VIEWER, never)).reason).toBe("not_allowed");
    expect((await decideContentVisibility(policy({ denyRoles: ["member"] }), ANONYMOUS_VIEWER, never)).allowed).toBe(true);
  });

  it("runs each rule only when its step is reached", async () => {
    const run = vi.fn(async () => allow);
    await decideContentVisibility(policy({ denyRoles: ["member"], rules: [rule("require")] }), member, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects unknown keys and malformed ids", () => {
    expect(ContentVisibilityPolicySchema.safeParse({ audience: "everyone", extra: true }).success).toBe(false);
    expect(ContentVisibilityPolicySchema.safeParse({ allowUsers: ["not-a-uuid"] }).success).toBe(false);
    expect(ContentVisibilityPolicySchema.safeParse({ rules: [{ id: "no-namespace" }] }).success).toBe(false);
  });
});
