// SPDX-License-Identifier: MIT
import { ROLE_CAPABILITIES, type PluginRoleDefinition, type UserCapability } from "@justflows/sdk";

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const CAPABILITY = /^[a-z][a-z0-9.-]{0,79}(?::[a-z][a-z0-9.-]{0,79}){1,3}$/;
const CORE = new Set<string>(Object.keys(ROLE_CAPABILITIES));

export type RegisteredPluginRole = PluginRoleDefinition & {
  pluginId: string;
  capabilities: readonly UserCapability[];
};

export class PluginRoleRegistry {
  private readonly definitions = new Map<string, RegisteredPluginRole>();

  register(pluginId: string, definition: PluginRoleDefinition): void {
    const id = String(definition.id);
    if (!ID.test(id)) {
      throw new Error(
        `Plugin "${pluginId}" role "${id}" must be 2–32 lowercase letters, digits, and hyphens`,
      );
    }
    if (CORE.has(id)) {
      throw new Error(`Plugin "${pluginId}" cannot replace core role "${id}"`);
    }
    const existing = this.definitions.get(id);
    if (existing && existing.pluginId !== pluginId) {
      throw new Error(`Role "${id}" is already registered by plugin "${existing.pluginId}"`);
    }
    const label = String(definition.label ?? "").trim().slice(0, 60);
    if (label.length < 2) {
      throw new Error(`Plugin "${pluginId}" role "${id}" needs a label`);
    }
    const capabilities = [...new Set((definition.capabilities ?? []).map(String))];
    const invalid = capabilities.find((capability) => !CAPABILITY.test(capability));
    if (invalid) {
      throw new Error(`Plugin "${pluginId}" role "${id}" has invalid capability "${invalid}"`);
    }
    const description = definition.description?.trim().slice(0, 300);
    this.definitions.set(id, {
      id,
      pluginId,
      label,
      ...(description ? { description } : {}),
      capabilities,
    });
  }

  removePlugin(pluginId: string): void {
    for (const [id, definition] of this.definitions) {
      if (definition.pluginId === pluginId) this.definitions.delete(id);
    }
  }

  get(id: string): RegisteredPluginRole | undefined {
    return this.definitions.get(id);
  }

  all(): RegisteredPluginRole[] {
    return [...this.definitions.values()];
  }
}
