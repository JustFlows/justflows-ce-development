// SPDX-License-Identifier: MIT

/**
 * Publisher namespaces (justflows-ce#272).
 *
 * Every extension id is `<namespace>.<name>`, for example `justflows.forms` or
 * `acme.forms`. The namespace is the publisher's. The Marketplace assigns it
 * to one publisher account and refuses a release whose id is outside the
 * submitting publisher's namespace, so a signed `acme.*` package came from
 * the publisher that owns `acme`.
 *
 * `justflows` is the official namespace. The other reserved namespaces are
 * refused for everyone, so they cannot be used to look official or to shadow
 * host routes.
 *
 * The namespace alone proves nothing about a package installed outside the
 * Marketplace: anyone can build a package with any id. Only a marketplace
 * signature ties an id to its publisher.
 */

/** The namespace of official Justflows extensions. */
export const OFFICIAL_PUBLISHER_NAMESPACE = "justflows";

/**
 * Lowercase letters, digits, and single hyphens, starting with a letter,
 * 2 to 32 characters.
 */
export const PUBLISHER_NAMESPACE_RE = /^(?=.{2,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Namespaces nobody may publish under: they would read as official, or collide
 * with host paths and well-known names. `justflows` itself is listed and is
 * allowed only for the official publisher.
 */
export const RESERVED_PUBLISHER_NAMESPACES: ReadonlySet<string> = new Set([
  "justflows",
  "justflow",
  "jf",
  "jflows",
  "admin",
  "api",
  "app",
  "core",
  "ext",
  "extension",
  "extensions",
  "host",
  "internal",
  "marketplace",
  "official",
  "plugin",
  "plugins",
  "registry",
  "root",
  "sdk",
  "security",
  "system",
  "theme",
  "themes",
  "verified",
  "www",
]);

/** The namespace part of an extension id, or null when the id has none. */
export function extensionNamespace(id: string): string | null {
  const dot = id.indexOf(".");
  if (dot <= 0) return null;
  return id.slice(0, dot);
}

/** True when the id is in the official `justflows` namespace. */
export function isOfficialExtensionId(id: string): boolean {
  return extensionNamespace(id) === OFFICIAL_PUBLISHER_NAMESPACE;
}

/** True when a publisher may be given this namespace. */
export function isAssignablePublisherNamespace(namespace: string): boolean {
  return PUBLISHER_NAMESPACE_RE.test(namespace) && !RESERVED_PUBLISHER_NAMESPACES.has(namespace);
}

/**
 * Why an id that already matches `PLUGIN_ID_RE` is still not allowed, or null
 * when it is. Ids in a reserved namespace other than `justflows` are refused.
 */
export function extensionIdNamespaceIssue(id: string): string | null {
  const namespace = extensionNamespace(id);
  if (!namespace) return "Extension id must be <namespace>.<name>, for example acme.forms";
  if (namespace === OFFICIAL_PUBLISHER_NAMESPACE) return null;
  if (!PUBLISHER_NAMESPACE_RE.test(namespace)) {
    return `Namespace "${namespace}" must be 2 to 32 lowercase letters, digits, or single hyphens, starting with a letter`;
  }
  if (RESERVED_PUBLISHER_NAMESPACES.has(namespace)) {
    return `Namespace "${namespace}" is reserved`;
  }
  return null;
}

/**
 * Plugin API namespaces (`/api/<apiNamespace>`) are shared by every plugin on
 * a site and claimed first come, first served. Official plugins may use any
 * unreserved one. A third-party plugin must stay inside its publisher
 * namespace: `acme` or `acme-<anything>`, so it cannot claim `/api/shop`.
 */
export function isApiNamespaceAllowedForExtension(id: string, apiNamespace: string): boolean {
  const namespace = extensionNamespace(id);
  if (!namespace) return false;
  if (namespace === OFFICIAL_PUBLISHER_NAMESPACE) return true;
  return apiNamespace === namespace || apiNamespace.startsWith(`${namespace}-`);
}
