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
  readonly banner: "posted" | "pending" | "error" | "captcha" | null;
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
}

// ─── Filter map ────────────────────────────────────────────────────────────

/**
 * Every core filter, mapped to `[value, context]`. A filter must return the
 * next value; returning nothing keeps the previous value and logs a warning.
 */
export interface FilterValueMap {
  /** Event names administrators may subscribe to. Plugins append their names. */
  "webhook.eventTypes": [string[], Record<string, never>];
  /** Shape JSON-safe event data before the host builds and signs its envelope. */
  "webhook.payload": [unknown, { event: string; siteId: string }];
  "content.input": [Record<string, unknown>, { siteId: string }];
  "content.output": [Record<string, unknown>, { siteId: string }];
  /** Stored blocks before HTML render. Shop fills `{{price}}` tags here. */
  "content.blocks": [unknown, ContentRenderContext];
  "content.render": [string, ContentRenderContext];
  /**
   * The rendered public comments block (`justflows.comments.thread`). The value
   * is the default HTML; return replacement HTML for full markup control, or
   * the value unchanged to keep the default. The context carries the threaded
   * comment data so a handler can render from scratch. Handlers may be async.
   * Deactivating the plugin restores the default markup.
   */
  "comments.render": [string, CommentsBlockRenderContext];
  "content.revision": [ContentRevisionSnapshot, { siteId: string; contentId: string }];
  "media.metadata": [Record<string, unknown>, MediaRef];
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
  "seo.sitemapPaths": [string[], { siteId: string }];
  /**
   * The seed URL paths the static-site exporter will crawl, before link
   * discovery. Seeded from `sitemap.xml` plus every published entry. Add paths a
   * plugin renders dynamically, or drop paths that must not be exported.
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
  "site.underConstruction.render": [string, UnderConstructionContext];
  /** Adjust final sender fields. The host revalidates all header values. */
  "email.sender": [EmailSender, EmailDeliveryContext];
  /** Adjust the final subject. CR/LF and oversized output are rejected. */
  "email.subject": [string, EmailDeliveryContext];
  /** Adjust final HTML. Changed output is sanitized to the supported email subset. */
  "email.html": [string, EmailDeliveryContext];
  /** Adjust final plain text. Changed output is stripped to plain text. */
  "email.text": [string, EmailDeliveryContext];
}

/** Filters applied on synchronous render paths — handlers must not be async. */
export const SYNC_FILTERS = [
  "http.responseHeaders",
  "html.head",
  "analytics.head",
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
  { prefix: "email.", permission: "mail:hook" },
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
