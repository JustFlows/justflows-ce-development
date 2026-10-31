// SPDX-License-Identifier: MIT

import { WorkspacePanelSchema, type PluginWorkspacePanel } from "@justflows/sdk";
import { activePluginManifests, catalogsFromManifest } from "./editor-panels.js";

/** A Platform → Workspace card from an active plugin, as the admin receives it. */
export interface WorkspacePanelEntry extends PluginWorkspacePanel {
  pluginId: string;
  catalogs?: Record<string, string>;
}

/**
 * Keep the workspace panels a stored manifest declares that still match the
 * schema. A plugin without `admin:extend` adds none.
 */
export function workspacePanelsFromManifest(manifest: Record<string, unknown>, pluginId: string): WorkspacePanelEntry[] {
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!permissions.includes("admin:extend") || !Array.isArray(manifest.workspacePanels)) return [];
  const catalogs = catalogsFromManifest(manifest, pluginId);
  const out: WorkspacePanelEntry[] = [];
  for (const raw of manifest.workspacePanels.slice(0, 5)) {
    const parsed = WorkspacePanelSchema.safeParse(raw);
    if (parsed.success) out.push({ ...parsed.data, pluginId, ...(catalogs ? { catalogs } : {}) });
  }
  return out;
}

/** Workspace panels of the plugins active on a site, in plugin id order. */
export async function listWorkspacePanels(siteId: string): Promise<WorkspacePanelEntry[]> {
  const panels: WorkspacePanelEntry[] = [];
  for (const { pluginId, manifest } of await activePluginManifests(siteId)) {
    panels.push(...workspacePanelsFromManifest(manifest, pluginId));
  }
  return panels;
}
