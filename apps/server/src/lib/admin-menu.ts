// SPDX-License-Identifier: MIT

import type { PluginAdminMenuItem } from "@justflows/sdk";
import { getDb } from "./db.js";
import type { PluginRow } from "./plugins-db.js";

/**
 * An admin nav entry as the SSR/hydrated admin consumes it: the owning plugin travels with the
 * item so the UI can attribute (and the host can de-duplicate) a page.
 */
export interface AdminMenuEntry extends PluginAdminMenuItem {
  pluginId: string;
  /** Copied from the plugin manifest so nested pages do not mount the setup wizard. */
  setupPath?: string;
}

const ADMIN_MENU_DOMAIN_SET = new Set([
  "content",
  "commerce",
  "appearance",
  "extensions",
  "security",
  "system",
]);

/**
 * A plugin owns its admin pages, but only while active: an installed-but-never-
 * activated plugin, a deactivated one, or one in error state serves nothing
 * behind the page.
 */
const MENU_VISIBLE_STATUSES = new Set<PluginRow["status"]>(["active"]);

const MENU_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MENU_PATH_RE = /^\/admin\/[a-z0-9][a-z0-9\-/]*$/;
const CONTENT_TYPE_SLUG_RE = /^[a-z][a-z0-9-]{0,59}$/;

/**
 * Admin pages the host ships for first-party plugins packaged before manifests
 * could declare `adminMenu`. Keeps an already-installed 0.1.0 Analytics or Forms
 * working without a reinstall; newer packages declare their own and win.
 */
const FIRST_PARTY_ADMIN_MENU: Record<string, PluginAdminMenuItem[]> = {
  "justflows.analytics": [
    {
      id: "analytics",
      label: "Analytics",
      labelKey: "nav.analytics",
      path: "/admin/analytics",
      icon: "📊",
      domain: "extensions",
    },
  ],
  "justflows.forms": [
    {
      id: "forms",
      label: "Forms",
      labelKey: "nav.forms",
      path: "/admin/forms",
      icon: "✉",
      domain: "extensions",
    },
  ],
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Manifests are stored JSON that may predate — or lie about — the current
 * schema, so every field is re-validated here rather than trusted.
 */
function sanitizeItem(raw: unknown, pluginId: string): AdminMenuEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;

  const id = asString(item.id);
  const label = asString(item.label);
  const path = asString(item.path);
  if (!id || !label || !path) return null;
  if (!MENU_ID_RE.test(id) || !MENU_PATH_RE.test(path)) return null;
  if (path.includes("..")) return null;

  const domain = asString(item.domain);
  const icon = asString(item.icon);
  const setupPath = asString(item.setupPath);
  const contentType = asString(item.contentType);

  return {
    pluginId,
    id,
    label: label.slice(0, 60),
    labelKey: asString(item.labelKey)?.slice(0, 120),
    path,
    icon: icon && icon.length <= 8 ? icon : "🔌",
    domain: (domain && ADMIN_MENU_DOMAIN_SET.has(domain)
      ? domain
      : "extensions") as PluginAdminMenuItem["domain"],
    end: item.end === true ? true : undefined,
    setupPath:
      setupPath && MENU_PATH_RE.test(setupPath) && !setupPath.includes("..") ? setupPath : undefined,
    contentType: contentType && CONTENT_TYPE_SLUG_RE.test(contentType) ? contentType : undefined,
  };
}

function manifestMenu(manifest: Record<string, unknown>, pluginId: string): AdminMenuEntry[] {
  const declared = manifest.adminMenu;
  if (!Array.isArray(declared)) return [];

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!permissions.includes("admin:extend")) return [];

  return declared
    .slice(0, 20)
    .map((entry) => sanitizeItem(entry, pluginId))
    .filter((entry): entry is AdminMenuEntry => entry !== null);
}

/**
 * Admin nav entries contributed by the plugins currently installed on a site.
 * The sidebar is built from this, so a deleted plugin's pages disappear with it.
 */
export async function listPluginAdminMenu(siteId: string): Promise<AdminMenuEntry[]> {
  const db = await getDb();
  const rows = await db.query<{
    plugin_id: string;
    status: PluginRow["status"];
    manifest: string | Record<string, unknown> | null;
  }>("SELECT plugin_id, status, manifest FROM plugins WHERE site_id = ?", [siteId]);

  const entries: AdminMenuEntry[] = [];
  const seenPaths = new Set<string>();
  const setupByPlugin = new Map<string, string>();

  for (const row of rows) {
    if (!MENU_VISIBLE_STATUSES.has(row.status)) continue;

    let manifest: Record<string, unknown> = {};
    try {
      manifest =
        typeof row.manifest === "string"
          ? (JSON.parse(row.manifest) as Record<string, unknown>)
          : (row.manifest ?? {});
    } catch {
      manifest = {};
    }

    const setupPath = asString(manifest.setupPath);
    if (setupPath && MENU_PATH_RE.test(setupPath) && !setupPath.includes("..")) {
      setupByPlugin.set(row.plugin_id, setupPath);
    }

    // A manifest that mentions adminMenu speaks for itself, even to say "none".
    // Only a manifest predating the field falls back to what the host knows.
    const items =
      "adminMenu" in manifest
        ? manifestMenu(manifest, row.plugin_id)
        : (FIRST_PARTY_ADMIN_MENU[row.plugin_id] ?? [])
            .map((entry) => sanitizeItem(entry, row.plugin_id))
            .filter((entry): entry is AdminMenuEntry => entry !== null);

    for (const item of items) {
      if (seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      entries.push(item);
    }
  }

  const { ensurePluginRuntime, getRuntimeHooks } = await import("./plugin-runtime.js");
  await ensurePluginRuntime();
  const filtered = await getRuntimeHooks().applyFilter(
    "admin.menu",
    entries,
    { siteId },
    { siteId, source: "http" },
  );

  return stampSetupPaths(
    finalizeAdminMenu(Array.isArray(filtered) ? filtered : entries),
    setupByPlugin,
  );
}

/** Attach each plugin's `setupPath` so the host wizard only mounts on that URL. */
export function stampSetupPaths(
  items: AdminMenuEntry[],
  setupByPlugin: Map<string, string>,
): AdminMenuEntry[] {
  return items.map((item) => {
    const setupPath = item.setupPath ?? setupByPlugin.get(item.pluginId);
    return setupPath ? { ...item, setupPath } : item;
  });
}

/** Re-validate plugin-contributed admin pages and drop duplicates/invalid rows. */
export function finalizeAdminMenu(items: unknown[]): AdminMenuEntry[] {
  const seenPaths = new Set<string>();
  const entries: AdminMenuEntry[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const pluginId = asString((raw as Record<string, unknown>).pluginId);
    if (!pluginId) continue;
    const item = sanitizeItem(raw, pluginId);
    if (!item || seenPaths.has(item.path)) continue;
    seenPaths.add(item.path);
    entries.push(item);
  }
  return entries;
}
