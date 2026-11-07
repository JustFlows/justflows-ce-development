// SPDX-License-Identifier: MIT

import type { ContentVisibilityRuleDefinition } from "@justflows/sdk";

const RULE_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/;

export interface RegisteredVisibilityRule extends ContentVisibilityRuleDefinition {
  pluginId: string;
  registryId: string;
}

/** One owner per rule id, so a second plugin can never answer for another plugin's rule. */
export class PluginVisibilityRuleRegistry {
  private readonly rules = new Map<string, RegisteredVisibilityRule>();

  register(pluginId: string, input: ContentVisibilityRuleDefinition): () => void {
    if (!RULE_ID.test(input?.id ?? "")) throw new Error(`Plugin "${pluginId}" registered a visibility rule with an invalid id`);
    if (!input.label?.trim()) throw new Error(`Plugin "${pluginId}" registered visibility rule "${input.id}" without a label`);
    if (typeof input.evaluate !== "function") {
      throw new Error(`Plugin "${pluginId}" registered visibility rule "${input.id}" without an evaluator`);
    }
    if (input.scope !== undefined && input.scope !== "item" && input.scope !== "viewer") {
      throw new Error(`Plugin "${pluginId}" registered visibility rule "${input.id}" with an invalid scope`);
    }
    const registryId = `${pluginId}:${input.id}`;
    if (this.rules.has(registryId)) throw new Error(`Visibility rule "${registryId}" is already registered`);
    this.rules.set(registryId, { ...input, pluginId, registryId });
    return () => this.rules.delete(registryId);
  }

  get(registryId: string): RegisteredVisibilityRule | undefined {
    return this.rules.get(registryId);
  }

  all(): RegisteredVisibilityRule[] {
    return [...this.rules.values()];
  }

  removePlugin(pluginId: string): void {
    for (const [registryId, rule] of this.rules) {
      if (rule.pluginId === pluginId) this.rules.delete(registryId);
    }
  }
}
