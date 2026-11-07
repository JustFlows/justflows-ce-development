// SPDX-License-Identifier: GPL-2.0-or-later
import type { PluginContext } from "@justflows/sdk";

/**
 * A custom content visibility rule, registered through the public SDK.
 *
 * Not enabled by this zero-permission example: `ctx.visibility` needs the
 * `content:read` permission. To try it, add that permission to the manifest
 * and call `registerVisibilityRuleExample(ctx)` from `activate()`. The rule
 * then appears under Visibility on a content type or entry.
 *
 * See docs/CONTENT_VISIBILITY.md.
 */
export function registerVisibilityRuleExample(ctx: PluginContext): () => void {
  return ctx.visibility.registerRule({
    id: "team-member",
    label: "Team members",
    description: "Only members of the chosen team.",
    /** The answer depends only on the viewer, so a listing asks once, not once per item. */
    scope: "viewer",
    fields: [
      {
        name: "team",
        label: "Team",
        type: "select",
        required: true,
        options: [
          { value: "editor", label: "Editorial" },
          { value: "administrator", label: "Operations" },
        ],
      },
    ],
    evaluate({ viewer, params }) {
      if (!viewer.authenticated) return { effect: "deny", reason: "sign_in_required" };
      const team = typeof params["team"] === "string" ? params["team"] : "";
      return viewer.roles.includes(team)
        ? { effect: "allow", reason: "team_member" }
        : { effect: "deny", reason: "not_on_team" };
    },
  });
}
