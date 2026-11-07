// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { ContentVisibilityRuleDefinition, ContentVisibilityRuleInput, PluginContext } from "@justflows/sdk";
import { registerVisibilityRuleExample } from "../../src/visibility-rule-example.js";

function registered(): ContentVisibilityRuleDefinition {
  const registerRule = vi.fn((_definition: ContentVisibilityRuleDefinition) => () => undefined);
  registerVisibilityRuleExample({ visibility: { registerRule } } as unknown as PluginContext);
  return registerRule.mock.calls[0]![0];
}

const input = (viewer: ContentVisibilityRuleInput["viewer"], team: string): ContentVisibilityRuleInput => ({
  siteId: "site",
  content: null,
  viewer,
  params: { team },
  request: { surface: "request" },
});

describe("visibility rule example", () => {
  it("registers through the public SDK as a viewer-scoped rule", () => {
    expect(registered()).toMatchObject({ id: "team-member", scope: "viewer" });
  });

  it("answers with a structured decision and a safe reason code", async () => {
    const rule = registered();
    expect(await rule.evaluate(input({ authenticated: false, userId: null, roles: [] }, "editor"))).toEqual({ effect: "deny", reason: "sign_in_required" });
    expect(await rule.evaluate(input({ authenticated: true, userId: "u", roles: ["editor"] }, "editor"))).toEqual({ effect: "allow", reason: "team_member" });
    expect(await rule.evaluate(input({ authenticated: true, userId: "u", roles: ["subscriber"] }, "editor"))).toEqual({ effect: "deny", reason: "not_on_team" });
  });
});
