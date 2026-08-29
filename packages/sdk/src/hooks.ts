/**
 * @justflows/sdk — Typed hook contracts
 *
 * This is the stable public contract for plugin and theme developers.
 * Every name and payload shape here is public API under semantic versioning.
 *
 * INTERNAL NOTE: This file must never import from @justflows/core —
 * it is the public surface that extensions depend on.
 */

// ─── Shared context ────────────────────────────────────────────────────────

export type HookSource = "http" | "job" | "cli" | "system";

export interface HookActor {
  readonly userId?: string;
  readonly role?: string;
}

/**
 * Correlation data handed to every handler as the second argument.
 * Identity and provenance only — never secrets or runtime internals.
 */
export interface HookContext {
  readonly siteId?: string;
  readonly requestId?: string;
  readonly source?: HookSource;
  readonly actor?: HookActor;
}

/** A gate payload: the event plus the right to cancel the operation. */
export type Cancellable<T> = T & {
  /**
   * Abort the pending operation. The reason is surfaced to the end user,
   * so write it for a human.
   */
  cancel(reason: string): void;
};

export type Unsubscribe = () => void;

export interface HookRegisterOptions {
  /** Lower runs earlier. Default 100. */
  priority?: number;
  /** Auto-dispose after the first dispatch. */
  once?: boolean;
  /** Stable label shown in hook diagnostics. */
  id?: string;
}

// ─── Payload shapes ────────────────────────────────────────────────────────

export interface AppEvent {
  readonly version: string;
}

export interface ContentRef {
  readonly contentId: string;
  readonly siteId: string;
  /** Content type slug when the host knows it (`product`, `page`, …). */
  readonly type?: string;
  /** Shared id for every locale of this entry. Absent on older hosts. */
  readonly translationGroupId?: string;
}

/** `content.deleted` payload. Extends `ContentRef` with group-empty signalling. */
export interface ContentDeletedRef extends ContentRef {
  /**
   * True when no other locales remain in the translation group after this
   * delete. Absent on older hosts.
   */
  readonly lastInTranslationGroup?: boolean;
}

/** Canonical live-or-working fields a revision gate/filter may inspect. */
export interface ContentRevisionSnapshot {
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string | null;
  readonly blocks: unknown;
  readonly fields: Record<string, unknown>;
}

export interface ContentRevisionRef extends ContentRef {
  readonly revisionId: string;
  readonly source?: "manual" | "autosave" | "import" | "api";
  readonly actorId?: string;
}

export interface ContentUpdateGateEvent extends ContentRef {
  readonly revision?: ContentRevisionSnapshot;
  readonly revisionId?: string;
}

export interface ContentConflict {
  readonly contentId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}

/** Context for `content.render` — public HTML after blocks have been rendered. */
export interface ContentRenderContext {
  readonly siteId: string;
  readonly contentId: string;
  readonly type?: string;
  readonly title?: string;
  readonly excerpt?: string | null;
  readonly translationGroupId?: string;
}

export interface ContentDraft {
  readonly siteId: string;
  readonly type?: string;
  readonly title: string;
  readonly slug?: string;
  readonly excerpt?: string | null;
  readonly fields?: Record<string, unknown>;
}

export interface ContentCreateGateEvent {
  readonly input: ContentDraft;
}

export interface MediaRef {
  readonly siteId: string;
  readonly mediaId: string;
}

export interface MediaUploadGateEvent {
  readonly siteId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface MediaUploadedEvent extends MediaRef {
  readonly url: string;
}

export interface UserEvent {
  readonly userId: string;
}

export interface AuthEvent {
  readonly userId: string;
  readonly email: string;
}

export interface AuthFailureEvent {
  readonly email: string;
  readonly reason: string;
}

export interface PluginEvent {
  readonly pluginId: string;
  readonly version: string;
  readonly siteId?: string;
}

export interface ThemeEvent {
  readonly themeId: string;
  readonly version: string;
  readonly siteId?: string;
}

export interface RequestStartEvent {
  readonly method: string;
  readonly path: string;
}

export interface RequestEndEvent extends RequestStartEvent {
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface UnderConstructionContext {
  readonly siteId: string;
  readonly siteTitle: string;
  readonly tagline: string;
}

export interface UnderConstructionViewedEvent {
  readonly siteId: string;
}

/** Cache layers that can be selectively revalidated. */
export type CacheObjectType =
  | "pages"
  | "content"
  | "menus"
  | "theme"
  | "cssProviders"
  | "site";

export type CacheRevalidateTrigger =
  | "content"
  | "menus"
  | "theme"
  | "settings"
  | "cssProviders"
  | "manual"
  | "plugin";

export interface CacheRevalidatedEvent {
  readonly trigger: CacheRevalidateTrigger;
  readonly objects: readonly CacheObjectType[];
  readonly siteId?: string;
}

export interface NavigationItem {
  id: string;
  label: string;
  url: string;
  children?: NavigationItem[];
}

/**
 * One admin sidebar entry a plugin contributes through the `admin.menu` filter
 * (and/or `adminMenu` in its manifest). The host re-validates every field.
 */
export interface AdminNavItem {
  pluginId: string;
  id: string;
  label: string;
  labelKey?: string;
  path: string;
  icon?: string;
  domain?: string;
  end?: boolean;
  /** Host-only: `GET /ext/{pluginId}/setup` is rendered on this path, not on nested pages. */
  setupPath?: string;
  /** Host lists CMS entries of this type on the plugin page. */
  contentType?: string;
}

/** OpenAPI 3.1 document plugins may extend through the `openapi.document` filter. */
export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Action map ────────────────────────────────────────────────────────────

/**
 * Every core action, mapped to its payload. Actions observe something that
 * already happened; they cannot cancel it.
 *
 * Plugins publishing their own actions augment this by declaration merging:
 *
 * @example
 * declare module "@justflows/sdk" {
 *   interface ActionEventMap {
 *     "acme.seo.scoreCalculated": { contentId: string; score: number };
 *   }
 * }
 */
export interface ActionEventMap {
  "app.starting": AppEvent;
  "app.started": AppEvent;
  "app.stopping": Record<string, never>;

  "content.created": ContentRef;
  "content.updated": ContentRef;
  "content.deleted": ContentDeletedRef;
  "content.published": ContentRef;
  "content.unpublished": ContentRef;
  "content.revisionSaved": ContentRevisionRef;
  "content.revisionDiscarded": ContentRevisionRef;
  "content.revisionRestored": ContentRevisionRef;

  "media.uploaded": MediaUploadedEvent;
  "media.deleted": MediaRef;

  "user.created": UserEvent;
  "user.updated": UserEvent;
  "user.deleted": UserEvent;
  "auth.login": AuthEvent;
  "auth.logout": AuthEvent;
  "auth.loginFailed": AuthFailureEvent;

  "plugin.installed": PluginEvent;
  "plugin.activated": PluginEvent;
  "plugin.deactivated": PluginEvent;
  /** Fired after that plugin's `deleteData()` hook has finished. */
  "plugin.deleteData": PluginEvent;
  "plugin.uninstalled": PluginEvent;
  "theme.installed": ThemeEvent;
  "theme.activated": ThemeEvent;

  "request.before": RequestStartEvent;
  "request.after": RequestEndEvent;

  "site.underConstruction.viewed": UnderConstructionViewedEvent;

  /** Fired after selective cache revalidation completes. */
  "cache.revalidated": CacheRevalidatedEvent;
}

// ─── Gate map ──────────────────────────────────────────────────────────────

/**
 * Every core gate, mapped to its payload. Gates run *before* the operation
 * commits and may cancel it. They fail closed — a handler that throws aborts
 * the operation.
 */
export interface GateEventMap {
  "content.beforeCreate": ContentCreateGateEvent;
  "content.beforeUpdate": ContentUpdateGateEvent;
  "content.beforeDelete": ContentRef;
  "content.beforePublish": ContentUpdateGateEvent;

  "media.beforeUpload": MediaUploadGateEvent;
  "media.beforeDelete": MediaRef;
}

// ─── Filter map ────────────────────────────────────────────────────────────

/**
 * Every core filter, mapped to `[value, context]`. A filter must return the
 * next value; returning nothing keeps the previous value and logs a warning.
 */
export interface FilterValueMap {
  "content.input": [Record<string, unknown>, { siteId: string }];
  "content.output": [Record<string, unknown>, { siteId: string }];
  /** Stored blocks before HTML render. Shop fills `{{price}}` tags here. */
  "content.blocks": [unknown, ContentRenderContext];
  "content.render": [string, ContentRenderContext];
  "content.revision": [ContentRevisionSnapshot, { siteId: string; contentId: string }];
  "media.metadata": [Record<string, unknown>, MediaRef];
  "navigation.items": [NavigationItem[], { siteId: string; location: string }];
  "admin.menu": [AdminNavItem[], { siteId: string }];
  /** Overlay plugin settings shown on Admin → Plugins → Settings. */
  "plugin.settings": [Record<string, unknown>, { pluginId: string; siteId: string }];
  /** Intercept a settings save so a plugin can persist domain rows and drop keys. */
  "plugin.settings.write": [Record<string, unknown>, { pluginId: string; siteId: string }];
  "openapi.document": [OpenApiDocument, { version: string }];
  "http.responseHeaders": [Record<string, string>, { method: string; path: string }];
  "html.head": [string, { siteId: string; path: string; title: string; contentId?: string }];
  /**
   * Extra CSS appended to the site stylesheet served at `/theme.css`, after the
   * theme's own styles and the Customizer tokens but before the site owner's
   * Additional CSS. The value is seeded with `""` and each handler appends its
   * plugin's stylesheet. Runs once per `/theme.css` build (cached, not per
   * page), so handlers may be async — read a file, minify once, memoise.
   * Reverting is automatic: deactivating the plugin drops the handler and the
   * next `/theme.css` build omits its CSS. `preview` is true when the
   * Customizer is previewing an unpublished draft.
   */
  "theme.css": [string, { siteId: string; preview: boolean }];
  "seo.sitemapPaths": [string[], { siteId: string }];
  "site.underConstruction.render": [string, UnderConstructionContext];
}

/** Filters applied on synchronous render paths — handlers must not be async. */
export const SYNC_FILTERS = [
  "http.responseHeaders",
  "html.head",
  "site.underConstruction.render",
] as const;

// ─── Name and handler helpers ──────────────────────────────────────────────

/** Known hook names autocomplete; plugin-namespaced names stay assignable. */
type Loose<K extends string> = K | (string & {});

export type ActionName = Loose<keyof ActionEventMap & string>;
export type GateName = Loose<keyof GateEventMap & string>;
export type FilterName = Loose<keyof FilterValueMap & string>;

export type ActionPayload<K> = K extends keyof ActionEventMap ? ActionEventMap[K] : unknown;
export type GatePayload<K> = K extends keyof GateEventMap ? GateEventMap[K] : object;

export type FilterValue<K> = K extends keyof FilterValueMap ? FilterValueMap[K][0] : unknown;
export type FilterContext<K> = K extends keyof FilterValueMap ? FilterValueMap[K][1] : unknown;

export type ActionHandlerFor<K> = (
  event: ActionPayload<K>,
  context: HookContext,
) => void | Promise<void>;

export type GateHandlerFor<K> = (
  event: Cancellable<GatePayload<K>>,
  context: HookContext,
) => void | Promise<void>;

export type FilterHandlerFor<K> = (
  value: FilterValue<K>,
  context: FilterContext<K>,
  hookContext: HookContext,
) => FilterValue<K> | Promise<FilterValue<K>>;

// ─── Hook permissions ──────────────────────────────────────────────────────

/**
 * Hook namespaces that require a manifest permission to listen on. Registering
 * without the permission fails at activation, not silently at runtime.
 */
export const HOOK_PERMISSION_PREFIXES: ReadonlyArray<{
  readonly prefix: string;
  readonly permission: string;
}> = [
  { prefix: "auth.", permission: "auth:hook" },
  { prefix: "user.", permission: "users:read" },
  { prefix: "admin.", permission: "admin:extend" },
];

/** The permission a hook name requires, or `null` when it is unrestricted. */
export function requiredPermissionForHook(hook: string): string | null {
  for (const rule of HOOK_PERMISSION_PREFIXES) {
    if (hook.startsWith(rule.prefix)) return rule.permission;
  }
  return null;
}

/**
 * A plugin may only emit hooks under its own manifest ID. This keeps the core
 * namespace un-spoofable and makes hook ownership readable from the name.
 */
export function isOwnedHookName(pluginId: string, hook: string): boolean {
  return hook === pluginId || hook.startsWith(`${pluginId}.`);
}
