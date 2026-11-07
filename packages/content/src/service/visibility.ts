// SPDX-License-Identifier: MIT
import { z } from "zod";

const RoleSlug = z.string().trim().min(1).max(80);
const UserId = z.string().uuid();
const ParamValue = z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(100)]);

/** `<plugin id>:<rule id>`, as printed by the registry. */
export const CONTENT_VISIBILITY_RULE_ID_RE = /^[a-z0-9][a-z0-9.-]{0,79}:[a-z0-9][a-z0-9.-]{0,79}$/;

/** A safe reason code: never free text, so a plugin cannot put user data in it. */
export const CONTENT_VISIBILITY_REASON_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

export const ContentVisibilityRuleRefSchema = z
  .object({
    id: z.string().regex(CONTENT_VISIBILITY_RULE_ID_RE),
    /** `require` narrows: the viewer must pass. `grant` widens: passing lets the viewer in. */
    mode: z.enum(["require", "grant"]).default("require"),
    params: z.record(z.string().max(80), ParamValue).default({}),
  })
  .strict();
export type ContentVisibilityRuleRef = z.infer<typeof ContentVisibilityRuleRefSchema>;

export const ContentVisibilityPolicySchema = z
  .object({
    /** Who may view when no explicit rule below decides. */
    audience: z.enum(["everyone", "authenticated", "nobody"]).default("everyone"),
    allowRoles: z.array(RoleSlug).max(100).default([]),
    denyRoles: z.array(RoleSlug).max(100).default([]),
    allowUsers: z.array(UserId).max(500).default([]),
    denyUsers: z.array(UserId).max(500).default([]),
    rules: z.array(ContentVisibilityRuleRefSchema).max(20).default([]),
  })
  .strict();
export type ContentVisibilityPolicy = z.infer<typeof ContentVisibilityPolicySchema>;

/** Who is asking. Roles are empty for an anonymous visitor. */
export interface ContentVisibilityViewer {
  userId: string | null;
  roles: readonly string[];
  authenticated: boolean;
}

export const ANONYMOUS_VIEWER: ContentVisibilityViewer = Object.freeze({
  userId: null,
  roles: Object.freeze([]) as readonly string[],
  authenticated: false,
});

export type ContentVisibilityDecider = "default" | "audience" | "user" | "role" | "plugin";

export interface ContentVisibilityDecision {
  allowed: boolean;
  /** Stable code, safe to show an editor. Never shown to the visitor. */
  reason: string;
  decidedBy: ContentVisibilityDecider;
  /** The plugin rule that decided, when one did. */
  ruleId?: string;
}

/** What a rule answered. `failed` marks a host-side failure rather than a plugin's own denial. */
export interface ContentVisibilityRuleOutcome {
  effect: "allow" | "deny";
  reason: string;
  failed?: boolean;
}

export type ContentVisibilityRuleRunner = (
  rule: ContentVisibilityRuleRef,
) => Promise<ContentVisibilityRuleOutcome>;

/** True when this policy cannot keep anyone out, so it needs no evaluation or cache handling. */
export function isOpenVisibilityPolicy(policy: ContentVisibilityPolicy | null | undefined): boolean {
  if (!policy) return true;
  return (
    policy.audience === "everyone" &&
    policy.denyRoles.length === 0 &&
    policy.denyUsers.length === 0 &&
    policy.rules.every((rule) => rule.mode === "grant")
  );
}

/**
 * Decide one viewer against one policy. The first step that matches wins:
 *
 * 1. user denied, 2. user allowed, 3. role denied, 4. a `require` rule fails,
 * 5. role allowed, 6. a `grant` rule passes, 7. the audience.
 *
 * An explicit user entry is the operator naming one person, so it outranks
 * everything, including a plugin that is down. A `require` rule that cannot
 * answer denies. A `grant` rule that cannot answer simply grants nothing.
 */
export async function decideContentVisibility(
  policy: ContentVisibilityPolicy | null,
  viewer: ContentVisibilityViewer,
  runRule: ContentVisibilityRuleRunner,
): Promise<ContentVisibilityDecision> {
  if (isOpenVisibilityPolicy(policy)) return { allowed: true, reason: "public", decidedBy: "default" };
  const active = policy!;
  const { userId, roles } = viewer;

  if (userId && active.denyUsers.includes(userId)) {
    return { allowed: false, reason: "user_denied", decidedBy: "user" };
  }
  if (userId && active.allowUsers.includes(userId)) {
    return { allowed: true, reason: "user_allowed", decidedBy: "user" };
  }
  if (roles.some((role) => active.denyRoles.includes(role))) {
    return { allowed: false, reason: "role_denied", decidedBy: "role" };
  }
  for (const rule of active.rules) {
    if (rule.mode !== "require") continue;
    const outcome = await runRule(rule);
    if (outcome.effect !== "allow") {
      return { allowed: false, reason: outcome.reason, decidedBy: "plugin", ruleId: rule.id };
    }
  }
  if (roles.some((role) => active.allowRoles.includes(role))) {
    return { allowed: true, reason: "role_allowed", decidedBy: "role" };
  }
  let grantFailure: { reason: string; ruleId: string } | null = null;
  for (const rule of active.rules) {
    if (rule.mode !== "grant") continue;
    const outcome = await runRule(rule);
    if (outcome.effect === "allow") {
      return { allowed: true, reason: outcome.reason, decidedBy: "plugin", ruleId: rule.id };
    }
    if (outcome.failed) grantFailure ??= { reason: outcome.reason, ruleId: rule.id };
  }
  if (active.audience === "everyone") return { allowed: true, reason: "audience_everyone", decidedBy: "audience" };
  if (active.audience === "authenticated") {
    return viewer.authenticated
      ? { allowed: true, reason: "audience_authenticated", decidedBy: "audience" }
      : { allowed: false, reason: "authentication_required", decidedBy: "audience" };
  }
  return grantFailure
    ? { allowed: false, reason: grantFailure.reason, decidedBy: "plugin", ruleId: grantFailure.ruleId }
    : { allowed: false, reason: "not_allowed", decidedBy: "audience" };
}
