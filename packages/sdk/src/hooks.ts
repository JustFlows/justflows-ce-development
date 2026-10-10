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

/** An authenticated account view. Identity comes from the verified site session. */
export interface AccountSectionContext {
  readonly siteId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly installationRoot: boolean;
}

/** A POST action. The endpoint must enforce its own ownership and CSRF checks. */
export interface AccountAction {
  label: string;
  /** Same-origin /api/account/… or /ext/<plugin-id>/account/… endpoint. */
  endpoint: string;
  confirm?: string;
}

/** Text is escaped by the host; links accept same-origin paths or HTTPS URLs. */
export interface AccountCard {
  title: string;
  fields?: Array<{ label: string; value: string }>;
  links?: Array<{ label: string; href: string }>;
  actions?: AccountAction[];
}

/** Server-rendered, request-scoped contributions to the default /account page. */
export interface AccountSection {
  /** Stable anchor, preferably namespaced: justflows.shop.subscriptions. */
  id: string;
  title: string;
  description?: string;
  cards: AccountCard[];
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

/** Fields copied into a new translation. Plugins may blank or reshape them. */
export interface ContentTranslationSeed {
  type: string;
  title: string;
  excerpt: string | null;
  fields: unknown;
  blocks: unknown;
}
export interface ContentRenderContext {
  readonly siteId: string;
  readonly contentId: string;
  readonly type?: string;
  readonly title?: string;
  readonly excerpt?: string | null;
  readonly translationGroupId?: string;
  /**
   * Language of the page being rendered (the URL's locale). Can differ from the
   * entry's own locale when an untranslated entry is shown under another
   * language's prefix. Absent on older hosts.
   */
  readonly locale?: string;
}

/** One approved comment in the public thread, passed to `comments.render`. */
export interface PublicComment {
  readonly id: string;
  readonly parentId: string | null;
  readonly authorName: string;
  readonly authorUrl: string | null;
  /** Sanitised HTML — a small safe formatting subset. */
  readonly bodyHtml: string;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly editedAt: string | null;
  /** 0 for a top-level comment. */
  readonly depth: number;
  readonly replies: PublicComment[];
}

/**
 * Context for `comments.render` — the rendered `justflows.comments.thread`
 * block, plus the threaded data behind it so a handler can rebuild the markup
 * from scratch.
 */
export interface CommentsBlockRenderContext {
  readonly siteId: string;
  readonly contentId: string;
  readonly contentType: string;
  readonly slug: string | null;
  readonly locale: string;
  /** Permalink of the page the block sits on (for reply / pagination links). */
  readonly basePath: string;
  /** Block props set in the page builder. */
  readonly props: { readonly title: string; readonly order: "oldest" | "newest" };
  /** Whether the section renders at all, and whether it still takes new comments. */
  readonly visible: boolean;
  readonly accepting: boolean;
  /** Threaded approved comments for the current page. */
  readonly comments: PublicComment[];
  /** Total approved comments across every page. */
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;
  /** Set only on the render right after a submission redirect. */
  readonly banner: "posted" | "pending" | "error" | "captcha" | "rate_limited" | null;
  /** The signed-in commenter, if any. */
  readonly currentUser: { readonly name: string; readonly email: string } | null;
  readonly captchaProvider: "none" | "turnstile" | "hcaptcha" | "recaptcha" | "recaptcha-v3";
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

export interface UserAccessChangedEvent extends UserEvent {
  readonly roleId: string;
}

export interface AccessRoleEvent {
  readonly roleId: string;
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

export interface CoreUpdatedEvent {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly source: "upload" | "remote" | "automatic";
}

export interface WebhookDeliveryEvent {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly event: string;
  readonly data: unknown;
  readonly attempt: number;
  readonly status: "delivered" | "retrying" | "failed";
  readonly responseStatus: number | null;
  readonly responseBody: string | null;
  readonly error: string | null;
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

// ─── System email lifecycle ──────────────────────────────────────────────

export interface EmailDeliveryContext {
  readonly deliveryId?: string;
  readonly templateKey?: string;
  readonly templateVersion?: number;
  readonly locale?: string;
  readonly messageType: string;
  readonly recipient: string;
  readonly transport: string;
  readonly correlationId?: string;
}

export interface EmailBeforeSendEvent extends EmailDeliveryContext {}

export interface EmailDeliveryEvent extends EmailDeliveryContext {
  readonly status: "queued" | "sent" | "deferred" | "failed" | "bounced";
  readonly attempt: number;
  /** Bounded, sanitized provider response or failure detail. */
  readonly detail?: string;
}

export interface EmailSender {
  /** RFC-compatible From header produced by the host. */
  readonly from: string;
  readonly replyTo?: string;
  readonly envelopeSender?: string;
}

/** Cache layers that can be selectively revalidated. */
export type CacheObjectType = "pages" | "content" | "menus" | "theme" | "cssProviders" | "site";

export type CacheRevalidateTrigger =
  "content" | "menus" | "theme" | "settings" | "cssProviders" | "manual" | "plugin";

export interface CacheRevalidatedEvent {
  readonly trigger: CacheRevalidateTrigger;
  readonly objects: readonly CacheObjectType[];
  readonly siteId?: string;
}

/** Summary of a completed static-site export run (`staticExport.completed`). */
export interface StaticExportCompletedEvent {
  readonly ok: boolean;
  readonly mode: "full" | "incremental";
  /** Absolute directory the files were written to. */
  readonly outDir: string;
  /** Public origin the pages are meant to be served from (may be ""). */
  readonly publicUrl: string;
  readonly pages: number;
  readonly assets: number;
  readonly bytes: number;
  readonly pruned: number;
  readonly durationMs: number;
  readonly errors: readonly string[];
}

/**
 * Fired after `staticExport.completed`, carrying enough context for a plugin to
 * push the generated directory to object storage or a CDN and invalidate the
 * changed paths. `manifest` is the parsed `_static-export.json`.
 */
export interface StaticExportDeployEvent {
  readonly outDir: string;
  readonly publicUrl: string;
  readonly manifest: unknown;
  readonly summary: StaticExportCompletedEvent;
}

/**
 * A URL path the static-site exporter leaves to the live app
 * (`staticExport.exclude`). The path is never crawled, written, or linked to
 * as a static file; copies from earlier runs are removed; the generated
 * `.htaccess` / `_nginx.conf` route it to the app; and with
 * `STATIC_EXPORT_ORIGIN_URL` set, links and form actions pointing at it are
 * rewritten to that origin.
 */
export interface StaticExportExclusion {
  /** Root-relative URL path, e.g. `/shop/checkout`. Letters, digits, `.`, `_`, `~`, `-` per segment. */
  path: string;
  /** `prefix` (default) also covers every path below it on a `/` boundary; `exact` only this path. */
  match?: "exact" | "prefix";
}

export interface NavigationItem {
  id: string;
  label: string;
  url: string;
  children?: NavigationItem[];
}

// ─── Menu designer ──────────────────────────────────────────────────────────

/** Menu-level layout a menu designer instance renders as. */
export const MENU_LAYOUTS = [
  "horizontal",
  "vertical",
  "dropdown",
  "multi-level-dropdown",
  "mega",
  "footer",
  "drawer",
] as const;
export type MenuLayout = (typeof MENU_LAYOUTS)[number];

/** How a top-level item's dropdown/mega panel is opened. */
export const MENU_ACTIVATIONS = ["hover", "click", "both"] as const;
export type MenuActivation = (typeof MENU_ACTIVATIONS)[number];

/**
 * How the menu presents below its breakpoint. The pre-1.0 value `"drawer"` is
 * accepted by the host and mapped to `"drawer-right"` on read.
 */
export const MENU_MOBILE_PATTERNS = [
  "dropdown",
  "accordion",
  "drawer-right",
  "drawer-left",
  "fullscreen",
] as const;
export type MenuMobilePattern = (typeof MENU_MOBILE_PATTERNS)[number];

/** Enter/exit motion for the open mobile menu (`prefers-reduced-motion` forces `none` at render). */
export const MENU_MOBILE_MOTIONS = ["slide", "fade", "none"] as const;
export type MenuMobileMotion = (typeof MENU_MOBILE_MOTIONS)[number];

/** Top-level alignment of the menu bar. */
export const MENU_ALIGNMENTS = ["start", "center", "end", "space-between"] as const;
export type MenuAlignment = (typeof MENU_ALIGNMENTS)[number];

/**
 * Fixed subset of `@justflows/blocks` core kinds a mega-menu region may
 * contain. Deliberately excludes `core.html`/`core.code`/`core.embed` even
 * though the host sanitizer would clean them — menu content must never carry
 * arbitrary scripts or raw HTML, not merely sanitized versions of them.
 */
export const MEGA_MENU_SAFE_BLOCK_KINDS = [
  "core.paragraph",
  "core.heading",
  "core.image",
  "core.button",
  "core.link-list",
  "core.divider",
  "core.spacer",
  "core.section",
  "core.container",
  "core.group",
  "core.columns",
  "core.column",
  "core.grid",
  "core.reusable",
] as const;
export type MegaMenuSafeBlockKind = (typeof MEGA_MENU_SAFE_BLOCK_KINDS)[number];

/**
 * The layout/design fields a preset seeds onto a menu. Mirrors the host's
 * `MenuDesign` one-for-one (minus `presetId`, which the host assigns) so a
 * plugin-supplied preset and a hand-edited design are the same shape. The host
 * re-parses whatever a filter returns, clamping numbers and dropping unknown
 * enum values, so a preset can never widen what the designer itself allows.
 */
export interface MenuDesignSeed {
  layout: MenuLayout;
  activation: MenuActivation;
  /** px; below this width the mobile pattern applies (clamped to 320–1400). */
  breakpoint: number;
  mobilePattern: MenuMobilePattern;
  mobileMotion?: MenuMobileMotion;
  /** Motion duration in ms (clamped to 120–800). */
  mobileMotionMs?: number;
  alignment: MenuAlignment;
  /** Clamped to 1–4. */
  maxDepth: number;
  /** Clamped to 1–40. */
  maxItemsPerLevel: number;
}

/**
 * A built-in-style menu design a plugin or theme contributes through the
 * `menu.design.presets` filter. It appears as a one-click starting point in
 * the menu designer's design panel — picking it fills in the menu's layout
 * config, it does not persist any relationship to the preset afterward.
 */
export interface MenuDesignPreset {
  /** `"<pluginId>:<slug>"` — must sit under the contributing plugin's namespace. */
  readonly id: string;
  readonly name: string;
  /** Plugin or theme id that contributed it. */
  readonly source?: string;
  readonly description?: string;
  readonly design: MenuDesignSeed;
}

/** Who is viewing, for a `menu.visibility.evaluate` check. */
export interface MenuVisibilityEvaluateContext {
  readonly siteId: string;
  readonly authState: "guest" | "authenticated";
  readonly role?: string;
  readonly locale: string;
}

// ─── Header designs ────────────────────────────────────────────────────────

/**
 * The header configuration a page renders. Mirrors the host's internal
 * `PageHeaderConfig`; the host re-validates and sanitises every field it
 * receives back from a filter (blocks are capped, `background` must be a safe
 * CSS colour, enums are clamped).
 */
export interface HeaderConfig {
  visible: boolean;
  menuMode: "inherit" | "menu" | "none";
  menuSlug: string;
  showLogo: boolean;
  showTitle: boolean;
  layout: "logo-left" | "logo-center" | "split";
  sticky: boolean;
  background: string;
  showLanguageSwitcher: boolean;
  languageSwitcherStyle: "locale-full" | "locale-short" | "flags" | "flag-locale" | "flag-country";
  showColorScheme: boolean;
  showColorSchemeSystem: boolean;
  showAuthLinks: boolean;
  /** Free blocks rendered into the header, same schema as page-body blocks. */
  blocks: unknown[];
}

export interface HeaderBuildContext {
  readonly siteId: string;
  readonly locale: string;
  readonly defaultLocale: string;
}

/**
 * A header design a plugin or theme contributes through the `header.templates`
 * filter. It appears in the per-page header dropdown and the customizer's
 * "start from" list. Selecting it stores the ref `"<pluginId>:<slug>"` on the
 * page; the host calls `build()` at render time (cached per ref + locale), so
 * it may read plugin data and vary by locale.
 */
export interface HeaderTemplate {
  /** `"<pluginId>:<slug>"` — must sit under the contributing plugin's namespace. */
  readonly id: string;
  readonly name: string;
  /** Plugin or theme id that contributed it. */
  readonly source?: string;
  readonly description?: string;
  build(ctx: HeaderBuildContext): HeaderConfig | Promise<HeaderConfig>;
}

export interface HeaderResolveContext {
  readonly siteId: string;
  readonly locale: string;
  readonly defaultLocale: string;
  /** The stored ref: `"__default__"` | `"__none__"` | `"<lib-uuid>"` | `"<pluginId>:<slug>"`. */
  readonly ref: string;
  /** Present when a content page is rendering; absent for 404 / fallback chrome. */
  readonly contentId?: string;
  readonly contentType?: string;
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
  /**
   * Relative to `/admin/plugins/<pluginId>` — `""` / omit for the namespace
   * root, else a lowercase leaf like `"orders"`. The host prepends the
   * namespace; an absolute path (or one repeating the id) is rejected.
   */
  path?: string;
  icon?: string;
  domain?: string;
  end?: boolean;
  /** Host-only: `GET /ext/{pluginId}/setup` is rendered on this path, not on nested pages. */
  setupPath?: string;
  /** Host lists CMS entries of this type on the plugin page. */
  contentType?: string;
  /** When false, the page is reachable but omitted from the admin nav. */
  listed?: boolean;
}

/** OpenAPI 3.1 document plugins may extend through the `openapi.document` filter. */
export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, unknown>;
  [key: string]: unknown;
}

/** Who an MCP or assistant tool call runs as. */
export interface McpToolCallContext {
  siteId: string;
  userId: string;
  /** `mcp` for an external MCP client, `assistant` for the in-admin assistant. */
  via: "mcp" | "assistant";
  /** Client display name ("Claude", "Cursor", "Assistant"). */
  client: string;
  /** The capabilities this call may exercise (key or grant ∩ the user's current access). */
  capabilities: readonly string[];
}

/**
 * An extra agent tool a plugin contributes through the `mcp.tools` filter. The
 * host lists it only to sessions that hold `capability`, checks it again before
 * every call, and records each non-read-only call in the audit log. `handler`
 * must enforce any finer-grained (per-resource) checks itself.
 */
export interface McpToolDefinition {
  /** Unique, `snake_case`, prefixed with the plugin (`acme_seo_score`). */
  name: string;
  title?: string;
  /** Written for a model: what the tool does and when to use it. */
  description: string;
  /** JSON Schema for the arguments (`type: "object"`). */
  inputSchema: Record<string, unknown>;
  capability: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler(args: Record<string, unknown>, context: McpToolCallContext): unknown | Promise<unknown>;
}

// ─── Action map ────────────────────────────────────────────────────────────

/** A workspace a plugin may observe. Connection secrets are never included. */
export interface WorkspaceEvent {
  tenantId: string;
  siteId: string;
  hostname: string;
  userMode: "isolated" | "shared";
  databaseMode: "current" | "separate";
}

/**
 * `workspace.created` plus who administers the new workspace. Listening requires
 * `platform:tenancy`, because it carries an email address.
 */
export interface TenancyWorkspaceCreatedEvent extends WorkspaceEvent {
  /** Sign-in email of the workspace's first administrator. Empty when unknown. */
  adminEmail: string;
}

export interface WorkspaceStatusEvent {
  tenantId: string;
}

export interface WorkspaceDeleteEvent {
  tenantId: string;
  dropDatabase: boolean;
}

export interface WorkspaceCreateGateEvent {
  name: string;
  slug: string;
  userMode: "isolated" | "shared";
  databaseMode: "current" | "separate";
  siteName: string;
  hostname: string;
}

export interface SiteCreateEvent {
  tenantId: string;
  siteId: string;
  hostname: string;
  databaseChoice: "inherit" | "current" | "separate";
}

export interface QuotaUpdatedEvent {
  scope: "workspace" | "site";
  scopeId: string;
  /** Meter key to the stored limit. `null` means that meter is unlimited. */
  limits: Record<string, number | null>;
}

/** A custom domain a website connected. */
export interface DomainEvent {
  siteId: string;
  domainId: string;
  hostname: string;
  /** `records`: the customer edits their own DNS. `nameservers`: the platform hosts the zone. */
  mode: "records" | "nameservers";
  provider: "manual" | "bunny";
}

export interface DomainAddGateEvent {
  siteId: string;
  hostname: string;
  mode: "records" | "nameservers";
}

export interface QuotaLimitContext {
  key: string;
  scope: "workspace" | "site";
  scopeId: string;
  /** The value stored for this meter, before this filter. `null` means unlimited. */
  storedLimit: number | null;
}

export interface SiteCreateGateEvent {
  tenantId: string;
  name: string;
  hostname: string;
  databaseChoice: "inherit" | "current" | "separate";
  userMode: "isolated" | "shared";
  databaseMode: "current" | "separate";
}

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
  "user.accessChanged": UserAccessChangedEvent;
  "access.roleCreated": AccessRoleEvent;
  "access.roleUpdated": AccessRoleEvent;
  "access.roleDeleted": AccessRoleEvent;
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
  "core.updated": CoreUpdatedEvent;
  /** Observe the bounded response or error after every outbound attempt. */
  "webhook.delivered": WebhookDeliveryEvent;

  "workspace.created": WorkspaceEvent;
  "tenancy.workspaceCreated": TenancyWorkspaceCreatedEvent;
  "workspace.suspended": WorkspaceStatusEvent;
  "workspace.reactivated": WorkspaceStatusEvent;
  "workspace.deleted": WorkspaceDeleteEvent;
  "site.created": SiteCreateEvent;

  "request.before": RequestStartEvent;
  "request.after": RequestEndEvent;

  "site.underConstruction.viewed": UnderConstructionViewedEvent;

  /** Fired after selective cache revalidation completes. */
  "cache.revalidated": CacheRevalidatedEvent;

  /** A static-site export run finished (manual, CLI, or auto-rebuild). */
  "staticExport.completed": StaticExportCompletedEvent;
  /** Deploy the generated directory to object storage / a CDN. */
  "staticExport.deploy": StaticExportDeployEvent;

  /** Delivery has been accepted by the host and recorded, before transport I/O. */
  "email.queued": EmailDeliveryEvent;
  /** The transport accepted the message. */
  "email.sent": EmailDeliveryEvent;
  /** The attempt failed or was deferred. */
  "email.failed": EmailDeliveryEvent;

  /** Fired after a platform operator or a plugin saves quota limits. */
  "quota.updated": QuotaUpdatedEvent;

  /** A website added a custom domain. It is not served until it is verified. */
  "domain.added": DomainEvent;
  /** DNS was verified and the certificate is in place. The domain is served. */
  "domain.activated": DomainEvent;
  /** An active domain failed its checks too often and is no longer served. */
  "domain.failed": DomainEvent;
  /** Removed by the website, or released after it stayed unverified. */
  "domain.removed": DomainEvent;
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

  /** Cancel a final, rendered delivery before it is queued or sent. */
  "email.beforeSend": EmailBeforeSendEvent;

  "workspace.beforeCreate": WorkspaceCreateGateEvent;
  "workspace.beforeSuspend": WorkspaceStatusEvent;
  "workspace.beforeReactivate": WorkspaceStatusEvent;
  "workspace.beforeDelete": WorkspaceDeleteEvent;
  "site.beforeCreate": SiteCreateGateEvent;
  /** Before a website adds a custom domain. Cancel to refuse it, for example to require a paid plan. */
  "domain.beforeAdd": DomainAddGateEvent;
}

// ─── Filter map ────────────────────────────────────────────────────────────

/**
 * Every core filter, mapped to `[value, context]`. A filter must return the
 * next value; returning nothing keeps the previous value and logs a warning.
 */
export interface FilterValueMap {
  /** Signed-in account sections. Requires users:read; never share-cache returned data. */
  "account.sections": [AccountSection[], AccountSectionContext];
  /** Supply an external candidate engine; host authorization is never delegated. */
  "search.backend": [import("./search.js").SearchBackend | null, { siteId: string }];
  /**
   * Content types included in public search. Seeded from search settings
   * (`page` and `post` when unset). Plugins append their own type slugs.
   */
  "search.publicTypes": [string[], { siteId: string }];
  /** Event names administrators may subscribe to. Plugins append their names. */
  "webhook.eventTypes": [string[], Record<string, never>];
  /** Shape JSON-safe event data before the host builds and signs its envelope. */
  "webhook.payload": [unknown, { event: string; siteId: string }];
  "content.input": [Record<string, unknown>, { siteId: string }];
  "content.output": [Record<string, unknown>, { siteId: string }];
  /** Stored blocks before HTML render. Plugins fill `{{tags}}` here. */
  "content.blocks": [unknown, ContentRenderContext];
  "content.render": [string, ContentRenderContext];
  /**
   * Merge-tag values for the editor preview. Seeded with title and excerpt.
   * Plugins add their own keys. Keys are the names inside `{{name}}`.
   */
  "content.mergeTags": [Record<string, string>, ContentRenderContext];
  /**
   * Block editor vs field editor for a content type. Seeded with `"blocks"` for
   * `page` and `"fields"` otherwise. Plugins return `"blocks"` for types that
   * use the page builder.
   */
  "content.editor": ["blocks" | "fields", { siteId: string; type: string }];
  /**
   * Title, excerpt, fields, and blocks copied when a translation is created.
   * Plugins return a replacement seed.
   */
  "content.translationSeed": [
    ContentTranslationSeed,
    { siteId: string; sourceId: string; locale: string },
  ];
  /**
   * Content types that start from a same-named pattern. Seeded with `["post"]`.
   * Plugins append their own type slugs.
   */
  "content.patternTypes": [string[], { siteId: string }];
  /**
   * The rendered public comments block (`justflows.comments.thread`). The value
   * is the default HTML; return replacement HTML for full markup control, or
   * the value unchanged to keep the default. The context carries the threaded
   * comment data so a handler can render from scratch. Handlers may be async.
   * Deactivating the plugin restores the default markup.
   */
  "comments.render": [string, CommentsBlockRenderContext];
  /**
   * Optional external candidate spam-scoring service for public comment
   * submissions (Akismet-style). Seeded with `null`; the host always applies
   * its own thresholds and never requires a handler to be registered.
   */
  "comments.spamBackend": [import("./spam.js").SpamCheckBackend | null, { siteId: string }];
  "content.revision": [ContentRevisionSnapshot, { siteId: string; contentId: string }];
  "media.metadata": [Record<string, unknown>, MediaRef];
  /**
   * The placeholder shown for an empty image slot of `kind`. Seeded with the
   * plugin-registered or shipped image; return another image, or `null` to
   * leave the slot empty. Skipped when the site owner picked their own image
   * or switched placeholders off. Runs on block render, so handlers must be
   * synchronous.
   */
  "media.placeholder": [
    import("./placeholders.js").PlaceholderImage | null,
    import("./placeholders.js").PlaceholderFilterContext,
  ];
  "navigation.items": [NavigationItem[], { siteId: string; location: string }];
  /**
   * Menu design presets a site owner can pick beyond the built-in set, shown
   * in the menu designer's design panel. Seeded with `[]`; each handler
   * appends its presets.
   */
  "menu.design.presets": [MenuDesignPreset[], { siteId: string }];
  /**
   * Evaluate a plugin-provided menu-item visibility condition (an item whose
   * `visibility.condition.id` the host does not recognize on its own). Seeded
   * with `false` — an unrecognized or uninstalled condition hides the item
   * (deny-by-default), never exposes it.
   */
  "menu.visibility.evaluate": [
    boolean,
    {
      item: NavigationItem;
      condition: { id: string; params?: Record<string, unknown> };
      context: MenuVisibilityEvaluateContext;
    },
  ];
  /**
   * Header designs a site owner can pick beyond their own library. Seeded with
   * `[]`; each handler appends its templates. Metadata only — `build()` runs
   * later, at render time.
   */
  "header.templates": [HeaderTemplate[], { siteId: string; locale: string; defaultLocale: string }];
  /**
   * Take over which header a page renders, before the host resolves the stored
   * ref. Return a `HeaderConfig` to own it, or `null` to let the host resolve
   * normally. Use for headers that must be computed per request.
   */
  "header.resolve": [HeaderConfig | null, HeaderResolveContext];
  /**
   * Adjust the resolved header just before render — inject a block, flip a
   * widget, swap the menu. Runs for every header, whatever its source.
   */
  "header.config": [HeaderConfig, HeaderResolveContext];
  "admin.menu": [AdminNavItem[], { siteId: string }];
  /** Overlay plugin settings shown on Admin → Plugins → Settings. */
  "plugin.settings": [Record<string, unknown>, { pluginId: string; siteId: string }];
  /** Intercept a settings save so a plugin can persist domain rows and drop keys. */
  "plugin.settings.write": [Record<string, unknown>, { pluginId: string; siteId: string }];
  "openapi.document": [OpenApiDocument, { version: string }];
  /**
   * Extra tools for the MCP server and the in-admin assistant. Seeded with
   * `[]`; each handler appends its tools. Mirrors `openapi.document`.
   */
  "mcp.tools": [McpToolDefinition[], { siteId: string }];
  "http.responseHeaders": [Record<string, string>, { method: string; path: string }];
  "html.head": [
    string,
    { siteId: string; path: string; locale: string; title: string; contentId?: string },
  ];
  /**
   * The analytics `<head>` markup the host is about to emit (the Google Tag from
   * the first-party Analytics plugin, when one is configured). Seeded with that
   * markup or `""`. A consent plugin rewrites it — e.g. to
   * `type="text/plain" data-jf-consent="analytics"` — so the tag does not run
   * until the visitor grants the analytics category. Runs on the sync render
   * path, so handlers must be synchronous. Returning it unchanged is a no-op.
   */
  "analytics.head": [string, { siteId: string; path: string }];
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
  /**
   * Layout targets in the theme customizer (content width and wide width).
   * Seeded with `[]`. An active plugin appends one entry per public section
   * whose width should differ from the site default. Deactivating the plugin
   * removes the entry. Core does not ship any.
   */
  "theme.layoutScopes": [ThemeLayoutScope[], { siteId: string }];
  /**
   * Default permalink bases keyed by content type. Seeded with the stored
   * bases. A plugin fills bases for its own types; stored values already in
   * the seed win. Deactivating the plugin drops the defaults.
   */
  "permalinks.typeBases": [Record<string, string>, { siteId: string }];
  "seo.sitemapPaths": [string[], { siteId: string }];
  /**
   * The seed URL paths the static-site exporter will crawl, before link
   * discovery. Seeded from `sitemap.xml` plus every published entry. Add paths a
   * plugin renders dynamically. A dropped seed is still crawled when a page
   * links to it; use `staticExport.exclude` to keep a path out of the export.
   */
  "staticExport.routes": [string[], { siteId: string }];
  /**
   * The `<form action>` written into exported HTML for a dynamic endpoint that a
   * static host cannot serve. Seeded with the origin-absolute URL when
   * `STATIC_EXPORT_ORIGIN_URL` is set, else the relative default. Return a
   * serverless function URL, a third-party form endpoint, etc.
   */
  "staticExport.formAction": [
    string,
    { siteId: string; endpoint: "forms" | "comments"; defaultAction: string },
  ];
  /**
   * Same-origin asset URLs the static-site exporter should download, seeded with
   * everything it found by scanning `<script>`, `<link>`, `<img>`, `srcset` and
   * CSS `url()`. Append assets a plugin or custom theme loads in a way the
   * scanner cannot see — a dynamically-imported chunk, a Web Worker, a JSON
   * config fetched at runtime, a font referenced only from inline JS.
   */
  "staticExport.assets": [string[], { siteId: string }];
  /**
   * Paths the static-site exporter must leave to the live app: per-visitor
   * pages (cart, checkout, account), pages that must always show live data,
   * or asset URLs that must not be copied. Seeded empty. Invalid entries,
   * `/`, and the core dynamic prefixes (admin, `/api`, auth pages) are ignored.
   */
  "staticExport.exclude": [StaticExportExclusion[], { siteId: string }];
  "site.underConstruction.render": [string, UnderConstructionContext];
  /** Adjust final sender fields. The host revalidates all header values. */
  "email.sender": [EmailSender, EmailDeliveryContext];
  /** Adjust the final subject. CR/LF and oversized output are rejected. */
  "email.subject": [string, EmailDeliveryContext];
  /** Adjust final HTML. Changed output is sanitized to the supported email subset. */
  "email.html": [string, EmailDeliveryContext];
  /** Adjust final plain text. Changed output is stripped to plain text. */
  "email.text": [string, EmailDeliveryContext];
  /**
   * The limit that will be enforced. Seeded with the stored value (`null` means
   * unlimited). Return a lower number to tighten it. A higher number or `null`
   * cannot raise a stored limit. Listening requires `platform:tenancy`.
   */
  "quota.effectiveLimit": [number | null, QuotaLimitContext];
}

/** One customizer layout target contributed by an active plugin. */
export interface ThemeLayoutScope {
  /** Stable id used in CSS and stored mods, such as `product`. */
  id: string;
  label: string;
  /** Public prefix without slashes, such as `product`. */
  base: string;
  /** CMS row published at `/{base}` — the parent of entries under that prefix. */
  index?: { type: string; slug: string };
}

/** Filters applied on synchronous render paths — handlers must not be async. */
export const SYNC_FILTERS = [
  "http.responseHeaders",
  "html.head",
  "analytics.head",
  "site.underConstruction.render",
  "media.placeholder",
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
  { prefix: "search.", permission: "content:read" },
  { prefix: "comments.spamBackend", permission: "network:outbound" },
  { prefix: "auth.", permission: "auth:hook" },
  { prefix: "user.", permission: "users:read" },
  { prefix: "account.", permission: "users:read" },
  { prefix: "admin.", permission: "admin:extend" },
  { prefix: "email.", permission: "mail:hook" },
  { prefix: "quota.", permission: "platform:tenancy" },
  { prefix: "tenancy.", permission: "platform:tenancy" },
  { prefix: "domain.", permission: "platform:tenancy" },
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
