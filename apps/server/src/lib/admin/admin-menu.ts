// SPDX-License-Identifier: MIT

import {
  pluginAdminBasePath,
  RELATIVE_ADMIN_PATH_RE,
  resolvePluginAdminPath,
  type PluginAdminMenuItem,
} from "@justflows/sdk";
import { getDb } from "../database/db.js";
import type { PluginRow } from "../plugins/plugins-db.js";

/**
 * An admin nav entry as the SSR/hydrated admin consumes it: the owning plugin travels with the
 * item so the UI can attribute (and the host can de-duplicate) a page. `path` /
 * `setupPath` are always the resolved absolute `/admin/plugins/<id>/…` URL.
 */
export interface AdminMenuEntry extends Omit<PluginAdminMenuItem, "path"> {
  pluginId: string;
  path: string;
  /** Copied from the plugin manifest so nested pages do not mount the setup wizard. */
  setupPath?: string;
  /**
   * When the plugin ships its own admin app (`manifest.adminApp`) for this
   * path, the URL of the HTML the admin shell mounts in an `<iframe>`
   * (`/ext/<pluginId>/admin/<entry>`). Absent for host-rendered plugin pages.
   */
  adminAppUrl?: string;
  /** Locale code → catalog URL, from `adminApp.locales` in the plugin manifest. */
  adminCatalogs?: Record<string, string>;
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
const CONTENT_TYPE_SLUG_RE = /^[a-z][a-z0-9-]{0,59}$/;

/**
 * A plugin admin path may arrive relative (`""`, `"orders"`, `"orders/refunds"`)
 * from a manifest or the `admin.menu` filter, or already absolute
 * (`/admin/plugins/<id>/orders`) from a stored manifest the SDK transformed.
 * Return the absolute form, or null when it escapes the plugin's own
 * `/admin/plugins/<id>` namespace, repeats the id, or contains `..`.
 */
function resolveAdminPath(raw: string | undefined, pluginId: string): string | null {
  const base = pluginAdminBasePath(pluginId);
  const value = (raw ?? "").trim();
  if (value === "") return base;
  if (value.includes("..")) return null;
  if (value.startsWith("/")) {
    if (value !== base && !value.startsWith(`${base}/`)) return null;
    const rest = value.slice(base.length).replace(/^\//, "");
    return RELATIVE_ADMIN_PATH_RE.test(rest) ? value : null;
  }
  return RELATIVE_ADMIN_PATH_RE.test(value) ? resolvePluginAdminPath(pluginId, value) : null;
}

/**
 * Admin pages the host ships for first-party plugins packaged before manifests
 * could declare `adminMenu`. Keeps an already-installed 0.1.0 Analytics working
 * without a reinstall; newer packages declare their own and win.
 */
const FIRST_PARTY_ADMIN_MENU: Record<string, PluginAdminMenuItem[]> = {
  "justflows.analytics": [
    {
      id: "analytics",
      label: "Analytics",
      labelKey: "nav.analytics",
      // Relative — the plugin's namespace root. `sanitizeItem` resolves it.
      path: "",
      icon: "📊",
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
  if (!id || !label || !MENU_ID_RE.test(id)) return null;

  // `path` is optional now — omitted / "" is the plugin's namespace root.
  const path = resolveAdminPath(
    typeof item.path === "string" ? item.path : "",
    pluginId,
  );
  if (!path) return null;

  const domain = asString(item.domain);
  const icon = asString(item.icon);
  const rawSetupPath = typeof item.setupPath === "string" ? item.setupPath : undefined;
  const setupPath = rawSetupPath === undefined ? undefined : resolveAdminPath(rawSetupPath, pluginId);
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
    listed: item.listed === false ? false : undefined,
    setupPath: setupPath ?? undefined,
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

    if (typeof manifest.setupPath === "string") {
      const setupPath = resolveAdminPath(manifest.setupPath, row.plugin_id);
      if (setupPath) setupByPlugin.set(row.plugin_id, setupPath);
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

  const { ensurePluginRuntime, getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  await ensurePluginRuntime();
  const filtered = await getRuntimeHooks().applyFilter(
    "admin.menu",
    entries,
    { siteId },
    { siteId, source: "http" },
  );

  const { getPluginAdminRoutes } = await import("../plugins/plugin-admin-app.js");
  const adminAppRoutes = await getPluginAdminRoutes().catch(() => []);

  return stampAdminAppUrls(
    stampSetupPaths(finalizeAdminMenu(Array.isArray(filtered) ? filtered : entries), setupByPlugin),
    adminAppRoutes,
  );
}

/**
 * Attach `adminAppUrl` to every menu item a plugin has an `adminApp` route for
 * (matched on `pluginId` + canonical `path`). A `title` on the route overrides
 * the menu label so the plugin controls how its own screen is named.
 */
export function stampAdminAppUrls(
  items: AdminMenuEntry[],
  routes: Array<{ pluginId: string; path: string; entryUrl: string; title?: string; catalogs?: Record<string, string> }>,
): AdminMenuEntry[] {
  if (routes.length === 0) return items;
  const byKey = new Map(routes.map((r) => [`${r.pluginId} ${r.path}`, r]));
  const stampedKeys = new Set<string>();
  const out: AdminMenuEntry[] = items.map((item) => {
    const route = byKey.get(`${item.pluginId} ${item.path}`);
    if (!route) return item;
    stampedKeys.add(`${item.pluginId} ${item.path}`);
    return {
      ...item,
      adminAppUrl: route.entryUrl,
      ...(route.catalogs ? { adminCatalogs: route.catalogs } : {}),
      label: route.title ? route.title.slice(0, 60) : item.label,
    };
  });

  // An `adminApp` route the plugin did not also list in `adminMenu` would have
  // no sidebar entry and would render `<Navigate to="/admin">` — the screen
  // would be unreachable. Synthesize a nav entry for it (the plugin owns the
  // whole screen, so a default icon and the "extensions" domain are enough).
  const takenPaths = new Set(out.map((i) => i.path));
  for (const route of routes) {
    if (stampedKeys.has(`${route.pluginId} ${route.path}`) || takenPaths.has(route.path)) {
      continue;
    }
    const id = route.path
      .replace(/^\/admin\//, "")
      .replace(/[./]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!MENU_ID_RE.test(id)) continue;
    out.push({
      pluginId: route.pluginId,
      id,
      label: (route.title || id).slice(0, 60),
      path: route.path,
      icon: "🔌",
      domain: "extensions" as PluginAdminMenuItem["domain"],
      adminAppUrl: route.entryUrl,
      ...(route.catalogs ? { adminCatalogs: route.catalogs } : {}),
    });
    takenPaths.add(route.path);
  }
  return out;
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
