export type NavItem = {
  /** i18n catalog key, or a unique id when the item ships its own label. */
  key: string;
  /** Literal label used when `key` has no catalog entry (plugin-supplied items). */
  label?: string;
  to: string;
  icon: string;
  end?: boolean;
  /** Kept at the end of its domain — plugin pages are inserted above it. */
  trailing?: boolean;
};

export type NavDomain = {
  key: string;
  /** Matches the `domain` a plugin names in its manifest. */
  slug: string;
  icon: string;
  items: NavItem[];
};

/** One admin page contributed by an installed plugin. */
export type PluginMenuItem = {
  pluginId: string;
  id: string;
  label: string;
  labelKey?: string;
  path: string;
  icon: string;
  domain: string;
  end?: boolean;
  /** When set, the host setup wizard mounts only on this path. */
  setupPath?: string;
  /** When set, the plugin host lists CMS entries of this type. */
  contentType?: string;
};

export const ADMIN_DASHBOARD: NavItem = {
  key: "nav.dashboard",
  to: "/admin",
  icon: "⊞",
  end: true,
};

/**
 * Pages the core always ships. Plugin pages (Analytics, Forms, …) are not
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
      { key: "nav.media", to: "/admin/media", icon: "🖼" },
      { key: "nav.comments", to: "/admin/comments", icon: "💬" },
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
      { key: "nav.menus", to: "/admin/menus", icon: "☰" },
    ],
  },
  {
    key: "nav.domains.extensions",
    slug: "extensions",
    icon: "🔌",
    items: [
      { key: "nav.plugins", to: "/admin/plugins", icon: "🔌" },
      { key: "nav.marketplace", to: "/admin/marketplace", icon: "🛒", trailing: true },
    ],
  },
  {
    key: "nav.domains.security",
    slug: "security",
    icon: "🔒",
    items: [
      { key: "nav.securityOverview", to: "/admin/security", icon: "🛡", end: true },
      { key: "nav.securityHeaders", to: "/admin/security/headers", icon: "📑" },
      { key: "nav.securityAdvanced", to: "/admin/security/advanced", icon: "🧩" },
      { key: "nav.securityAccount", to: "/admin/security/account", icon: "🔑" },
      { key: "nav.securityAudit", to: "/admin/security/audit", icon: "📜" },
    ],
  },
  {
    key: "nav.domains.system",
    slug: "system",
    icon: "⚙",
    items: [
      { key: "nav.users", to: "/admin/users", icon: "👤" },
      { key: "nav.settings", to: "/admin/settings", icon: "⚙" },
      { key: "nav.languages", to: "/admin/languages", icon: "🌐" },
      { key: "nav.tools", to: "/admin/tools", icon: "🔧" },
      { key: "nav.health", to: "/admin/health", icon: "🩺" },
      { key: "nav.updates", to: "/admin/updates", icon: "⬆" },
    ],
  },
];

function toNavItem(item: PluginMenuItem): NavItem {
  return {
    key: item.labelKey ?? `plugin.${item.pluginId}.${item.id}`,
    label: item.label,
    to: item.path,
    icon: item.icon,
    end: item.end,
  };
}

/**
 * Merge plugin-contributed pages into the core domains. Unknown domains fall
 * back to Extensions so a plugin can never register an unreachable page.
 */
export function buildNavDomains(pluginItems: PluginMenuItem[]): NavDomain[] {
  if (pluginItems.length === 0) return ADMIN_NAV_DOMAINS;

  const slugs = new Set(ADMIN_NAV_DOMAINS.map((domain) => domain.slug));

  return ADMIN_NAV_DOMAINS.map((domain) => {
    const owned = pluginItems.filter((item) =>
      (slugs.has(item.domain) ? item.domain : "extensions") === domain.slug,
    );
    if (owned.length === 0) return domain;

    const core = domain.items.filter((item) => !item.trailing);
    const trailing = domain.items.filter((item) => item.trailing);
    return { ...domain, items: [...core, ...owned.map(toNavItem), ...trailing] };
  });
}

function matchesNavItem(pathname: string, item: NavItem): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function findDomainForPath(
  pathname: string,
  domains: NavDomain[] = ADMIN_NAV_DOMAINS,
): NavDomain | null {
  for (const domain of domains) {
    if (domain.items.some((item) => matchesNavItem(pathname, item))) {
      return domain;
    }
  }
  return null;
}

export function isDomainActive(domain: NavDomain, pathname: string): boolean {
  return domain.items.some((item) => matchesNavItem(pathname, item));
}

/** Prefer the catalog translation; fall back to the label the plugin shipped. */
export function navLabel(t: (key: string) => string, item: NavItem): string {
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
  "/admin/themes": ["administrator", "editor"],
  "/admin/plugins": ["administrator", "editor"],
  "/admin/marketplace": ["administrator"],
  "/admin/security": ["administrator"],
  "/admin/security/headers": ["administrator"],
  "/admin/security/advanced": ["administrator"],
  // Everyone's own 2FA — unlike the rest of Security, this is requireSession
  // only server-side, not admin-only. Listed explicitly so it doesn't inherit
  // /admin/security's rule by prefix.
  "/admin/security/account": ALL_ADMIN_ROLES,
  "/admin/security/audit": ["administrator"],
  "/admin/users": ["administrator", "editor"],
  "/admin/tools": ["administrator"],
  "/admin/health": ["administrator"],
  "/admin/updates": ["administrator"],
  "/admin/analytics": ["administrator", "editor"],
  "/admin/forms": ["administrator", "editor"],
};

/** Every rule path, longest first, so a nested route matches its owning page. */
const NAV_ACCESS_PATHS = Object.keys(NAV_ACCESS).sort((a, b) => b.length - a.length);

/** The nav rule that governs a URL — a builder page under /admin/content/:id
 *  is governed by the /admin/content rule, for instance. Null when no rule
 *  applies (nothing to hide, nothing to guard). */
export function navRuleFor(pathname: string): string | null {
  for (const path of NAV_ACCESS_PATHS) {
    if (pathname === path || pathname.startsWith(`${path}/`)) return path;
  }
  return null;
}

/** Can this role open the page a URL belongs to, per the table above? */
export function canAccessPath(role: string | null | undefined, pathname: string): boolean {
  if (!role) return false;
  const rule = navRuleFor(pathname);
  if (!rule) return true;
  return (NAV_ACCESS[rule] ?? ALL_ADMIN_ROLES).includes(role);
}

/** Drop nav items — and domains left with none — the role can't open. */
export function filterDomainsByRole(domains: NavDomain[], role: string | null | undefined): NavDomain[] {
  return domains
    .map((domain) => ({ ...domain, items: domain.items.filter((item) => canAccessPath(role, item.to)) }))
    .filter((domain) => domain.items.length > 0);
}
