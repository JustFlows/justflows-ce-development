// SPDX-License-Identifier: MIT

import {
  ADMIN_MENU_DOMAINS,
  AdminSectionSchema,
  pluginAdminBasePath,
  RELATIVE_ADMIN_PATH_RE,
  resolvePluginAdminPath,
  type PluginAdminMenuItem,
} from "@justflows/sdk";
import fs from "node:fs";
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
  /** The plugin's own sidebar section, on items with `domain: "plugin"`. */
  section?: AdminMenuSection;
}

/** A plugin's own sidebar section as the admin receives it. */
export interface AdminMenuSection {
  label: string;
  labelKey?: string;
  labels?: Record<string, string>;
  /** An emoji, or an `/ext/<pluginId>/admin/<file>` image URL. */
  icon: string;
}

const ADMIN_MENU_DOMAIN_SET = new Set<string>(ADMIN_MENU_DOMAINS);

/**
 * A plugin owns its admin pages, but only while active: an installed-but-never-
 * activated plugin, a deactivated one, or one in error state serves nothing
 * behind the page.
 */
const MENU_VISIBLE_STATUSES = new Set<PluginRow["status"]>(["active"]);

const MENU_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALE_RE = /^[a-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** Catalogs bigger than this are skipped when resolving menu labels. */
const MAX_CATALOG_BYTES = 512 * 1024;
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Keep valid `locale → label` pairs (at most 20), trimmed to 60 characters. */
function sanitizeLabels(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const labels: Record<string, string> = {};
  for (const [code, value] of Object.entries(raw).slice(0, 20)) {
    const label = asString(value);
    if (LOCALE_RE.test(code) && label) labels[code] = label.slice(0, 60);
  }
  return Object.keys(labels).length ? labels : undefined;
}

/** Keep valid, distinct role ids (at most 10). */
function sanitizeRoles(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const roles = [...new Set(raw.filter((role): role is string => typeof role === "string" && ROLE_RE.test(role)))];
  return roles.length ? roles.slice(0, 10) : undefined;
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
  const labels = sanitizeLabels(item.labels);
  const roles = sanitizeRoles(item.roles);

  return {
    pluginId,
    id,
    label: label.slice(0, 60),
    labelKey: asString(item.labelKey)?.slice(0, 120),
    ...(labels ? { labels } : {}),
    path,
    icon: icon && icon.length <= 8 ? icon : "🔌",
    domain: (domain && ADMIN_MENU_DOMAIN_SET.has(domain)
      ? domain
      : "extensions") as PluginAdminMenuItem["domain"],
    end: item.end === true ? true : undefined,
    listed: item.listed === false ? false : undefined,
    ...(roles ? { roles } : {}),
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
  const { syncBundledPlugins } = await import("../plugins/plugins-db.js");
  const { syncSubsitePluginCopies } = await import("../plugins/plugin-multisite.js");
  await syncBundledPlugins(siteId).catch(() => false);
  await syncSubsitePluginCopies(siteId).catch(() => false);

  const db = await getDb();
  const rows = await db.query<{
    plugin_id: string;
    status: PluginRow["status"];
    manifest: string | Record<string, unknown> | null;
  }>("SELECT plugin_id, status, manifest FROM plugins WHERE site_id = ?", [siteId]);

  const entries: AdminMenuEntry[] = [];
  const seenPaths = new Set<string>();
  const setupByPlugin = new Map<string, string>();
  /** Plugins active on this site — used to drop stale adminApp / filter leftovers. */
  const activePluginIds = new Set<string>();
  const sections = new Map<string, AdminMenuSection>();

  for (const row of rows) {
    if (!MENU_VISIBLE_STATUSES.has(row.status)) continue;
    activePluginIds.add(row.plugin_id);

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

    const section = manifestSection(manifest, row.plugin_id);
    if (section) sections.set(row.plugin_id, section);

    const items = "adminMenu" in manifest ? manifestMenu(manifest, row.plugin_id) : [];

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

  const { getPluginAdminCatalogFiles, getPluginAdminRoutes } = await import(
    "../plugins/plugin-admin-app.js"
  );
  // Re-check against this site's active set. Sub-site deactivate does not unload
  // the shared module, so the adminApp memo can briefly keep another site's
  // screens; never synthesize nav for a plugin this site has turned off.
  const adminAppRoutes = (await getPluginAdminRoutes(siteId).catch(() => [])).filter((route) =>
    activePluginIds.has(route.pluginId),
  );

  const menu = finalizeAdminMenu(Array.isArray(filtered) ? filtered : entries).filter((item) =>
    activePluginIds.has(item.pluginId),
  );

  const catalogFiles = await getPluginAdminCatalogFiles(siteId).catch(
    () => new Map<string, Record<string, string>>(),
  );

  return stampSections(
    stampCatalogLabels(
      stampAdminAppUrls(stampSetupPaths(menu, setupByPlugin), adminAppRoutes),
      catalogFiles,
    ),
    sections,
    catalogFiles,
  );
}

/**
 * The section a plugin declares in `adminSection`. Without one, a plugin that
 * puts pages in the `plugin` domain gets a section named after the plugin.
 */
function manifestSection(manifest: Record<string, unknown>, pluginId: string): AdminMenuSection | null {
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!permissions.includes("admin:extend")) return null;
  const parsed = AdminSectionSchema.safeParse(manifest.adminSection);
  if (parsed.success) {
    const { label, labelKey, labels, icon } = parsed.data;
    return {
      label,
      ...(labelKey ? { labelKey } : {}),
      ...(labels ? { labels } : {}),
      icon: !icon ? "🔌" : icon.length <= 8 ? icon : `/ext/${pluginId}/admin/${icon}`,
    };
  }
  const name = asString(manifest.name);
  return name ? { label: name.slice(0, 60), icon: "🔌" } : null;
}

/**
 * Attach the plugin's section to each of its `plugin` domain items, with the
 * section label translated from the plugin's own catalogs. Labels the plugin
 * declared itself win per locale.
 */
export function stampSections(
  items: AdminMenuEntry[],
  sections: Map<string, AdminMenuSection>,
  catalogFiles: Map<string, Record<string, string>>,
): AdminMenuEntry[] {
  const resolved = new Map<string, AdminMenuSection>();
  return items.map((item) => {
    if (item.domain !== "plugin") return item;
    let section = resolved.get(item.pluginId);
    if (!section) {
      section = sections.get(item.pluginId) ?? { label: item.pluginId, icon: "🔌" };
      const files = section.labelKey ? catalogFiles.get(item.pluginId) : undefined;
      if (section.labelKey && files) {
        const labels: Record<string, string> = {};
        for (const [code, file] of Object.entries(files)) {
          const label = asString(readCatalog(file)?.[section.labelKey]);
          if (label) labels[code] = label.slice(0, 60);
        }
        section = { ...section, labels: { ...labels, ...section.labels } };
      }
      resolved.set(item.pluginId, section);
    }
    return { ...item, section };
  });
}

/**
 * Read a catalog through one file descriptor, so the size check and the read
 * see the same file even if the path is swapped in between.
 */
function readCatalog(file: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Translate each item's `labelKey` from its plugin's own `adminApp.locales`
 * catalogs into `labels`, so the sidebar shows the plugin's translation without
 * a key in core's catalogs. Labels the plugin declared itself win per locale.
 */
export function stampCatalogLabels(
  items: AdminMenuEntry[],
  catalogFiles: Map<string, Record<string, string>>,
): AdminMenuEntry[] {
  if (catalogFiles.size === 0) return items;
  const catalogs = new Map<string, Record<string, unknown> | null>();
  return items.map((item) => {
    const files = item.labelKey ? catalogFiles.get(item.pluginId) : undefined;
    if (!item.labelKey || !files) return item;
    const labels: Record<string, string> = {};
    for (const [code, file] of Object.entries(files)) {
      if (!catalogs.has(file)) catalogs.set(file, readCatalog(file));
      const label = asString(catalogs.get(file)?.[item.labelKey]);
      if (label) labels[code] = label.slice(0, 60);
    }
    if (Object.keys(labels).length === 0) return item;
    return { ...item, labels: { ...labels, ...item.labels } };
  });
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
  // A route nested under one of the plugin's own pages (`products/bulk-edit`
  // under `products`, not just under the plugin root) is a sub-page: it joins
  // that page's domain and stays out of the sidebar.
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
    const root = pluginAdminBasePath(route.pluginId);
    const parent = out
      .filter(
        (item) =>
          item.pluginId === route.pluginId &&
          item.path !== root &&
          route.path.startsWith(`${item.path}/`),
      )
      .sort((a, b) => b.path.length - a.path.length)[0];
    out.push({
      pluginId: route.pluginId,
      id,
      label: (route.title || id).slice(0, 60),
      path: route.path,
      icon: parent?.icon ?? "🔌",
      domain: parent?.domain ?? ("extensions" as PluginAdminMenuItem["domain"]),
      ...(parent ? { listed: false } : {}),
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
