// SPDX-License-Identifier: MIT
import { ROLE_CAPABILITIES } from "@justflows/sdk";
import { USER_ROLE_VALUES } from "./rbac.js";

const CORE_LABELS: Record<string, string> = {
  subscriber: "Subscriber",
  contributor: "Contributor",
  author: "Author",
  editor: "Editor",
  administrator: "Administrator",
};

export interface AssignableRole {
  id: string;
  label: string;
  pluginId: string | null;
  capabilities: readonly string[];
}

/** Core roles plus roles registered by active plugins. */
export async function listAssignableRoles(): Promise<AssignableRole[]> {
  const { getPluginLoader } = await import("../plugins/plugin-runtime.js");
  const plugin = getPluginLoader()?.roleRegistry.all() ?? [];
  return [
    ...USER_ROLE_VALUES.map((id) => ({
      id,
      label: CORE_LABELS[id] ?? id,
      pluginId: null,
      capabilities: ROLE_CAPABILITIES[id] ?? [],
    })),
    ...plugin.map((role) => ({
      id: role.id,
      label: role.label,
      pluginId: role.pluginId,
      capabilities: role.capabilities,
    })),
  ];
}

export async function isAssignableRole(value: string): Promise<boolean> {
  return (await listAssignableRoles()).some((role) => role.id === value);
}
