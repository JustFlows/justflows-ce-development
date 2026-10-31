// SPDX-License-Identifier: MIT

import { EditorPanelSchema, type PluginEditorPanel } from "@justflows/sdk";
import { getDb } from "../database/db.js";

/** A content editor section from an active plugin, as the editor receives it. */
export interface EditorPanelEntry extends PluginEditorPanel {
  pluginId: string;
  /** Present when the panel embeds the plugin admin app. */
  catalogs?: Record<string, string>;
}

/**
 * Keep the panels a stored manifest declares that still match the schema.
 * Manifests are stored JSON that may predate it, so each panel is re-checked;
 * a plugin without `admin:extend` adds none.
 */
export function panelsFromManifest(manifest: Record<string, unknown>, pluginId: string): EditorPanelEntry[] {
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!permissions.includes("admin:extend") || !Array.isArray(manifest.editorPanels)) return [];
  const out: EditorPanelEntry[] = [];
  for (const raw of manifest.editorPanels.slice(0, 5)) {
    const parsed = EditorPanelSchema.safeParse(raw);
    if (parsed.success) out.push({ ...parsed.data, pluginId });
  }
  return out;
}

/** Manifests of the plugins active on a site, in plugin id order. Unreadable ones are skipped. */
export async function activePluginManifests(
  siteId: string,
): Promise<Array<{ pluginId: string; manifest: Record<string, unknown> }>> {
  const db = await getDb();
  const rows = await db.query<{ plugin_id: string; manifest: string | Record<string, unknown> | null }>(
    "SELECT plugin_id, manifest FROM plugins WHERE site_id = ? AND status = 'active' ORDER BY plugin_id",
    [siteId],
  );
  const out: Array<{ pluginId: string; manifest: Record<string, unknown> }> = [];
  for (const row of rows) {
    try {
      const manifest = typeof row.manifest === "string" ? (JSON.parse(row.manifest) as Record<string, unknown>) : (row.manifest ?? {});
      out.push({ pluginId: String(row.plugin_id), manifest });
    } catch {
      continue;
    }
  }
  return out;
}

/** Editor panels of the plugins active on a site, in plugin id order. */
export async function listEditorPanels(siteId: string): Promise<EditorPanelEntry[]> {
  const panels: EditorPanelEntry[] = [];
  for (const { pluginId, manifest } of await activePluginManifests(siteId)) {
    const catalogs = catalogsFromManifest(manifest, pluginId);
    for (const panel of panelsFromManifest(manifest, pluginId)) {
      panels.push(panel.app && catalogs ? { ...panel, catalogs } : panel);
    }
  }
  return panels;
}

/** Locale catalogs the embedded admin app can fetch. Paths stay under `/ext/<id>/admin/`. */
export function catalogsFromManifest(manifest: Record<string, unknown>, pluginId: string): Record<string, string> | undefined {
  const adminApp = manifest["adminApp"];
  if (!adminApp || typeof adminApp !== "object") return undefined;
  const locales = (adminApp as { locales?: unknown }).locales;
  if (!locales || typeof locales !== "object" || Array.isArray(locales)) return undefined;
  const catalogs: Record<string, string> = {};
  for (const [code, file] of Object.entries(locales)) {
    if (!/^[a-z]{2}(?:-[A-Za-z0-9]+)?$/.test(code)) continue;
    if (typeof file !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}\.json$/.test(file) || file.includes("..")) {
      continue;
    }
    catalogs[code] = `/ext/${pluginId}/admin/${file}`;
  }
  return Object.keys(catalogs).length > 0 ? catalogs : undefined;
}
