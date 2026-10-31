export type NavItem = {
  /** i18n catalog key, or a unique id when the item ships its own label. */
  key: string;
  /** Literal label used when `key` has no catalog entry (plugin-supplied items). */
  label?: string;
  /** Locale code → label a plugin shipped; wins over `key` and `label`. */
  labels?: Record<string, string>;
  to: string;
  icon: string;
  end?: boolean;
  /** Kept at the end of its domain — plugin pages are inserted above it. */
  trailing?: boolean;
};

import { internalAdminPath } from "../admin-path";

export type NavDomain = {
  key: string;
  /** Literal label used when `key` has no catalog entry (a plugin's own section). */
  label?: string;
  /** Locale code → label a plugin shipped for its own section. */
  labels?: Record<string, string>;
  /** Matches the `domain` a plugin names in its manifest. */
  slug: string;
  /** Emoji, or a same-origin image path such as a plugin logo. */
  icon: string;
  items: NavItem[];
};

/** One admin page contributed by an installed plugin. */
export type PluginMenuItem = {
  pluginId: string;
  id: string;
  label: string;
  labelKey?: string;
  /** Locale code → label, from the manifest or the plugin's own catalogs. */
  labels?: Record<string, string>;
  /** Roles that may open this page. Omitted: the `/admin/plugins` rule. */
  roles?: string[];
  path: string;
  icon: string;
  domain: string;
  end?: boolean;
  /** When set, the host setup wizard mounts only on this path. */
  setupPath?: string;
  /** `false` keeps the page routable without a nav entry. */
  listed?: boolean;
  /** When set, the plugin host lists CMS entries of this type. */
  contentType?: string;
  /**
   * When the plugin ships its own admin app for this path, the URL the admin
   * shell mounts in an `<iframe>` (`/ext/<pluginId>/admin/<entry>`). The plugin
   * owns the whole screen; the host only frames it.
   */
  adminAppUrl?: string;
  /** Locale code → catalog URL declared in the plugin manifest. */
  adminCatalogs?: Record<string, string>;
  /** The plugin's own sidebar section, on items with `domain: "plugin"`. */
  section?: { label: string; labels?: Record<string, string>; icon: string };
};

/**
 * Admin app a plugin embeds in the content editor for a CMS type.
 * The host matches `contentType` plus `adminAppUrl` and does not know the plugin.
 */
export function contentEditorFor(
  items: PluginMenuItem[],
  contentType: string | undefined,
): PluginMenuItem | undefined {
  if (!contentType) return undefined;
  return items.find((item) => item.contentType === contentType && Boolean(item.adminAppUrl));
}

const PLUGIN_SECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PluginEditorSection = { id: string; label: string };

/** Keep plugin-published editor menu entries the host can render safely. */
export function parsePluginSections(value: unknown): PluginEditorSection[] {
  if (!Array.isArray(value)) return [];
  const sections: PluginEditorSection[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as { id?: unknown }).id;
    const label = (raw as { label?: unknown }).label;
    if (typeof id !== "string" || typeof label !== "string") continue;
    const cleanId = id.trim();
    const cleanLabel = label.trim();
    if (!PLUGIN_SECTION_ID.test(cleanId) || cleanId.length > 40 || !cleanLabel || cleanLabel.length > 60) {
      continue;
    }
    if (seen.has(cleanId)) continue;
    seen.add(cleanId);
    sections.push({ id: cleanId, label: cleanLabel });
    if (sections.length >= 12) break;
  }
  return sections;
}

export type EditorNavEntry = { id: string; label: string };

/** Admin text a plugin declared as one string or a `{ locale: text }` map. */
export type LocalizedLabel = string | Record<string, string>;

/** Pick the text for the admin language: exact, base language, `en`, then any entry. */
export function localizedLabel(value: LocalizedLabel | undefined, locale: string): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value[locale] ?? value[locale.split("-")[0]!] ?? value["en"] ?? Object.values(value)[0] ?? "";
}

/**
 * Content-editor menu. Plugin sections replace the single plugin screen label;
 * `panels` are the editor panels active plugins declare, as `panel:<plugin>:<id>`.
 */
export function contentEditorNav(input: {
  contentLabel: string;
  discussionLabel: string;
  revisionsLabel: string;
  advancedLabel: string;
  pluginLabel?: string;
  pluginSections?: PluginEditorSection[];
  panels?: EditorNavEntry[];
}): EditorNavEntry[] {
  const plugin =
    input.pluginSections && input.pluginSections.length > 0
      ? input.pluginSections.map((section) => ({ id: `plugin:${section.id}`, label: section.label }))
      : input.pluginLabel
        ? [{ id: "plugin", label: input.pluginLabel }]
        : [];
  return [
    { id: "content", label: input.contentLabel },
    ...plugin,
    ...(input.panels ?? []),
    { id: "discussion", label: input.discussionLabel },
    { id: "revisions", label: input.revisionsLabel },
    { id: "advanced", label: input.advancedLabel },
  ];
}

/** List page for a CMS type a plugin owns (the menu item without its own admin app). */
export function contentListPath(
  items: PluginMenuItem[],
  contentType: string | undefined,
): string | undefined {
  if (!contentType) return undefined;
  return items.find((item) => item.contentType === contentType && !item.adminAppUrl)?.path;
}

export const ADMIN_DASHBOARD: NavItem = {
  key: "nav.dashboard",
  to: "/admin",
  icon: "⊞",
  end: true,
};

/**
 * Pages the core always ships. Plugin pages (Forms, Helpdesk, …) are not
 * listed here — they come from `/api/plugins/admin-menu` and only exist while
 * the plugin that owns them is installed.
 */
export const ADMIN_NAV_DOMAINS: NavDomain[] = [
  {
    key: "nav.domains.content",
    slug: "content",
    icon: "📝",
    items: [
      { key: "nav.content", to: "/admin/content", icon: "📝" },
      { key: "nav.contentTypes", to: "/admin/content-types", icon: "🗂" },
      { key: "nav.taxonomies", to: "/admin/taxonomies", icon: "🏷" },
      { key: "nav.media", to: "/admin/media", icon: "🖼" },
      { key: "nav.comments", to: "/admin/comments", icon: "💬" },
      { key: "nav.trash",  to: "/admin/trash", icon: "♻" },
    ],
  },
  {
    key: "nav.domains.commerce",
    slug: "commerce",
    icon: "🛍",
    items: [],
  },
  {
    key: "nav.domains.appearance",
    slug: "appearance",
    icon: "🎨",
    items: [
      { key: "nav.themes", to: "/admin/themes", icon: "🎨" },
      { key: "nav.design", to: "/admin/design", icon: "🎛" },
      { key: "nav.widgets", to: "/admin/widgets", icon: "▥" },
      // Menus moved into Themes → Customize → Menus, alongside Header/Footer/
      // Templates — it's a theme-builder concern, not a separate top-level
      // page. The /admin/menus route still works for old links/bookmarks.
    ],
  },
  {
    // People-management is its own concern, not a System setting — WordPress
    // gives it a top-level menu too. A single item, so the sidebar links
    // straight to it and no sub-bar renders.
    key: "nav.domains.users",
    slug: "users",
    icon: "👤",
    items: [{ key: "nav.users", to: "/admin/users", icon: "👤" }],
  },
  {
    /**
     * Helpdesk's own sidebar entry. It stays empty until the plugin is active,
     * and one listed page means the sidebar links straight there with no top bar.
     */
    key: "nav.domains.helpdesk",
    slug: "helpdesk",
    icon: "💬",
    items: [],
  },
  {
    /**
     * Shared files' own sidebar entry. It stays empty until the plugin is
     * active, and one listed page means the sidebar links straight there.
     */
    key: "nav.domains.files",
    slug: "files",
    icon: "📁",
    items: [],
  },
  {
    key: "nav.domains.extensions",
    slug: "extensions",
    icon: "🔌",
    items: [
      // `end` so the Plugins tab is active only on the list itself — every
      // plugin page now lives under `/admin/plugins/<pluginId>` and lights up
      // its own entry instead.
      { key: "nav.plugins", to: "/admin/plugins", icon: "🔌", end: true },
      { key: "nav.marketplace", to: "/admin/marketplace", icon: "🛒", trailing: true },
    ],
  },
  {
    // Maintenance / operations pages pulled out of System — these are things
    // you *do* to the site, not settings you configure.
    key: "nav.domains.tools",
    slug: "tools",
    icon: "🔧",
    items: [
      { key: "nav.tools", to: "/admin/tools", icon: "🔧" },
      { key: "nav.diagnostics", to: "/admin/health", icon: "🩺" },
      { key: "nav.updates", to: "/admin/updates", icon: "⬆" },
    ],
  },
  {
    key: "nav.domains.security",
    slug: "security",
    icon: "🔒",
    items: [
      { key: "nav.securityCenter", to: "/admin/security", icon: "🛡", end: true },
      { key: "nav.securityWebServer", to: "/admin/security/web-server", icon: "🌐" },
      { key: "nav.securityIntegrity", to: "/admin/security/integrity", icon: "🔍" },
      { key: "nav.securityOverview", to: "/admin/security/header-grade", icon: "📊" },
      { key: "nav.securityHeaders", to: "/admin/security/headers", icon: "📑" },
      { key: "nav.securityAdvanced", to: "/admin/security/advanced", icon: "🧩" },
      { key: "nav.securityAdminPath", to: "/admin/security/admin-path", icon: "🛣" },
      { key: "nav.securityAccount", to: "/admin/security/account", icon: "🔑" },
      { key: "nav.securityAudit", to: "/admin/security/audit", icon: "📜" },
    ],
  },
  {
    // Formerly "System" — now only the pages that are genuinely site-wide
    // configuration. Users and Tools/Diagnostics/Updates have moved out to
    // their own sidebar groups. Slug stays `system` so plugin pages that
    // target `domain: "system"` keep landing here.
    key: "nav.domains.system",
    slug: "system",
    icon: "⚙",
    items: [
      { key: "nav.settings", to: "/admin/settings", icon: "⚙" },
      { key: "nav.permalinks", to: "/admin/settings/permalinks", icon: "↗" },
      { key: "nav.pwa", to: "/admin/settings/pwa", icon: "📱" },
      { key: "nav.placeholders", to: "/admin/settings/placeholders", icon: "🖼" },
      { key: "nav.redirects", to: "/admin/redirects", icon: "↪" },
      { key: "nav.emails", to: "/admin/emails", icon: "✉" },
      { key: "nav.languages", to: "/admin/languages", icon: "🌐" },
      { key: "nav.webhooks", to: "/admin/webhooks", icon: "↗" },
      { key: "nav.apiKeys", to: "/admin/settings/api", icon: "🔑" },
      { key: "nav.ai", to: "/admin/settings/ai", icon: "✦" },
      { key: "nav.cdn", to: "/admin/settings/cdn", icon: "☁" },
      { key: "nav.storage", to: "/admin/settings/storage", icon: "🗄" },
      { key: "nav.siteDomains", to: "/admin/settings/domains", icon: "🔗" },
    ],
  },
  {
    key: "nav.domains.platform",
    slug: "platform",
    icon: "🏢",
    items: [
      { key: "nav.workspaces", to: "/admin/platform/workspaces", icon: "🏢" },
      { key: "nav.sites", to: "/admin/platform/sites", icon: "🌐" },
      { key: "nav.defaults", to: "/admin/platform/defaults", icon: "⚖" },
      { key: "nav.customDomains", to: "/admin/platform/domains", icon: "🔗" },
    ],
  },
];

function toNavItem(item: PluginMenuItem): NavItem {
  return {
    key: item.labelKey ?? `plugin.${item.pluginId}.${item.id}`,
    label: item.label,
    labels: item.labels,
    // Canonical `/admin/…` (the SDK manifest schema requires it), matching the
    // core nav items. `installAdminPathNavigation()` maps it to the configured
    // admin URL on navigation, and the path-comparison helpers below normalise
    // the live pathname back with `internalAdminPath()`.
    to: item.path,
    icon: item.icon,
    end: item.end,
  };
}

/** Sidebar slug of a plugin's own section. */
export function pluginSectionSlug(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * Merge plugin-contributed pages into the core domains. Unknown domains fall
 * back to Extensions so a plugin can never register an unreachable page.
 * Pages in the `plugin` domain get a section per plugin, above Extensions.
 */
export function buildNavDomains(pluginItems: PluginMenuItem[]): NavDomain[] {
  if (pluginItems.length === 0) return ADMIN_NAV_DOMAINS;

  const slugs = new Set(ADMIN_NAV_DOMAINS.map((domain) => domain.slug));
  const listed = pluginItems.filter((item) => item.listed !== false);
  const own = listed.filter((item) => item.domain === "plugin" && item.section);

  const merged = ADMIN_NAV_DOMAINS.map((domain) => {
    const owned = listed.filter(
      (item) =>
        !own.includes(item) &&
        (slugs.has(item.domain) ? item.domain : "extensions") === domain.slug,
    );
    if (owned.length === 0) return domain;

    const core = domain.items.filter((item) => !item.trailing);
    const trailing = domain.items.filter((item) => item.trailing);
    return { ...domain, items: [...core, ...owned.map(toNavItem), ...trailing] };
  });

  const sections = new Map<string, NavDomain>();
  for (const item of own) {
    const section = item.section!;
    const existing = sections.get(item.pluginId);
    if (existing) {
      existing.items.push(toNavItem(item));
      continue;
    }
    sections.set(item.pluginId, {
      key: `plugin.${item.pluginId}.section`,
      label: section.label,
      labels: section.labels,
      slug: pluginSectionSlug(item.pluginId),
      icon: section.icon,
      items: [toNavItem(item)],
    });
  }
  if (sections.size === 0) return merged;
  const at = merged.findIndex((domain) => domain.slug === "extensions");
  return [...merged.slice(0, at), ...sections.values(), ...merged.slice(at)];
}

function matchesNavItem(pathname: string, item: NavItem): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function findDomainForPath(
  pathname: string,
  domains: NavDomain[] = ADMIN_NAV_DOMAINS,
): NavDomain | null {
  pathname = internalAdminPath(pathname);
  for (const domain of domains) {
    if (domain.items.some((item) => matchesNavItem(pathname, item))) {
      return domain;
    }
  }
  return null;
}

/** The page a URL belongs to: the dashboard, else the longest matching nav item. */
export function findNavItemForPath(
  pathname: string,
  domains: NavDomain[] = ADMIN_NAV_DOMAINS,
): NavItem | null {
  pathname = internalAdminPath(pathname);
  if (matchesNavItem(pathname, ADMIN_DASHBOARD)) return ADMIN_DASHBOARD;
  let best: NavItem | null = null;
  for (const domain of domains) {
    for (const item of domain.items) {
      if (matchesNavItem(pathname, item) && (!best || item.to.length > best.to.length)) best = item;
    }
  }
  return best;
}

export function isDomainActive(domain: NavDomain, pathname: string): boolean {
  pathname = internalAdminPath(pathname);
  return domain.items.some((item) => matchesNavItem(pathname, item));
}

/**
 * Prefer the plugin's own label for `locale` (exact, then the base language),
 * then the core catalog translation, then the English label the plugin shipped.
 */
export function navLabel(
  t: (key: string) => string,
  item: Pick<NavItem, "key" | "label" | "labels">,
  locale?: string,
): string {
  if (locale && item.labels) {
    const own = item.labels[locale] ?? item.labels[locale.split("-")[0]!];
    if (own) return own;
  }
  const translated = t(item.key);
  if (translated !== item.key) return translated;
  return item.label ?? item.key;
}

const ALL_ADMIN_ROLES = ["administrator", "editor", "author", "contributor"];

/**
 * Which roles can open each admin page without hitting a 403 on its very
 * first request — mirrors the `requireRole` on that page's primary GET route
 * (see the matching route file for the source of truth). Missing here means
 * "no core rule" — the item stays visible; that's true for pages the server
 * only gates behind `requireSession` (Settings, Languages, Design, Menus),
 * and for plugin pages, which police themselves.
 *
 * This is a UX convenience only. Every path here is still enforced
 * server-side regardless of what the client shows or hides.
 */
const NAV_ACCESS: Record<string, string[]> = {
  "/admin/media": ["administrator", "editor", "author"],
  "/admin/comments": ["administrator", "editor"],
  "/admin/trash": ["administrator", "editor"],
  "/admin/themes": ["administrator", "editor"],
  "/admin/widgets": ["administrator", "editor"],
  "/admin/plugins": ["administrator", "editor"],
  "/admin/marketplace": ["administrator"],
  "/admin/security": ["administrator"],
  "/admin/security/headers": ["administrator"],
  "/admin/security/advanced": ["administrator"],
  "/admin/security/admin-path": ["administrator"],
  // Everyone's own 2FA — unlike the rest of Security, this is requireSession
  // only server-side, not admin-only. Listed explicitly so it doesn't inherit
  // /admin/security's rule by prefix.
  "/admin/security/account": ALL_ADMIN_ROLES,
  "/admin/security/audit": ["administrator"],
  "/admin/users": ["administrator", "editor"],
  "/admin/tools": ["administrator"],
  "/admin/health": ["administrator"],
  "/admin/updates": ["administrator"],
  "/admin/webhooks": ["administrator"],
  "/admin/settings/api": ["administrator"],
  "/admin/settings/ai": ["administrator"],
  "/admin/settings/cdn": ["administrator"],
  "/admin/settings/storage": ["administrator"],
  "/admin/settings/domains": ["administrator"],
  "/admin/platform": ["administrator"],
  "/admin/settings/permalinks": ["administrator"],
  "/admin/settings/pwa": ["administrator"],
  "/admin/settings/placeholders": ["administrator"],
  "/admin/redirects": ["administrator"],
};

/** Every rule path, longest first, so a nested route matches its owning page. */
const NAV_ACCESS_PATHS = Object.keys(NAV_ACCESS).sort((a, b) => b.length - a.length);

/** The nav rule that governs a URL — a builder page under /admin/content/:id
 *  is governed by the /admin/content rule, for instance. Null when no rule
 *  applies (nothing to hide, nothing to guard). */
export function navRuleFor(pathname: string): string | null {
  pathname = internalAdminPath(pathname);
  for (const path of NAV_ACCESS_PATHS) {
    if (pathname === path || pathname.startsWith(`${path}/`)) return path;
  }
  return null;
}

/** Who is looking. Omitted fields keep the older role-only check. */
export interface NavAudience {
  /** False on a site created under this installation. Updates and health stay on the first site. */
  installationRoot?: boolean;
  /** False for a site administrator who cannot manage workspaces. */
  platformOperator?: boolean;
  /** Admin paths this website is not allowed to open. */
  disabledPaths?: readonly string[];
  /** Plugin page path → roles that may open it, from each page's `roles`. */
  pluginPageRoles?: Readonly<Record<string, readonly string[]>>;
}

/** Roles each plugin page declares, for `NavAudience.pluginPageRoles`. */
export function pluginPageRoles(items: readonly PluginMenuItem[]): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const item of items) if (item.roles?.length) out[item.path] = item.roles;
  return out;
}

/** The roles declared by the plugin page a path belongs to (longest match), if any. */
function pluginRolesFor(pathname: string, pages: Readonly<Record<string, readonly string[]>>): readonly string[] | null {
  let best: string | null = null;
  for (const path of Object.keys(pages)) {
    if ((pathname === path || pathname.startsWith(`${path}/`)) && (!best || path.length > best.length)) best = path;
  }
  return best ? pages[best] ?? null : null;
}

const INSTALLATION_ROOT_PREFIXES = ["/admin/health", "/admin/updates", "/admin/marketplace", "/admin/security/web-server", "/admin/security/integrity"];
const OPERATOR_PREFIXES = ["/admin/platform"];

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Can this role open the page a URL belongs to, per the table above? */
export function canAccessPath(
  role: string | null | undefined,
  pathname: string,
  audience?: NavAudience,
): boolean {
  if (!role) return false;
  pathname = internalAdminPath(pathname);
  if (audience?.installationRoot === false && matchesPrefix(pathname, INSTALLATION_ROOT_PREFIXES)) return false;
  if (audience?.platformOperator === false && matchesPrefix(pathname, OPERATOR_PREFIXES)) return false;
  if (audience?.disabledPaths && matchesPrefix(pathname, audience.disabledPaths)) return false;
  const declared = audience?.pluginPageRoles ? pluginRolesFor(pathname, audience.pluginPageRoles) : null;
  if (declared) return declared.includes(role);
  const rule = navRuleFor(pathname);
  if (!rule) return true;
  return (NAV_ACCESS[rule] ?? ALL_ADMIN_ROLES).includes(role);
}

/** Drop nav items — and domains left with none — the role can't open. */
export function filterDomainsByRole(
  domains: NavDomain[],
  role: string | null | undefined,
  audience?: NavAudience,
): NavDomain[] {
  return domains
    .map((domain) => ({
      ...domain,
      items: domain.items.filter((item) => canAccessPath(role, item.to, audience)),
    }))
    .filter((domain) => domain.items.length > 0);
}
