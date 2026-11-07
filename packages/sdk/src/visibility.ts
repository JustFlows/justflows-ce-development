// SPDX-License-Identifier: MIT

/**
 * Content visibility rules a plugin can add to the host's visibility policy.
 * See `docs/CONTENT_VISIBILITY.md`. Available from SDK 0.1.8.
 */

/** The visitor being evaluated. Holds no email, name, or other personal data. */
export interface ContentVisibilityViewerInfo {
  authenticated: boolean;
  /** Null for an anonymous visitor, and when an editor simulates a role. */
  userId: string | null;
  roles: readonly string[];
}

/** The item being evaluated. Metadata only: never its body or fields. */
export interface ContentVisibilitySubject {
  id: string;
  type: string;
  slug: string;
  locale: string;
  translationGroupId: string;
  status: string;
  authorId: string | null;
}

export type ContentVisibilityParams = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** Why the host is asking. A decision must not change with this value. */
export type ContentVisibilitySurface = "request" | "explain";

export interface ContentVisibilityRuleInput {
  siteId: string;
  /** Null only for a rule registered with `scope: "viewer"`. */
  content: ContentVisibilitySubject | null;
  viewer: ContentVisibilityViewerInfo;
  /** The values an operator saved on this rule. Validate them: they may predate your plugin's schema. */
  params: ContentVisibilityParams;
  request: { surface: ContentVisibilitySurface };
}

/**
 * What an evaluator returns. `reason` is a code matching
 * `^[a-z][a-z0-9_.-]{0,63}$`, shown to editors in the explanation tool. A
 * missing or malformed decision denies.
 */
export interface ContentVisibilityRuleDecision {
  effect: "allow" | "deny";
  reason: string;
}

export interface ContentVisibilityRuleOption {
  value: string;
  label: string;
}

/** One setting the admin shows for this rule. */
export interface ContentVisibilityRuleField {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  required?: boolean;
  /** Choices for a `select` field, loaded when an editor opens the rule. */
  options?: readonly ContentVisibilityRuleOption[] | (() => Promise<readonly ContentVisibilityRuleOption[]>);
}

export interface ContentVisibilityRuleDefinition {
  /** Unique within the plugin. Stored on policies as `<plugin id>:<id>`. */
  id: string;
  label: string;
  description?: string;
  /**
   * `item` (default) evaluates once per content item. `viewer` declares that
   * the answer depends only on the viewer and `params`, so the host evaluates
   * once per request and passes `content: null`. Prefer `viewer` when it is
   * true: listings stay fast and are not capped.
   */
  scope?: "item" | "viewer";
  fields?: readonly ContentVisibilityRuleField[];
  /** Answer within one second. Throwing, timing out, or a bad decision counts as a failure and denies. */
  evaluate(input: ContentVisibilityRuleInput): ContentVisibilityRuleDecision | Promise<ContentVisibilityRuleDecision>;
}

/** `ctx.visibility`. Requires the `content:read` permission. */
export interface PluginVisibilityApi {
  /** Register a rule type. Removed on deactivate; returns a function that removes it sooner. */
  registerRule(definition: ContentVisibilityRuleDefinition): () => void;
}
