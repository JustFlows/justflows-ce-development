import { z } from "zod";
import { gplLicenseValidationMessage, isGplCompatibleLicense } from "./license.js";
import { RegistryListingSchema } from "./registry.js";
import { ExtensionEnginesSchema } from "./compatibility.js";
import type { PluginCookiesApi } from "./cookies.js";
import type { BlockPattern } from "./patterns.js";
import type { AccessPolicy, UserCapability, UserCapabilityDefinition } from "./capabilities.js";
import type {
  ActionName,
  ActionHandlerFor,
  ActionPayload,
  FilterName,
  FilterHandlerFor,
  FilterValue,
  FilterContext,
  GateName,
  GateHandlerFor,
  GatePayload,
  HookRegisterOptions,
  Unsubscribe,
} from "./hooks.js";

// ─── Plugin manifest ──────────────────────────────────────────────────────

export const PluginPermissionSchema = z.enum([
  "content:read",
  "content:create",
  "content:update",
  "content:delete",
  "content:publish",
  "content:revisions:read",
  "content:revisions:restore",
  "content:revisions:discard",
  "media:read",
  "media:upload",
  "media:delete",
  "users:read",
  "users:manage",
  "settings:read",
  "settings:manage",
  "network:outbound",
  "admin:extend",
  "jobs:register",
  "diagnostics:publish",
  "mail:send",
  "mail:transport",
  "mail:templates",
  "mail:hook",
  "auth:hook",
]);

export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const SENSITIVE_PERMISSIONS: PluginPermission[] = [
  "network:outbound",
  "users:manage",
  "settings:manage",
  "auth:hook",
  "mail:send",
  "mail:transport",
  "mail:templates",
  "mail:hook",
];

/** Host/runtime versions exposed to an activated extension. */
export interface JustflowsRuntimeVersions {
  /** Installed Justflows CE version. */
  readonly justflows: string;
  /** Installed `@justflows/sdk` package version. */
  readonly sdk: string;
  /** Major contract revision for runtime feature detection. */
  readonly sdkApi: number;
}

// ─── Admin menu contributions ─────────────────────────────────────────────

/** Sidebar groups an extension may contribute an admin page to. */
export const ADMIN_MENU_DOMAINS = [
  "content",
  "commerce",
  "appearance",
  "users",
  "extensions",
  "tools",
  "security",
  "system",
] as const;

export type AdminMenuDomain = (typeof ADMIN_MENU_DOMAINS)[number];

/**
 * One admin navigation entry owned by a plugin. The host renders these only
 * while the plugin is installed, so uninstalling a plugin takes its pages out
 * of the sidebar with it.
 */
export const AdminMenuItemSchema = z.object({
  /** Unique within the plugin — used as the nav key and for de-duplication. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Menu id must be lowercase kebab-case"),
  /** English label, shown when `labelKey` is absent or untranslated. */
  label: z.string().min(1).max(60),
  /** Optional admin i18n catalog key, e.g. "nav.analytics". */
  labelKey: z.string().max(120).optional(),
  /** Admin application path. Must live under /admin/ — the host serves nothing else. */
  path: z.string().regex(/^\/admin\/[a-z0-9][a-z0-9\-/]*$/, "Menu path must be an /admin/… route"),
  icon: z.string().min(1).max(8).default("🔌"),
  domain: z.enum(ADMIN_MENU_DOMAINS).default("extensions"),
  /** Match the path exactly instead of as a prefix. */
  end: z.boolean().optional(),
  /**
   * CMS type slug. When set, the generic plugin host lists every content row
   * of that type on this page (for example Shop Products → `product`).
   */
  contentType: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{0,59}$/,
      "Content type slug must be lowercase letters, numbers, and hyphens",
    )
    .optional(),
});

export type PluginAdminMenuItem = z.infer<typeof AdminMenuItemSchema>;

/** A plugin asset path: relative, no traversal, `.js`/`.mjs`/`.css` only. */
const PluginAssetFileSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(js|mjs|css)$/,
    "Asset must be a relative .js/.mjs/.css path",
  )
  .refine((value) => !value.split("/").includes(".."), "Asset path must not contain '..'");

/**
 * Client-side assets a plugin ships in its package. On activation the host
 * serves `<dir>/**` at `/ext/<pluginId>/**` and auto-enqueues `scripts` /
 * `styles` on every public page — no `ctx.http` route or `html.head` filter.
 * The static exporter downloads them like any other same-origin asset.
 */
export const PluginAssetsSchema = z.object({
  /** Package-relative folder holding the assets. Defaults to `public`. */
  dir: z
    .string()
    .max(128)
    .regex(
      /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/,
      "Assets dir must be a relative folder path (e.g. 'public' or 'dist/public')",
    )
    .refine((v) => !v.split("/").includes(".."), "Assets dir must not contain '..'")
    .optional(),
  /** `.js` / `.mjs` files (relative to `dir`) added as `<script defer>`. */
  scripts: z.array(PluginAssetFileSchema).max(20).optional(),
  /** `.css` files (relative to `dir`) added as `<link rel="stylesheet">`. */
  styles: z.array(PluginAssetFileSchema).max(20).optional(),
});

/** An HTML entry file for a plugin admin screen: relative, no traversal. */
const PluginAdminEntrySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.html?$/, "Admin entry must be a relative .html file path")
  .refine((value) => !value.split("/").includes(".."), "Admin entry must not contain '..'");

const PluginAdminRouteSchema = z.object({
  /** Admin path this screen mounts at, e.g. `/admin/forms`. */
  path: z
    .string()
    .max(120)
    .regex(/^\/admin\/[a-z0-9][a-z0-9\-/]*$/, "Admin route path must look like /admin/forms")
    .refine((value) => !value.includes(".."), "Admin route path must not contain '..'"),
  /** HTML file (relative to `dir`) the admin frame loads for this path. */
  entry: PluginAdminEntrySchema,
  /** Breadcrumb / frame title; falls back to the manifest name. */
  title: z.string().min(1).max(100).optional(),
});

export type PluginAdminRoute = z.infer<typeof PluginAdminRouteSchema>;

/**
 * A self-contained admin app the plugin ships in its own package. The host
 * serves `<dir>/**` at `/ext/<pluginId>/admin/**` and, for each declared
 * route, mounts the `entry` HTML in a same-origin `<iframe>` inside the admin
 * shell — the plugin owns the whole screen and its design, talks only to its
 * own `ctx.http` routes, and reaches the host through `@justflows/admin-bridge`
 * (`postMessage`), never a shared React runtime. Requires `admin:extend`.
 */
export const PluginAdminAppSchema = z.object({
  /** Package-relative folder holding the admin build. Defaults to `admin`. */
  dir: z
    .string()
    .max(128)
    .regex(
      /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/,
      "Admin dir must be a relative folder path (e.g. 'admin' or 'dist/admin')",
    )
    .refine((v) => !v.split("/").includes(".."), "Admin dir must not contain '..'")
    .optional(),
  routes: z.array(PluginAdminRouteSchema).min(1).max(20),
});

export const PluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/,
        "Plugin ID must be dot-separated namespaced, e.g. acme.my-plugin",
      ),
    name: z.string().min(1).max(100),
    // Anchored at both ends: `.regex()` runs RegExp.test(), which honours only
    // the `^`, so a pattern stopping at the patch number leaves everything after
    // it unconstrained. Nothing joins this value into a path today — the
    // matching field on PackageManifestSchema did, which is how that became a
    // traversal — so keep the two schemas agreeing on what a version is.
    version: z
      .string()
      .max(64)
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
        "Must be semver, e.g. 1.2.3 or 1.2.3-rc.1",
      ),
    description: z.string().max(500).optional(),
    author: z.string().optional(),
    homepage: z.url().optional(),
    license: z.string().min(1, "Plugin license is required and must be GPL-compatible"),
    engines: ExtensionEnginesSchema.optional(),
    /** @deprecated Use engines.justflows in new manifests. */
    minJustflowsVersion: z.string().optional(),
    /** @deprecated Use engines.justflows in new manifests. */
    maxJustflowsVersion: z.string().optional(),
    permissions: z.array(PluginPermissionSchema).default([]),
    main: z.string().default("index.js"),
    /**
     * First-party opt-in. A handful of bundled plugin ids (`justflows.seo`, …)
     * are normally left inactive at runtime because the host renders their
     * behaviour itself. Setting this to `true` tells the host the shipped module
     * is host-cooperative — it only augments (e.g. adds feed routes and
     * autodiscovery) and never re-registers what the host already owns — so the
     * host may activate it. Ignored for third-party plugins.
     */
    hostCooperative: z.boolean().optional(),
    settingsSchema: z
      .record(
        z.string(),
        z.object({
          type: z.enum(["string", "number", "boolean", "text"]),
          label: z.string().min(1),
          description: z.string().optional(),
          default: z.unknown().optional(),
          localized: z.boolean().optional(),
        }),
      )
      .optional(),
    /**
     * Admin pages this plugin adds to the sidebar. Honoured only when the
     * manifest also declares the "admin:extend" permission.
     */
    adminMenu: z.array(AdminMenuItemSchema).max(20).optional(),
    /**
     * Admin path to open after activation when the plugin still needs a
     * first-run setup (database topology, credentials, store identity).
     */
    setupPath: z
      .string()
      .regex(/^\/admin\/[a-z0-9][a-z0-9\-/]*$/, "Setup path must be an /admin/… route")
      .optional(),
    /**
     * Plugin registry / Marketplace listing. Internal commercial flag, publisher
     * visibility, coming-soon, and free vs paid price. Runtime does not use these;
     * the registry and Admin → Marketplace do.
     */
    registry: RegistryListingSchema.optional(),
    /**
     * CMS type slugs this plugin created. The host deletes those types and
     * every entry on uninstall when `deleteContentOnUninstall` is on.
     */
    contentTypes: z
      .array(
        z
          .string()
          .regex(
            /^[a-z][a-z0-9-]{0,59}$/,
            "Content type slug must be lowercase letters, numbers, and hyphens",
          ),
      )
      .max(20)
      .optional(),
    /**
     * Client-side assets shipped inside the plugin package. On activation the
     * host serves `<dir>/**` at `/ext/<pluginId>/**` and auto-enqueues the
     * `scripts` / `styles` on every public page — no `ctx.http` route or
     * `html.head` filter needed. The static exporter downloads them like any
     * other same-origin asset. `scripts` / `styles` are paths **relative to
     * `dir`**; both must be `.js`/`.mjs` or `.css` and contain no `..`.
     */
    assets: PluginAssetsSchema.optional(),
    /**
     * A self-contained admin app the plugin ships and the host mounts in a
     * same-origin `<iframe>` for each declared route (see PluginAdminAppSchema).
     * Requires `admin:extend`.
     */
    adminApp: PluginAdminAppSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.adminMenu?.length && !manifest.permissions.includes("admin:extend")) {
      ctx.addIssue({
        code: "custom",
        path: ["adminMenu"],
        message: 'Contributing admin menu items requires the "admin:extend" permission',
      });
    }
    if (manifest.adminApp && !manifest.permissions.includes("admin:extend")) {
      ctx.addIssue({
        code: "custom",
        path: ["adminApp"],
        message: 'Shipping an admin app requires the "admin:extend" permission',
      });
    }
    if (manifest.setupPath && !manifest.permissions.includes("admin:extend")) {
      ctx.addIssue({
        code: "custom",
        path: ["setupPath"],
        message: 'Declaring setupPath requires the "admin:extend" permission',
      });
    }
    if (manifest.contentTypes?.length && !manifest.permissions.includes("content:delete")) {
      ctx.addIssue({
        code: "custom",
        path: ["contentTypes"],
        message: 'Declaring contentTypes requires the "content:delete" permission',
      });
    }
    if (!isGplCompatibleLicense(manifest.license)) {
      ctx.addIssue({
        code: "custom",
        path: ["license"],
        message: gplLicenseValidationMessage(manifest.license),
      });
    }
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ─── Plugin cache API ──────────────────────────────────────────────────────

/**
 * Namespaced access to the shared jf-cache. Every key is stored under
 * `plugin:{pluginId}:…` so plugins cannot read or wipe core / other-plugin keys.
 */
export interface PluginCacheApi {
  readonly enabled: boolean;

  /** Read-through cache with in-flight deduplication. */
  remember<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T>;

  get<T = unknown>(key: string): Promise<T | undefined>;

  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  delete(key: string): Promise<void>;

  /**
   * Invalidate keys under this plugin's namespace.
   * Pass a relative prefix (e.g. `"products:"`) or omit to clear the whole plugin tree.
   */
  invalidate(prefix?: string): Promise<void>;
}

export interface PluginCapabilitiesApi {
  /** Register a user capability for as long as this plugin is active. */
  register(definition: UserCapabilityDefinition): void;
}

/** The signed-in user behind a plugin request, when there is one. */
export interface PluginHttpSession {
  userId: string;
  siteId: string;
  role: string;
  email: string;
  /** Effective grants after role, per-user additions, and explicit denies. */
  capabilities: readonly UserCapability[];
  /** Resource constraints the host enforces for scoped operations. */
  scopes: AccessPolicy["scopes"];
}

export type PluginHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PluginHttpRequest {
  method: PluginHttpMethod;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  body: unknown;
  /**
   * Request headers, with `cookie` and `authorization` removed — a plugin route
   * has no reason to read the session cookie, and handing it over made every
   * installed plugin a credential holder. Use `session` for identity.
   */
  headers: Record<string, string>;
  /**
   * The caller's session, or null when anonymous.
   *
   * Plugin routes are public unless the handler checks this. There was no way to
   * check at all before, so every plugin endpoint was unauthenticated by
   * construction, whatever its author intended.
   */
  session: PluginHttpSession | null;
}

export interface PluginHttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer | Record<string, unknown> | unknown[];
  type?: string;
  /**
   * Ask the host to run site-wide cache revalidation once this response is
   * sent. Set it on a non-GET route that changed something public pages
   * reflect — a setting the plugin injects via `html.head`, a block's stored
   * config — so page caches drop and, when static-export auto-rebuild is on,
   * the export regenerates. Ignored on GET and on a 4xx/5xx status.
   */
  revalidate?: boolean;
  /**
   * Let a statically-exported page (served from a different origin) read this
   * response cross-origin. The host adds `Access-Control-Allow-Origin` for
   * vouched-for origins only — `APP_URL`, `STATIC_EXPORT_BASE_URL`, anything in
   * `STATIC_EXPORT_ALLOWED_ORIGINS`, plus any `localhost` port outside
   * production — the same allow-list the Forms and Analytics endpoints use.
   * Set it on a public read the runtime `fetch()`es (a config or disclosure
   * route); a plain `<img>`/beacon GET needs nothing.
   */
  cors?: boolean;
}

export type PluginHttpHandler = (
  req: PluginHttpRequest,
) => PluginHttpResponse | Promise<PluginHttpResponse>;

export interface PluginHttpApi {
  get(path: string, handler: PluginHttpHandler): void;
  post(path: string, handler: PluginHttpHandler): void;
  put(path: string, handler: PluginHttpHandler): void;
  patch(path: string, handler: PluginHttpHandler): void;
  delete(path: string, handler: PluginHttpHandler): void;
}

export interface PluginJobContext {
  jobId: string;
  name: string;
  attempt: number;
  scheduledAt: Date;
  payload?: unknown;
}

export interface PluginJobResult {
  success: boolean;
  message?: string;
}

export interface PluginJobDefinition {
  name: string;
  schedule?: string;
  maxAttempts?: number;
  handler(ctx: PluginJobContext): Promise<PluginJobResult>;
}

export interface PluginJobsApi {
  register(def: PluginJobDefinition): void;
  enqueue(name: string, options?: { delayMs?: number; payload?: unknown }): void;
}

export interface PluginMailTransportMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  envelopeSender?: string;
}
export interface PluginMailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}
export type PluginMailResult = { ok: true; messageId?: string } | { ok: false; error: string };
export interface PluginMailTransportApi {
  /** Send through the host's configured transport. Requires `mail:send`. */
  send(message: PluginMailMessage): Promise<PluginMailResult>;
  register(transport: {
    id: string;
    label: string;
    send(message: PluginMailTransportMessage): Promise<{
      response: string;
      messageId?: string;
      status?: "sent" | "deferred" | "failed" | "bounced";
    }>;
  }): void;
  /** Register a namespaced system-email type. Requires `mail:templates`. */
  registerTemplate(template: PluginEmailTemplateDefinition): void;
}

export interface PluginEmailVariableDefinition {
  key: string;
  label: string;
  description: string;
  kind: "text" | "url";
  example: string;
  required?: boolean;
}

export interface PluginEmailTemplateDefinition {
  /** Must begin with the registering plugin's manifest id followed by a dot. */
  key: string;
  label: string;
  description: string;
  purpose: "account" | "security" | "administrative";
  recipient: "user" | "administrator";
  disableSafe?: boolean;
  variables: PluginEmailVariableDefinition[];
  defaults: { subject: string; preheader: string; html: string; text: string };
  /** Optional built-in catalogs keyed by an active Justflows locale code. */
  localizedDefaults?: Record<
    string,
    { subject: string; preheader: string; html: string; text: string }
  >;
}

export interface PluginDataRecord<T = unknown> {
  id: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface PluginDataApi {
  list<T = unknown>(collection: string): Promise<PluginDataRecord<T>[]>;
  get<T = unknown>(collection: string, id: string): Promise<PluginDataRecord<T> | undefined>;
  put<T = unknown>(collection: string, id: string, data: T): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  /**
   * Compare-and-set. Returns false when `expectedUpdatedAt` does not match the
   * stored row — callers retry rather than overwriting a concurrent write.
   */
  cas<T = unknown>(
    collection: string,
    id: string,
    expectedUpdatedAt: string,
    data: T,
  ): Promise<boolean>;
  /** Run several data operations in one SQL transaction when the host supports it. */
  transaction<T>(fn: (tx: PluginDataApi) => Promise<T>): Promise<T>;
  /** Delete every document this plugin stored. */
  clear(): Promise<void>;
}

export interface PluginBlockDefinition {
  type: string;
  version: number;
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  schema: Record<
    string,
    { type: string; required?: boolean; default?: unknown; options?: string[] }
  >;
  supportsChildren?: boolean;
  allowedChildTypes?: string[];
  render(props: Record<string, unknown>, children?: string): string;
  validateProps(raw: unknown): Record<string, unknown>;
}

export interface PluginBlocksApi {
  register(definition: PluginBlockDefinition): void;
}

/** Pattern contribution scoped to the registering plugin. */
export type PluginPatternDefinition = Omit<
  BlockPattern,
  "schemaVersion" | "version" | "category" | "requiresBlockTypes"
> & {
  schemaVersion?: 1;
  version?: string;
  category?: string;
  requiresBlockTypes?: string[];
};

export interface PluginPatternsApi {
  /** Register an editable pattern. Validated immediately and removed on deactivate. */
  register(pattern: PluginPatternDefinition): Unsubscribe;
}

/** Idempotent content-type and page helpers. Require `content:create` (and `content:publish` to publish). */
export type PluginContentField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "richtext" | "number" | "boolean" | "media" | "date" | "select";
  required?: boolean;
  options?: string[];
};

export type PluginContentEnsureResult = {
  created: boolean;
  id: string;
  slug: string;
};

export type PluginContentDeleteTypeResult = {
  pages: number;
  typeDeleted: boolean;
};

/** One published content entry as returned by {@link PluginContentApi.listPublished}. */
export interface PluginPublishedEntry {
  id: string;
  type: string;
  title: string;
  slug: string;
  locale: string;
  excerpt: string | null;
  fields: Record<string, unknown>;
  authorId: string | null;
  /** `users.display_name` (or username), resolved by the host; null when unattributed. */
  authorName: string | null;
  /** ISO 8601, or null when never explicitly dated. */
  publishedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface PluginListPublishedQuery {
  /** Content-type slugs. Omit for every type. */
  types?: string[];
  /** Restrict to one locale. Omit for every active locale. */
  locale?: string;
  authorId?: string;
  /** `users.username`; resolved to an id by the host. */
  authorUsername?: string;
  /** Newest first. Default 20, hard cap 200. */
  limit?: number;
  /** Include entries whose `publishedAt` is in the future. Default false. */
  includeScheduled?: boolean;
}

export interface PluginContentApi {
  /**
   * List published content, newest first. Requires the `content:read` permission.
   * Scheduled (future `publishedAt`) and expired entries are excluded unless
   * `includeScheduled` is set.
   */
  listPublished(query?: PluginListPublishedQuery): Promise<PluginPublishedEntry[]>;

  /** Create a content type if this site does not already have that slug. */
  ensureType(input: {
    slug: string;
    label: string;
    description?: string;
    fields?: PluginContentField[];
  }): Promise<PluginContentEnsureResult>;

  /** Create a content entry if this site does not already have that type+slug+locale.
   * When the row already exists, title and excerpt are updated. `aliases` are
   * previous slugs to rename. Pass `create: false` to only repair, never insert.
   */
  ensurePage(input: {
    type: string;
    title: string;
    slug: string;
    excerpt?: string;
    status?: "draft" | "published";
    aliases?: string[];
    create?: boolean;
  }): Promise<PluginContentEnsureResult>;

  /**
   * Delete every content row of this type (all locales) and the type itself.
   * Built-in slugs `post` and `page` cannot be deleted.
   */
  deleteType(slug: string): Promise<PluginContentDeleteTypeResult>;
}

export type PluginDatabaseDriver = "postgres" | "mysql" | "mariadb";

export interface PluginDatabaseTarget {
  driver: PluginDatabaseDriver;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  rejectUnauthorized?: boolean;
}

export interface PluginDatabaseProbeResult {
  ok: boolean;
  error?: string;
  dialect?: PluginDatabaseDriver;
  serverVersion?: string;
  tls: boolean;
  latencyMs: number;
}

export type PluginColumnType =
  "uuid" | "text" | "int" | "bigint" | "boolean" | "timestamptz" | "json" | "varchar";

export interface PluginSchemaColumn {
  name: string;
  type: PluginColumnType;
  /** Required when `type` is `varchar`. */
  length?: number;
  primary?: boolean;
  notNull?: boolean;
  unique?: boolean;
}

export interface PluginSchemaIndex {
  name: string;
  columns: string[];
  unique?: boolean;
}

/** Unprefixed table. The host creates `{pluginSlug}_{name}` (e.g. `shop_products`). */
export interface PluginSchemaTable {
  name: string;
  columns: PluginSchemaColumn[];
  indexes?: PluginSchemaIndex[];
}

export interface PluginSchemaApplyResult {
  ok: boolean;
  tables: string[];
  error?: string;
}

export interface PluginDatabasesApi {
  /** Probe the site's existing Justflows database. */
  probeShared(): Promise<PluginDatabaseProbeResult>;
  /**
   * Open a short-lived connection to a database the plugin does not yet own.
   * Remote hosts require the `network:outbound` permission.
   */
  probe(target: PluginDatabaseTarget): Promise<PluginDatabaseProbeResult>;
  /**
   * Create the plugin's tables if they are missing. Names are prefixed with the
   * plugin slug so a plugin cannot create `users` or other core tables.
   * Omit `target` to use the current Justflows database.
   */
  ensureSchema(
    tables: PluginSchemaTable[],
    options?: { target?: PluginDatabaseTarget; rebuild?: string[] },
  ): Promise<PluginSchemaApplyResult>;
  /**
   * Drop this plugin's prefixed tables. Pass the same `tables` / `target` used
   * with `ensureSchema`. Omit `tables` to drop every table owned by the prefix.
   * Call this from `deleteData()`.
   */
  dropSchema(
    tables?: PluginSchemaTable[],
    options?: { target?: PluginDatabaseTarget },
  ): Promise<PluginSchemaApplyResult>;

  /**
   * Insert or replace a row in a plugin-owned table (`stores` → `shop_stores`).
   * The host always sets `site_id`. `match` selects the existing row (default `id`).
   */
  upsert(
    table: string,
    row: Record<string, string | number | boolean | null>,
    options?: { match?: string[] },
  ): Promise<void>;

  /** First matching row in a plugin-owned table, always scoped to this site. */
  findOne(
    table: string,
    where?: Record<string, string | number | boolean | null>,
  ): Promise<Record<string, unknown> | undefined>;

  /**
   * Matching rows in a plugin-owned table, always scoped to this site.
   * `limit` defaults to 100 and is capped at 500.
   */
  find(
    table: string,
    where?: Record<string, string | number | boolean | null>,
    options?: { limit?: number },
  ): Promise<Record<string, unknown>[]>;

  /**
   * Delete matching rows in a plugin-owned table. `where` must include at
   * least one column besides the implicit site scope.
   */
  delete(table: string, where: Record<string, string | number | boolean | null>): Promise<void>;

  /** Column names for a plugin-owned table, or `[]` when the table does not exist. */
  columns(table: string): Promise<string[]>;
}

export interface PluginSecretsApi {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export type PluginDiagnosticStatus = "ok" | "warning" | "error";
export interface PluginDiagnosticResult {
  status: PluginDiagnosticStatus;
  summary: string;
  details?: Record<string, string | number | boolean | null>;
}
export interface PluginDiagnosticCheck {
  id: string;
  label: string;
  run(): PluginDiagnosticResult | Promise<PluginDiagnosticResult>;
}
export interface PluginDiagnosticsApi {
  /** Publish a sanitized, read-only health check. Requires `diagnostics:publish`. */ register(
    check: PluginDiagnosticCheck,
  ): Unsubscribe;
}

// ─── Plugin API surface ────────────────────────────────────────────────────

/**
 * The context object injected into every plugin's activate() function.
 * Extensions import this type from @justflows/sdk — never from @justflows/core.
 */
export interface PluginContext {
  readonly pluginId: string;
  /** Version of the activated plugin. */
  readonly version: string;
  /** Host and SDK versions for runtime feature detection and diagnostics. */
  readonly runtime: JustflowsRuntimeVersions;
  readonly permissions: ReadonlySet<PluginPermission>;
  readonly capabilities: PluginCapabilitiesApi;
  readonly diagnostics: PluginDiagnosticsApi;

  /**
   * Shared jf-cache, scoped to this plugin. Always available; when caching is
   * disabled globally, reads miss and writes are no-ops (same as core).
   */
  cache: PluginCacheApi;

  /**
   * Typed hook registration. Hook names autocomplete, payloads infer, and a
   * wrong handler signature fails at compile time. Every registration is owned
   * by this plugin and removed automatically on deactivation.
   */
  hooks: {
    /** Observe an event. Failures are isolated and attributed to this plugin. */
    action<K extends ActionName>(
      hook: K,
      handler: ActionHandlerFor<K>,
      options?: HookRegisterOptions,
    ): Unsubscribe;

    /**
     * Validate a pending operation. Call `event.cancel(reason)` to block it.
     * Gates fail closed — throwing also aborts the operation.
     */
    gate<K extends GateName>(
      hook: K,
      handler: GateHandlerFor<K>,
      options?: HookRegisterOptions,
    ): Unsubscribe;

    /** Transform a value. Handlers must return the next value. */
    filter<K extends FilterName>(
      hook: K,
      handler: FilterHandlerFor<K>,
      options?: HookRegisterOptions,
    ): Unsubscribe;

    /** Emit a hook owned by this plugin. Names outside its namespace are rejected. */
    emit<K extends ActionName>(hook: K, event: ActionPayload<K>): Promise<void>;

    /** Apply a filter owned by this plugin. Names outside its namespace are rejected. */
    apply<K extends FilterName>(
      hook: K,
      value: FilterValue<K>,
      context: FilterContext<K>,
    ): Promise<FilterValue<K>>;

    /**
     * Run a gate owned by this plugin. Throws when a listener cancels.
     * Names outside its namespace are rejected.
     */
    check<K extends GateName>(hook: K, event: GatePayload<K>): Promise<void>;

    /** True when anything is listening — use to skip expensive payload work. */
    has(hook: string): boolean;
  };

  /**
   * Plugin key-value rows in `plugin_data` (not `site_settings`). Use dedicated
   * plugin tables for domain records such as a store or catalog.
   */
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /** Plugin-owned public HTTP routes. Paths starting with `/` claim a site-root path. */
  http: PluginHttpApi;

  /**
   * Durable-enough background work. Requires `jobs:register`. Registrations
   * are removed on deactivate.
   */
  jobs: PluginJobsApi;

  /** Send mail or register outbound providers and namespaced email types. */
  mail: PluginMailTransportApi;

  /** Plugin-scoped JSON documents. No raw SQL. */
  data: PluginDataApi;

  /**
   * Encrypted credentials. Values are never returned by public APIs; `has()`
   * is the safe way to tell the admin UI a secret is already stored.
   */
  secrets: PluginSecretsApi;

  /** Short-lived database probes for plugin-owned storage topology. */
  databases: PluginDatabasesApi;

  /**
   * The site cookie registry. `declare()` every non-essential cookie this plugin
   * sets so the consent banner can disclose it and expire it on withdrawal;
   * `list()` returns the whole registry (host + all plugins) with operator
   * overrides applied. Declarations are removed on deactivate.
   */
  cookies: PluginCookiesApi;

  /** Register block types for the editor and public renderer. Removed on deactivate. */
  blocks: PluginBlocksApi;

  /** Register sanitized block patterns for the editor. Removed on deactivate. */
  patterns: PluginPatternsApi;

  /**
   * Create content types and pages the plugin needs. Requires `content:create`.
   * Publishing a page also requires `content:publish`. `deleteType` requires
   * `content:delete`. Existing slugs are left alone on create (idempotent).
   * `listPublished` requires `content:read`.
   */
  content: PluginContentApi;

  /** The site's configured locales. Read-only; no permission required. */
  i18n: {
    /** The site's default locale code (BCP-47), e.g. `en-US`. */
    defaultLocale(): Promise<string>;
    /** Every active locale code, default first. */
    locales(): Promise<string[]>;
  };

  logger: {
    debug(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  };
}

/**
 * Setting key for a keep/delete choice on uninstall. When absent, `deleteData`
 * should run its cleanup (silent). When present, honour the stored boolean.
 */
export const PLUGIN_DELETE_DATA_SETTING = "deleteDataOnUninstall";

/** Setting key for deleting CMS types and entries the plugin created on uninstall. */
export const PLUGIN_DELETE_CONTENT_SETTING = "deleteContentOnUninstall";

async function honourBooleanSetting(
  ctx: Pick<PluginContext, "settings">,
  key: string,
  silentDefault: boolean,
): Promise<boolean> {
  const stored = await ctx.settings.get(key);
  if (stored === undefined || stored === null) return silentDefault;
  if (stored === false || stored === "false" || stored === 0 || stored === "0") return false;
  if (stored === true || stored === "true" || stored === 1 || stored === "1") return true;
  return Boolean(stored);
}

export async function pluginShouldDeleteData(
  ctx: Pick<PluginContext, "settings">,
  silentDefault = true,
): Promise<boolean> {
  return honourBooleanSetting(ctx, PLUGIN_DELETE_DATA_SETTING, silentDefault);
}

export async function pluginShouldDeleteContent(
  ctx: Pick<PluginContext, "settings">,
  silentDefault = true,
): Promise<boolean> {
  return honourBooleanSetting(ctx, PLUGIN_DELETE_CONTENT_SETTING, silentDefault);
}

/**
 * A Justflows plugin module must export an object matching this interface.
 */
export interface PluginModule {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(ctx: PluginContext): void | Promise<void>;
  /**
   * Called when the plugin is deleted, before deactivation. Drop tables and
   * stored rows here (`ctx.databases.dropSchema`, `ctx.data.clear`). Delete
   * CMS types the plugin created with `ctx.content.deleteType`. Run silently,
   * or honour `PLUGIN_DELETE_DATA_SETTING` / `PLUGIN_DELETE_CONTENT_SETTING`
   * if the plugin exposes those checkboxes in `settingsSchema`.
   */
  deleteData(ctx: PluginContext): void | Promise<void>;
}
