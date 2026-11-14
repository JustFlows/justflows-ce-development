/**
 * User capability definitions — stable public API.
 * Code should always check capabilities, never role names directly.
 */

export const USER_CAPABILITIES = [
  "content:read",
  "content:create",
  "content:update",
  "content:delete",
  "content:publish",
  "content:revisions:read",
  "content:revisions:restore",
  "content:revisions:discard",
  /** Lock and unlock blocks; without it, locked blocks cannot be moved, removed, or edited (justflows-ce#298). */
  "content:locks:manage",
  "media:read",
  "media:upload",
  "media:delete",
  "comments:moderate",
  "users:read",
  "users:manage",
  "plugins:read",
  "plugins:install",
  "plugins:activate",
  "plugins:delete",
  "themes:read",
  "themes:install",
  "themes:activate",
  "themes:delete",
  "settings:read",
  "settings:manage",
  "mail:read",
  "mail:manage",
  "email-templates:read",
  "email-templates:manage",
  "updates:manage",
  "site:admin",
  "ai:use",
] as const;

export type CoreUserCapability = (typeof USER_CAPABILITIES)[number];
/** Core capability or a validated capability registered by an active plugin. */
export type UserCapability = CoreUserCapability | (string & {});

export interface UserCapabilityDefinition {
  readonly id: UserCapability;
  readonly label?: string;
  readonly group?: string;
  readonly description?: string;
  /** Built-in roles receiving this capability by default. Defaults to administrator. */
  readonly defaultRoles?: readonly string[];
}

export const ACCESS_SCOPE_DOMAINS = ["site", "contentType", "locale", "owner"] as const;
export type AccessScopeDomain = (typeof ACCESS_SCOPE_DOMAINS)[number];

/** A resource constraint attached to a capability grant. Empty scopes are unrestricted. */
export interface AccessScope {
  readonly siteIds?: readonly string[];
  readonly contentTypes?: readonly string[];
  readonly locales?: readonly string[];
  /** `self` limits access to resources owned by the actor. */
  readonly ownership?: "any" | "self";
}

/** Public, serialisable access policy used by admin, HTTP APIs, and plugins. */
export interface AccessPolicy {
  readonly grants?: readonly UserCapability[];
  readonly denies?: readonly UserCapability[];
  readonly scopes?: Partial<Record<UserCapability, AccessScope>>;
}

export interface RoleDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly builtIn: boolean;
  readonly capabilities: readonly UserCapability[];
}

export interface AccessResource {
  readonly siteId?: string;
  readonly contentType?: string;
  readonly locale?: string;
  readonly ownerId?: string | null;
}

export const ROLE_CAPABILITIES: Record<string, UserCapability[]> = {
  administrator: [...USER_CAPABILITIES],
  editor: [
    "content:read",
    "content:create",
    "content:update",
    "content:delete",
    "content:publish",
    "content:revisions:read",
    "content:revisions:restore",
    "content:revisions:discard",
    "content:locks:manage",
    "media:read",
    "media:upload",
    "media:delete",
    "comments:moderate",
    "users:read",
    "ai:use",
  ],
  author: [
    "content:read",
    "content:create",
    "content:update",
    "content:revisions:read",
    "content:revisions:restore",
    "content:revisions:discard",
    "media:read",
    "media:upload",
  ],
  contributor: ["content:read", "content:create", "content:revisions:read"],
  subscriber: ["content:read"],
};

export function roleHasCapability(role: string, capability: UserCapability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

/** Resolve role capabilities plus per-user grants, with explicit denies winning. */
export function effectiveCapabilities(
  roleCapabilities: readonly UserCapability[],
  policy: AccessPolicy = {},
): UserCapability[] {
  const denied = new Set(policy.denies ?? []);
  return [...new Set([...roleCapabilities, ...(policy.grants ?? [])])].filter(
    (capability) => !denied.has(capability),
  );
}

export function scopeAllows(
  scope: AccessScope | undefined,
  resource: AccessResource,
  actorId: string,
): boolean {
  if (!scope) return true;
  if (scope.siteIds?.length && (!resource.siteId || !scope.siteIds.includes(resource.siteId))) return false;
  if (
    scope.contentTypes?.length &&
    (!resource.contentType || !scope.contentTypes.includes(resource.contentType))
  ) return false;
  if (scope.locales?.length && (!resource.locale || !scope.locales.includes(resource.locale))) return false;
  if (scope.ownership === "self" && resource.ownerId !== actorId) return false;
  return true;
}
