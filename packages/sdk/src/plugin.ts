import { isValidPluginApiNamespace } from "./api-urls.js";
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
  "platform:tenancy",
  "platform:network",
  "files:private",
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
  "platform:tenancy",
  "platform:network",
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
  "helpdesk",
  "files",
  "plugin",
  "extensions",
  "tools",
  "security",
  "system",
] as const;

export type AdminMenuDomain = (typeof ADMIN_MENU_DOMAINS)[number];

/**
 * The admin URL namespace the host reserves for one plugin's own pages:
 * `/admin/plugins/<pluginId>`. Every plugin admin screen lives here, so a URL
 * always says whether it is core or plugin-owned.
 */
export function pluginAdminBasePath(pluginId: string): string {
  return `/admin/plugins/${pluginId}`;
}

const SLASH = "/".charCodeAt(0);

/**
 * Strip leading and trailing `/` with plain index scans. `/^\/+|\/+$/` looks
 * harmless but is quadratic on a long run of `/` that isn't anchored at the
 * true end of the string (e.g. `"a" + "/".repeat(n) + "a"`): the engine
 * retries the `\/+$` branch, and its backtrack, from every offset inside the
 * run. `relativePath` below comes from plugin code, so treat it as
 * untrusted input rather than relying on the regex engine to stay linear.
 */
function stripSlashes(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && input.charCodeAt(start) === SLASH) start++;
  while (end > start && input.charCodeAt(end - 1) === SLASH) end--;
  return input.slice(start, end);
}

/**
 * Compose a plugin-relative admin path (`""`, `"orders"`, `"orders/refunds"`)
 * into its absolute URL under the plugin's namespace. `""` / nullish is the
 * namespace root.
 */
export function resolvePluginAdminPath(pluginId: string, relativePath?: string | null): string {
  const base = pluginAdminBasePath(pluginId);
  const rel = stripSlashes(String(relativePath ?? ""));
  return rel ? `${base}/${rel}` : base;
}

/**
 * A plugin-relative admin path: the empty string (the plugin's namespace root)
 * or a lowercase `leaf` / `leaf/child` under it. It must **not** start with
 * `/`, name `admin`, contain a `.` (so it can never be an absolute `/admin/…`
 * route or repeat the dot-namespaced plugin id) — the host prepends
 * `/admin/plugins/<pluginId>/`.
 */
export const RELATIVE_ADMIN_PATH_RE = /^(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?$/;

const RelativeAdminPathSchema = z
  .string()
  .max(100)
  .regex(
    RELATIVE_ADMIN_PATH_RE,
    'Admin path is relative to /admin/plugins/<your plugin id>: use "" for the plugin\'s root page or a lowercase leaf like "orders" or "orders/refunds" — never a leading "/", "admin", the plugin id, or a ".".',
  );

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
  /**
   * Optional i18n key. The host looks it up in the plugin's own
   * `adminApp.locales` catalogs first, then in core's admin catalogs.
   */
  labelKey: z.string().max(120).optional(),
  /**
   * Per-locale labels, keyed by locale code (for example `{ "nl": "Formulieren" }`).
   * They win over `labelKey`, so a plugin without an admin app can still
   * translate its menu entry.
   */
  labels: z
    .record(
      z.string().regex(/^[a-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/, "Locale code must look like en or nl-NL"),
      z.string().min(1).max(60),
    )
    .refine((value) => Object.keys(value).length <= 20, "At most 20 menu label locales")
    .optional(),
  /**
   * Where this page mounts, **relative to the plugin's own namespace**
   * `/admin/plugins/<your plugin id>`. Omit (or `""`) for the namespace root;
   * otherwise a lowercase leaf such as `"orders"` or `"orders/refunds"`. The
   * host prepends `/admin/plugins/<id>/` — never write that prefix or the id.
   */
  path: RelativeAdminPathSchema.optional(),
  icon: z.string().min(1).max(8).default("🔌"),
  domain: z.enum(ADMIN_MENU_DOMAINS).default("extensions"),
  /** Match the path exactly instead of as a prefix. */
  end: z.boolean().optional(),
  /**
   * When false, the page stays reachable but is left out of the admin nav.
   * Use it for a screen opened by a button on another plugin page.
   */
  listed: z.boolean().optional(),
  /**
   * Roles that may open this page, such as a role this plugin registers.
   * Omit for the default plugin-page rule (administrators and editors).
   */
  roles: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Role ids are lowercase kebab-case"))
    .min(1)
    .max(10)
    .optional(),
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

const PANEL_LOCALE_RE = /^[a-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/**
 * Text shown in the admin: one string, or `{ "<locale>": "<text>" }`. The editor
 * uses the admin language, then its base language, then `en`, then any entry.
 */
export const LocalizedTextSchema = z.union([
  z.string().min(1).max(500),
  z
    .record(z.string().regex(PANEL_LOCALE_RE, "Locale code must look like en or nl-NL"), z.string().min(1).max(500))
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 20, "1 to 20 locales"),
]);

export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

/**
 * One field of a content editor panel. The value is saved in the entry's
 * `fields` under `key`. In `placeholder`, `{title}`, `{excerpt}`, and `{url}`
 * become the entry's title, excerpt, and public address.
 */
export const EditorPanelFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "Field key must be letters, digits, or _"),
  type: z.enum(["text", "textarea", "url", "image", "checkbox"]),
  label: LocalizedTextSchema,
  hint: LocalizedTextSchema.optional(),
  placeholder: LocalizedTextSchema.optional(),
});

/**
 * A section a plugin adds to the content editor, next to Content, Discussion,
 * and Advanced. Shown while the plugin is active, for every content type.
 */
export const EditorPanelSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Panel id must be lowercase kebab-case"),
    title: LocalizedTextSchema,
    /** Show only for entries whose type is included in search engines. */
    indexableOnly: z.boolean().optional(),
    fields: z.array(EditorPanelFieldSchema).max(20).optional(),
    /**
     * Relative admin-app path embedded in this section. The host passes the
     * content id being edited. A panel has fields or this path.
     */
    app: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(40)
      .optional(),
  })
  .superRefine((panel, ctx) => {
    const hasFields = Array.isArray(panel.fields) && panel.fields.length > 0;
    const hasApp = typeof panel.app === "string" && panel.app.length > 0;
    if (hasFields === hasApp) {
      ctx.addIssue({
        code: "custom",
        message: "An editor panel declares fields or an app route.",
      });
    }
  });

export type PluginEditorPanel = z.infer<typeof EditorPanelSchema>;

/**
 * The plugin's own sidebar section. Menu items with `domain: "plugin"` are
 * listed there instead of in a shared section.
 */
export const AdminSectionSchema = z.object({
  /** English label, shown when `labelKey` and `labels` have no translation. */
  label: z.string().min(1).max(60),
  /** Key in the plugin's own `adminApp.locales` catalogs. */
  labelKey: z.string().max(120).optional(),
  labels: z
    .record(z.string().regex(PANEL_LOCALE_RE, "Locale code must look like en or nl-NL"), z.string().min(1).max(60))
    .refine((value) => Object.keys(value).length <= 20, "At most 20 section label locales")
    .optional(),
  /** An emoji, or an image file in the plugin's admin app folder such as `logo.png`. */
  icon: z
    .string()
    .min(1)
    .max(120)
    .refine(
      (value) => value.length <= 8 || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,110}\.(png|svg|webp)$/.test(value),
      "Icon must be an emoji or a .png, .svg, or .webp file in the admin app folder",
    )
    .optional(),
});

export type PluginAdminSection = z.infer<typeof AdminSectionSchema>;

/**
 * A card a plugin adds to Platform → Workspace. The host embeds the relative
 * admin-app path and passes the workspace id being viewed.
 */
export const WorkspacePanelSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Panel id must be lowercase kebab-case"),
  title: LocalizedTextSchema,
  app: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(40),
});

export type PluginWorkspacePanel = z.infer<typeof WorkspacePanelSchema>;

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

/**
 * Page templates a plugin ships in its package: `<dir>/<slug>.json` block
 * documents (same shape as a theme's `templates/*.json`). While the plugin is
 * active the host resolves them after the site override and the active theme's
 * own file for that slug, so templates for plugin-owned content types (e.g.
 * `single-product`) live with the plugin, and a theme can still override them.
 */
export const PluginTemplatesSchema = z.object({
  /** Package-relative folder holding the templates. Defaults to `templates`. */
  dir: z
    .string()
    .max(128)
    .regex(
      /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/,
      "Templates dir must be a relative folder path (e.g. 'templates')",
    )
    .refine((v) => !v.split("/").includes(".."), "Templates dir must not contain '..'")
    .optional(),
});

/** An HTML entry file for a plugin admin screen: relative, no traversal. */
const PluginAdminEntrySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.html?$/, "Admin entry must be a relative .html file path")
  .refine((value) => !value.split("/").includes(".."), "Admin entry must not contain '..'");

const PluginAdminRouteSchema = z.object({
  /**
   * Where this screen mounts, relative to the plugin's namespace
   * `/admin/plugins/<your plugin id>` — `""` (omit) for the root, or a leaf
   * like `"submissions"`. Same rules as `AdminMenuItemSchema.path`.
   */
  path: RelativeAdminPathSchema.optional(),
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
  /**
   * One per admin screen. Bounded because manifests come from third-party
   * packages; 40 leaves room for a large plugin such as Shop.
   */
  routes: z.array(PluginAdminRouteSchema).min(1).max(40),
  /**
   * Admin UI catalogs, keyed by locale code. Each value is a `.json` file
   * relative to `dir` (for example `locales/nl.json`). The host serves it at
   * `/ext/<pluginId>/admin/<path>` and passes those URLs to the frame as
   * `context.catalogs`.
   */
  locales: z
    .record(
      z
        .string()
        .regex(/^[a-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/, "Locale code must look like en or nl-NL"),
      z
        .string()
        .min(1)
        .max(160)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.json$/, "Locale file must be a relative .json path")
        .refine((value) => !value.split("/").includes(".."), "Locale file must not contain '..'"),
    )
    .refine((value) => Object.keys(value).length <= 20, "At most 20 locale files")
    .optional(),
}).superRefine((app, ctx) => {
  if (!app.locales?.["en"]) {
    ctx.addIssue({
      code: "custom",
      path: ["locales", "en"],
      message: "An admin app must declare an English catalog at locales.en (for example locales/en.json). It is the fallback for every other locale.",
    });
  }
});

/**
 * Every extension id is `justflows.<name>` — first-party only (`justflows.seo`,
 * `justflows.theme.dark`). The `justflows.` namespace is what the admin URL
 * (`/admin/plugins/justflows.<name>`) and the asset mount
 * (`/ext/justflows.<name>/…`) are built from.
 */
export const PLUGIN_ID_RE = /^justflows(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

export const PluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(PLUGIN_ID_RE, "Plugin ID must be justflows.<name> (lowercase, e.g. justflows.seo)"),
    apiNamespace: z.string().refine(isValidPluginApiNamespace, "Invalid or reserved plugin API namespace").optional(),
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
     * When true, the main site may offer this plugin to other sites. Those
     * sites can activate it and change only their own rows. They cannot
     * install the package or drop its tables. Omit or false to keep the
     * plugin on the main site.
     */
    allowMultisite: z.boolean().optional(),
    /**
     * Other plugins that must already be installed on this site. Install is
     * refused while any of them is missing. Activation is refused until each
     * one is active.
     */
    requires: z
      .array(z.string().regex(PLUGIN_ID_RE, "Required plugin id must be justflows.<name>"))
      .max(10)
      .optional(),
    settingsSchema: z
      .record(
        z.string(),
        z.object({
          type: z.enum(["string", "number", "boolean", "text", "select"]),
          label: z.string().min(1),
          description: z.string().optional(),
          default: z.unknown().optional(),
          localized: z.boolean().optional(),
          /** For `select`: fixed choices, shown before any from `optionsSource`. */
          options: z
            .array(z.object({ value: z.string().max(200), label: z.string().min(1).max(200) }))
            .max(200)
            .optional(),
          /**
           * For `select`: choices the host fills in, from the same lists core uses.
           * `timezones`: every IANA time zone, as Settings → General.
           * `countries`: every ISO 3166-1 country, stored as its two-letter code.
           */
          optionsSource: z.enum(["timezones", "countries"]).optional(),
        }),
      )
      .optional(),
    /**
     * Admin pages this plugin adds to the sidebar. Honoured only when the
     * manifest also declares the "admin:extend" permission.
     */
    adminMenu: z.array(AdminMenuItemSchema).max(20).optional(),
    /** Content editor sections this plugin adds. Honoured with `admin:extend`. */
    editorPanels: z.array(EditorPanelSchema).max(5).optional(),
    /** Sidebar section for menu items with `domain: "plugin"`. Honoured with `admin:extend`. */
    adminSection: AdminSectionSchema.optional(),
    /** Platform → Workspace cards this plugin adds. Honoured with `admin:extend`. */
    workspacePanels: z.array(WorkspacePanelSchema).max(5).optional(),
    /**
     * Page to open after activation when the plugin still needs a first-run
     * setup (database topology, credentials, store identity). Relative to the
     * plugin's namespace like `adminMenu` paths: `""` is the namespace root.
     * Omit entirely for "no setup wizard".
     */
    setupPath: RelativeAdminPathSchema.optional(),
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
    /** Page templates shipped inside the plugin package (see PluginTemplatesSchema). */
    templates: PluginTemplatesSchema.optional(),
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
    if (manifest.requires?.includes(manifest.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["requires"],
        message: "A plugin cannot require itself",
      });
    }
    if (!isGplCompatibleLicense(manifest.license)) {
      ctx.addIssue({
        code: "custom",
        path: ["license"],
        message: gplLicenseValidationMessage(manifest.license),
      });
    }
  })
  // Author-facing admin paths are relative to the plugin's namespace; the host
  // and everything downstream work in absolute `/admin/plugins/<id>/…` URLs.
  // Resolve them here, once, so a parsed manifest always carries the real path.
  // Keys are only rewritten when present, so `adminMenu` / `adminApp` /
  // `setupPath` stay optional on the inferred type.
  .transform((manifest) => {
    const out: typeof manifest = { ...manifest };
    if (manifest.adminMenu) {
      out.adminMenu = manifest.adminMenu.map((item) => ({
        ...item,
        path: resolvePluginAdminPath(manifest.id, item.path),
      }));
    }
    if (manifest.adminApp) {
      out.adminApp = {
        ...manifest.adminApp,
        routes: manifest.adminApp.routes.map((route) => ({
          ...route,
          path: resolvePluginAdminPath(manifest.id, route.path),
        })),
      };
    }
    if (manifest.setupPath !== undefined) {
      out.setupPath = resolvePluginAdminPath(manifest.id, manifest.setupPath);
    }
    return out;
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** One field of a plugin's `settingsSchema`. */
export type PluginSettingsField = NonNullable<PluginManifest["settingsSchema"]>[string];

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

/**
 * A user role this plugin contributes while it is active. The id is stored on
 * `users.role` (for example Shop's `customer`). It must not replace a core role.
 */
export interface PluginRoleDefinition {
  /** Lowercase id, 2–32 characters: letters, digits, and hyphens. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Capabilities granted to this role. Empty means no administration access. */
  readonly capabilities?: readonly UserCapability[];
}

export interface PluginRolesApi {
  /** Register a user role for as long as this plugin is active. */
  register(definition: PluginRoleDefinition): void;
}

/**
 * Signed-in staff member a plugin attributes a user mutation to. For an account
 * a visitor creates for themselves (for example at a shop checkout), pass an
 * empty `userId`; the audit log then records the change without an actor.
 */
export interface PluginUserActor {
  userId: string;
  role: string;
}

export interface PluginUserCreateInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
  /** Must be a role this plugin registered. Core roles are rejected. */
  role: string;
}

export interface PluginCreatedUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: string;
}

export type PluginUserCreateResult =
  | { ok: true; user: PluginCreatedUser }
  | { ok: false; status: number; error: string };

/** Which existing user `ctx.users.addRole()` targets: by id or by sign-in email. */
export type PluginUserTarget = { userId: string } | { email: string };

export interface PluginRoleUser extends PluginCreatedUser {
  /** Primary role first, then additional roles. */
  roles: readonly string[];
}

export type PluginUserRoleResult =
  | { ok: true; user: PluginRoleUser }
  | { ok: false; status: number; error: string };

export interface PluginUsersApi {
  /**
   * Create a site user in a role this plugin registered.
   * Requires the `users:manage` manifest permission. The host still applies
   * password policy, uniqueness, and audit logging.
   */
  create(input: PluginUserCreateInput, actor: PluginUserActor): Promise<PluginUserCreateResult>;
  /**
   * Give an existing user a role this plugin registered, as an additional
   * role next to the one they have. Their primary role, sign-in, and every
   * other role stay as they are; the new role's capabilities are added.
   * Doing nothing when the user already holds the role is a success.
   * Requires the `users:manage` manifest permission.
   * Optional: older hosts do not provide it.
   */
  addRole?(target: PluginUserTarget, role: string, actor: PluginUserActor): Promise<PluginUserRoleResult>;
  /**
   * Read one site user with all their roles, or null when there is none.
   * Requires the `users:manage` manifest permission. Use it from a
   * `user.created` / `user.updated` action to react to role changes.
   * Optional: older hosts do not provide it.
   */
  get?(userId: string): Promise<PluginRoleUser | null>;
  /**
   * Take back an additional role this plugin registered, such as a membership
   * that ended. The user's primary role is never changed. Doing nothing when
   * the user does not hold the role is a success.
   * Requires the `users:manage` manifest permission.
   * Optional: older hosts do not provide it.
   */
  removeRole?(target: PluginUserTarget, role: string, actor: PluginUserActor): Promise<PluginUserRoleResult>;
}

/** The signed-in user behind a plugin request, when there is one. */
export interface PluginHttpSession {
  userId: string;
  siteId: string;
  role: string;
  /**
   * Primary role first, then any additional roles. Absent on older hosts;
   * fall back to `[role]`.
   */
  roles?: readonly string[];
  email: string;
  /**
   * The name shown for this account (`users.display_name`, or the username).
   * Absent on older hosts and when the user record has no name.
   */
  displayName?: string;
  /** Effective grants after role, per-user additions, and explicit denies. */
  capabilities: readonly UserCapability[];
  /** Resource constraints the host enforces for scoped operations. */
  scopes: AccessPolicy["scopes"];
}

/** The Discussion CAPTCHA, without the secret. Null when no provider is configured. */
export interface PluginCaptchaConfig {
  provider: "turnstile" | "hcaptcha" | "recaptcha" | "recaptcha-v3";
  siteKey: string;
  field: string;
  scriptSrc: string;
  widgetClass: string;
}

/** Verify the site's Settings → Discussion CAPTCHA. The secret never leaves the host. */
export interface PluginCaptchaApi {
  config(): Promise<PluginCaptchaConfig | null>;
  verify(token: string, action?: string, ip?: string): Promise<boolean>;
}

/** One in-process call to another active plugin's HTTP route, as the given session. */
export interface PluginCallRequest {
  method: PluginHttpMethod;
  /** Path relative to that plugin, such as `orders` or `payments/attempts/:id/refund`. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  session?: PluginHttpSession | null;
  /**
   * Run the route as this site. The caller needs `platform:tenancy`. The host
   * allows only another active site in the same workspace, and Shop (or
   * whichever plugin is called) still checks the session. Absent means the
   * current site. Older hosts ignore this field.
   */
  siteId?: string;
}

export interface PluginBridgeApi {
  call(pluginId: string, request: PluginCallRequest): Promise<PluginHttpResponse>;
}

/** One short completion from the site's configured assistant. */
export interface PluginAiResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface PluginAiApi {
  complete(input: { instruction: string; text: string }): Promise<PluginAiResult>;
}

export type PluginHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PluginHttpRequest {
  method: PluginHttpMethod;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  body: unknown;
  /**
   * Exact request bytes for signature checks. Set only for routes that opt in
   * at the host JSON parser, such as payment webhooks. Absent for every other
   * plugin route.
   */
  rawBody?: string;
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
  /**
   * True when the browser's `Origin` is this site or an origin the host
   * vouches for (the same allow-list `cors` uses). False for any other
   * `Origin`, and absent when the request carried none, as a same-origin GET
   * or a non-browser client does. Use it to ignore a beacon another site fires
   * at this one. Absent on older hosts.
   */
  trustedOrigin?: boolean;
  /**
   * The visitor's language: the locale of the site page that made the request
   * (`/nl-NL/shop` → `nl-NL`), otherwise the site default. Pass it to
   * `ctx.content.listPublished({ locale, fallback: true })` to answer in the
   * visitor's language. Absent on older hosts.
   */
  locale?: string;
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
   *
   * `"network"` does the same for every site in the installation. It needs
   * `platform:network` and a request on the main site; otherwise it acts as
   * `true`. Use it after saving something `{ network: true }` hooks inject.
   */
  revalidate?: boolean | "network";
  /**
   * Answer with one of this plugin's private files (`ctx.files`) instead of a
   * body. The host streams it from wherever the site stores private files,
   * honours `Range` requests, and never reveals the storage address. Only the
   * route's own plugin's files on the current site can be sent. A missing
   * file answers 404.
   */
  file?: {
    key: string;
    /** Download name; defaults to the key's last segment. */
    filename?: string;
    /** `attachment` (default) asks the browser to save it. */
    disposition?: "attachment" | "inline";
  };
  /**
   * Let a statically-exported page (served from a different origin) read this
   * response cross-origin. The host adds `Access-Control-Allow-Origin` for
   * vouched-for origins only — `APP_URL`, `STATIC_EXPORT_BASE_URL`, anything in
   * `STATIC_EXPORT_ALLOWED_ORIGINS`, plus any `localhost` port outside
   * production — the same allow-list the Forms endpoints use.
   * Set it on a public read the runtime `fetch()`es (a config or disclosure
   * route); a plain `<img>`/beacon GET needs nothing.
   */
  cors?: boolean;
  /**
   * Send the browser to a same-site path. The host allows only a path that
   * starts with one `/` (a query string is fine) and answers 303 when `status`
   * is not already a redirect. Absolute URLs and protocol-relative paths are
   * ignored, so a plugin cannot send a visitor off the site.
   */
  redirect?: string;
  /**
   * Render a published page of this site in the active theme, at the URL the
   * visitor asked for. The slug is one path segment (`support-ticket`). The
   * host follows `redirect` instead when that is set, refuses anything that is not a
   * published public page, and does not cache the response.
   */
  renderPage?: string;
}

export type PluginHttpHandler = (
  req: PluginHttpRequest,
) => PluginHttpResponse | Promise<PluginHttpResponse>;

/**
 * Per-IP ceiling the host enforces before the handler runs.
 * `limit` is an integer from 1 to 10_000. `windowMs` is an integer from
 * 1_000 to 3_600_000. `key` shares one counter across several routes of this
 * plugin (cart add and cart update). It is letters, digits, and hyphens, up
 * to 40 characters, and must start with a letter or digit. Without `key`,
 * the route has its own counter.
 */
export interface PluginHttpRateLimit {
  limit: number;
  windowMs: number;
  key?: string;
}

/**
 * Policy the host applies to one registered route. Defaults stay strict:
 * a non-GET route requires the session CSRF token, nothing is rate-limited,
 * and the handler does not receive the raw request bytes.
 */
export interface PluginHttpRouteOptions {
  /** Host guard failures use { error: { code, message } } for a stable JSON API. */
  structuredErrors?: true;
  /**
   * Skip the session CSRF token. Use this only when the plugin authenticates
   * the call another way, such as a signed webhook. GET never requires CSRF.
   */
  csrf?: false;
  rateLimit?: PluginHttpRateLimit;
  /**
   * Keep the exact request bytes on `req.rawBody` so the handler can verify
   * a signature. Parsed JSON is not the signed payload.
   */
  rawBody?: true;
  /**
   * Accept the request body as raw bytes instead of JSON: `req.body` is a
   * `Buffer` and `content-type` says what it is. For file uploads, up to
   * `maxBytes` (host maximum 1 GiB). CSRF and rate limits still apply.
   */
  binaryBody?: { maxBytes: number };
  /**
   * Offer this route to AI agents as an MCP tool. Off unless set: the plugin
   * chooses which of its functions agents may use. See `PluginHttpMcpTool`.
   */
  mcp?: PluginHttpMcpTool;
}

/**
 * A plugin route offered to AI agents (MCP clients and the admin assistant).
 *
 * The host lists the tool only on sites where the plugin is active, and only
 * to sessions that hold `capability`. A call runs this route's own handler
 * with the agent's session (`role: "api-key"`, its capabilities), so the
 * handler's existing checks apply unchanged. Path parameters (`:id`) become
 * required string arguments; the other arguments are the query string for
 * GET and DELETE, and the JSON body otherwise. Non-read-only calls are
 * audited. A file or binary response is not passed to the agent.
 */
export interface PluginHttpMcpTool {
  /** `snake_case`, unique, prefixed with the plugin (`shop_products_save`). */
  name: string;
  title?: string;
  /** Written for a model: what the tool does and when to use it. */
  description: string;
  /** Needed to see and call the tool. Use the capability the handler checks. */
  capability: string;
  /** JSON Schema (`type: "object"`) for the query or body arguments. */
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export interface PluginHttpApi {
  /** Neutral API URL when apiNamespace is declared; legacy URL otherwise. */
  url(path?: string): string;
  get(path: string, handler: PluginHttpHandler, options?: PluginHttpRouteOptions): void;
  post(path: string, handler: PluginHttpHandler, options?: PluginHttpRouteOptions): void;
  put(path: string, handler: PluginHttpHandler, options?: PluginHttpRouteOptions): void;
  patch(path: string, handler: PluginHttpHandler, options?: PluginHttpRouteOptions): void;
  delete(path: string, handler: PluginHttpHandler, options?: PluginHttpRouteOptions): void;
}

export interface PluginJobContext {
  jobId: string;
  name: string;
  attempt: number;
  scheduledAt: Date;
  payload?: unknown;
  /** The site this run is for. Set when the job was registered with `perSite`. */
  siteId?: string;
}

export interface PluginJobResult {
  success: boolean;
  message?: string;
}

export interface PluginJobDefinition {
  name: string;
  schedule?: string;
  maxAttempts?: number;
  /**
   * Run the handler once for every site where the plugin is active, inside
   * that site's context, so `ctx.databases`, `ctx.settings`, and `ctx.secrets`
   * act on that site. One site's failure does not stop the others.
   * Without it, the handler runs once with no site context.
   */
  perSite?: boolean;
  handler(ctx: PluginJobContext): Promise<PluginJobResult>;
}

export interface PluginJobsApi {
  register(def: PluginJobDefinition): void;
  /**
   * Run a registered job once, after `delayMs`. Each call is its own run with
   * its own `payload` (JSON, up to 1 MB). On hosts with the durable queue
   * (core 0.3.6) the run is stored first and survives a restart; the returned
   * promise resolves once it is stored and never rejects. A run whose handler
   * throws or returns `success: false` is retried until `maxAttempts`
   * (default 3), so handlers must be safe to repeat; failed runs are listed in
   * Diagnostics. A `perSite` job enqueued while handling a site's request or
   * job runs only for that site; enqueued outside one, for every site.
   * Throws when the job is not registered.
   */
  enqueue(name: string, options?: { delayMs?: number; payload?: unknown }): void | Promise<void>;
}

/**
 * A file sent with an email, for example an invoice PDF. The host accepts up
 * to 5 per message, each up to 10 MB and 15 MB together, of the types PDF,
 * PNG, JPEG, CSV, plain text, and calendar (`text/calendar`). Attachments are
 * not kept in the delivery log, so a delivery retried from the admin goes out
 * without them. Older hosts ignore the field and send the email without them.
 */
export interface PluginMailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}
export interface PluginMailTransportMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  envelopeSender?: string;
  /** Files to send with the message. Transports written before attachments existed ignore them. */
  attachments?: PluginMailAttachment[];
}
export interface PluginMailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: PluginMailAttachment[];
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

/** One editable prop of a plugin block, as the page-builder inspector shows it. */
export interface PluginBlockField {
  /**
   * `text`, `textarea`, `richtext`, `number`, `boolean`, `select`, `url`,
   * `media` (one image URL), or `images` (a list of `{ src, alt, caption }`
   * with upload and the media library). For `media` and `images` the host adds
   * a `responsive` prop when it renders the block: a map from image URL to its
   * `ResponsiveImageProp`, ready for `applyResponsiveProp` and
   * `renderResponsiveImage`.
   */
  type: string;
  required?: boolean;
  default?: unknown;
  /** Fixed choices. The field renders as a dropdown, or checkboxes with `multiple`. */
  options?: string[];
  /** Display text per option value. The raw value is shown when one is missing. */
  optionLabels?: Record<string, string>;
  /** Inspector label. Defaults to the prop key. */
  label?: string;
  /** One line of help under the field. */
  help?: string;
  /**
   * Same-origin path the editor GETs for choices instead of `options`. It must
   * answer `{ options: [{ value, label }] }`; plugins usually point it at their
   * own route, e.g. `/ext/<plugin-id>/blocks/options/products`.
   */
  optionsUrl?: string;
  /** Pick several choices. The prop is saved as a string array. */
  multiple?: boolean;
  /** Only show the field while another prop equals one of these values. */
  showWhen?: { field: string; equals: string | string[] };
}

export interface PluginBlockDefinition {
  type: string;
  version: number;
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  schema: Record<string, PluginBlockField>;
  supportsChildren?: boolean;
  allowedChildTypes?: string[];
  /**
   * Turn the builder's generic settings sections on or off for this block.
   * Unset keys keep the default: everything on except `themeVariables`.
   * `hideFields` drops single layout fields, e.g. `["textAlign"]` when the
   * block has its own alignment field.
   */
  inspector?: Partial<Record<"themeVariables" | "animation" | "spacing" | "size" | "appearance" | "colors" | "advanced", boolean>> & {
    hideFields?: Array<
      | "padTop" | "padBottom" | "padX" | "marginTop" | "marginBottom"
      | "width" | "alignSelf" | "minHeight" | "maxWidth" | "maxHeight"
      | "textAlign" | "radius" | "shadow"
      | "background" | "textColor" | "accent" | "opacity"
    >;
  };
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

/** Records removed because one user created them. */
export interface PluginDeleteCreatedByCounts {
  content: number;
  media: number;
  comments: number;
}

export type PluginDeleteCreatedByResult =
  | ({ ok: true } & PluginDeleteCreatedByCounts)
  | { ok: false; error: string };

/** One published content entry as returned by {@link PluginContentApi.listPublished}. */
export interface PluginPublishedEntry {
  id: string;
  type: string;
  title: string;
  slug: string;
  locale: string;
  /**
   * Shared id of every language version of this entry. The original's own id,
   * so a plugin table keyed by the original content id joins on this.
   * Absent on older hosts.
   */
  translationGroupId?: string;
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
  /**
   * With `locale`: return one entry per translation group, the `locale`
   * version when it exists and the default-locale original otherwise.
   */
  fallback?: boolean;
  authorId?: string;
  /** `users.username`; resolved to an id by the host. */
  authorUsername?: string;
  /** Newest first. Default 20, hard cap 200. */
  limit?: number;
  /** Include entries whose `publishedAt` is in the future. Default false. */
  includeScheduled?: boolean;
}

/** One published entry with its blocks, as returned by {@link PluginContentApi.getPublished}. */
export interface PluginPublishedPage extends PluginPublishedEntry {
  /** The entry's block tree (the `blocks` of its block document), as published. */
  blocks: unknown[];
}

export interface PluginGetPublishedQuery {
  /** Content-type slug. */
  type: string;
  /** The entry's slug, in the site's default locale. */
  slug: string;
  /**
   * Visitor locale. Returns the published translation in this locale when
   * there is one, otherwise the default-locale entry. Omit for the default.
   */
  locale?: string;
}

/** A private file as `ctx.files` describes it. */
export interface PluginPrivateFile {
  /** The plugin's own key, for example `downloads/<productId>/manual.pdf`. */
  key: string;
  size: number;
  contentType: string;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface PluginFilesApi {
  /**
   * Store or replace a file. Keys are relative paths without `..`. Throws a
   * quota error (status 409) when the site's private-file limits are reached.
   */
  put(key: string, data: Buffer, options?: { contentType?: string }): Promise<PluginPrivateFile>;
  get(key: string): Promise<PluginPrivateFile | null>;
  /** The whole file in memory. Prefer answering a route with `{ file }` for downloads. */
  read(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<boolean>;
  /** Files under a key prefix (all when omitted), up to 500. */
  list(prefix?: string): Promise<PluginPrivateFile[]>;
}

export interface PluginContentApi {
  /**
   * One published entry by type and slug, with its blocks — for example a page
   * a plugin uses as a shared layout. Null when no such entry is published.
   * Requires the `content:read` permission. Absent on older hosts.
   */
  getPublished?(query: PluginGetPublishedQuery): Promise<PluginPublishedPage | null>;

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
   * When the row already exists, title and excerpt are updated. Blocks and
   * cache policy are written only on insert, so a later edit of the canvas is
   * kept. `aliases` are previous slugs to rename. Pass `create: false` to only
   * repair, never insert.
   */
  ensurePage(input: {
    type: string;
    title: string;
    slug: string;
    excerpt?: string;
    status?: "draft" | "published";
    aliases?: string[];
    create?: boolean;
    /**
     * Block document stored only when the row is inserted. A later activation
     * leaves an edited canvas alone.
     */
    blocks?: { version?: 1; blocks: unknown[] };
    /**
     * Cache-Control stored only on insert. `private, no-store` keeps the page
     * out of shared caches. Ignored when the row already exists.
     */
    cacheControl?: string;
    /**
     * Trash entries of these types that use the same slug. A signed-in page
     * that moves from `page` to `account` passes `["page"]` so the public
     * copy does not keep the address.
     */
    retireTypes?: string[];
  }): Promise<PluginContentEnsureResult>;

  /**
   * Delete every content row of this type (all locales) and the type itself.
   * Built-in slugs `post` and `page` cannot be deleted.
   */
  deleteType(slug: string): Promise<PluginContentDeleteTypeResult>;

  /**
   * Permanently delete entries of this type and slug, in every locale,
   * including copies in trash and their translations. The content type stays.
   * Requires `content:delete`.
   */
  deletePages(input: { type: string; slug: string }): Promise<{ deleted: number }>;

  /**
   * Permanently delete records this user created: content they authored (any
   * status, including trash), media they uploaded, and comments they wrote.
   * Also drops their unpublished working revisions on other people's entries.
   * Does not delete the user, and refuses when that user is an administrator.
   * Requires `content:delete`.
   */
  deleteCreatedBy(userId: string): Promise<PluginDeleteCreatedByResult>;
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
  /**
   * `ensureSchema` only: declared columns it added to tables that already
   * existed (`shop_orders.channel`). Added columns are nullable and not unique.
   */
  columnsAdded?: string[];
  /** `ensureSchema` only: declared indexes it added to tables that already existed. */
  indexesAdded?: string[];
}

export interface PluginWorkspace {
  id: string;
  /** The administrator's billing account on the installation root site, when linked. */
  ownerUserId?: string | null;
  name: string;
  slug: string;
  status: "active" | "suspended" | "provisioning" | "deleted";
  userMode: "isolated" | "shared";
  databaseMode: "current" | "separate";
}

export interface PluginWorkspaceSite {
  id: string;
  tenantId: string;
  name: string;
  hostname: string | null;
  status: string;
  databaseChoice: "inherit" | "current" | "separate";
}

/** The workspace bound to the current request. No connection secrets. */
export interface PluginWorkspaceContext {
  tenantId: string;
  siteId: string;
  hostname: string;
  userMode: "isolated" | "shared";
  databaseMode: "current" | "separate";
  /** True on the site created with the installation. */
  rootSite: boolean;
}

export interface PluginWorkspaceAdminInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export interface PluginWorkspaceDatabaseInput {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface PluginCreateWorkspaceInput {
  name: string;
  slug?: string;
  userMode: "isolated" | "shared";
  databaseMode: "current" | "separate";
  siteName: string;
  hostname: string;
  admin: PluginWorkspaceAdminInput;
  database?: PluginWorkspaceDatabaseInput;
}

export interface PluginAddSiteInput {
  name: string;
  hostname: string;
  databaseChoice: "inherit" | "current" | "separate";
  database?: PluginWorkspaceDatabaseInput;
  admin?: PluginWorkspaceAdminInput;
}

export type PluginTenancyResult =
  | { ok: true; tenantId: string; siteId: string; hostname: string }
  | { ok: false; status: number; error: string };

/**
 * Workspace and site placement. `current()` is available to every plugin.
 * `siblingSites()` lists the current workspace from any of its sites.
 * Every other call requires `platform:tenancy`, runs only on the
 * installation's root site, and is refused while the plugin works on behalf
 * of an AI agent, an API key or a connected app (an MCP or assistant tool
 * call, or a key-authenticated request). The host enforces this whatever the
 * plugin's code does. Stored database passwords are never returned.
 */
export interface PluginTenancyApi {
  current(): Promise<PluginWorkspaceContext | null>;
  /**
   * Active sites in the workspace handling this request. Requires
   * `platform:tenancy`. It works from any site in that workspace and cannot
   * see another workspace. Absent on older hosts.
   */
  siblingSites?(): Promise<PluginWorkspaceSite[]>;
  listWorkspaces(): Promise<PluginWorkspace[]>;
  listSites(tenantId: string): Promise<PluginWorkspaceSite[]>;
  createWorkspace(input: PluginCreateWorkspaceInput): Promise<PluginTenancyResult>;
  addSite(tenantId: string, input: PluginAddSiteInput): Promise<PluginTenancyResult>;
  suspend(tenantId: string): Promise<PluginTenancyResult>;
  reactivate(tenantId: string): Promise<PluginTenancyResult>;
  /** Mark deleted for retention cleanup; dropDatabase requests full immediate purge. */
  deleteWorkspace(tenantId: string, options?: { dropDatabase?: boolean }): Promise<PluginTenancyResult>;
}

/** One live site in the installation, as `ctx.network.sites()` lists it. */
export interface PluginNetworkSite {
  id: string;
  name: string;
  /** Primary hostname, or null when the site has none yet. */
  hostname: string | null;
  /** True for the site created with the installation. */
  mainSite: boolean;
}

/**
 * Behaviour the installation's main site applies to every site. Requires
 * `platform:network`; absent without it and on older hosts.
 *
 * Pair it with hooks registered as `{ network: true }`: those handlers run on
 * every site while this plugin is active on the main site, even where a site
 * has not activated it. Inside them, `ctx.settings` and `ctx.data` still
 * belong to the request's site; read the main site's choices through
 * `mainSiteSettings`.
 */
export interface PluginNetworkApi {
  /** This plugin's settings on the main site, read-only, from any site. */
  mainSiteSettings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
  };
  /**
   * This plugin's secrets on the main site, read-only, from any site.
   * Absent on older hosts. The same key rules as `ctx.secrets` apply.
   * A hosted site cannot write them; the main site saves through `ctx.secrets`.
   */
  mainSiteSecrets?: {
    get(key: string): Promise<string | undefined>;
    has(key: string): Promise<boolean>;
  };
  /**
   * Every live site in the installation, main site first. Only on the main
   * site; on any other site it rejects. The plugin decides what each site
   * gets, so another site's admins never see or change it.
   */
  sites(): Promise<PluginNetworkSite[]>;
  /**
   * One live site and its public address, from any site. Omit `siteId` for
   * the main site. Null for an unknown or inactive site, and on an install
   * without sites. Absent on older hosts.
   */
  site?(siteId?: string): Promise<PluginNetworkSiteAddress | null>;
}

/** A site with the origin its public pages are served from, such as `https://shop.example.com`. */
export interface PluginNetworkSiteAddress extends PluginNetworkSite {
  url: string;
}

export type QuotaScope = "workspace" | "site";
export type QuotaUnit = "count" | "bytes" | "flag";

/** A meter a plugin asks the host to enforce. The key must start with the plugin id. */
export interface QuotaMeterRegistration {
  key: string;
  scope: QuotaScope;
  label: string;
  unit: QuotaUnit;
  /**
   * Flags are on until a stored limit of 0 turns them off. `"off"` means a
   * missing limit stays off, and only a limit above 0 turns the flag on.
   * Use that for a feature a plan or an operator turns on.
   */
  whenUnset?: "on" | "off";
  /**
   * Current usage for one workspace or site. The platform limits page calls
   * this. Omit it when the plugin only passes `used` to `check`.
   */
  count?(scopeId: string): Promise<number>;
}

/** Result of `quotas.check`. `limit` and `remaining` are null when nothing is configured. */
export interface QuotaDecision {
  ok: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
}

/** One meter as the host currently knows it. `used` is null when it could not be counted. */
export interface QuotaMeterView {
  key: string;
  scope: QuotaScope;
  label: string;
  unit: QuotaUnit;
  limit: number | null;
  used: number | null;
  /** Present when a missing flag limit means off. */
  whenUnset?: "off";
}

/**
 * Another workspace or site to read or write limits for. Only with
 * `platform:tenancy`, and only from the installation's root site: a plugin on a
 * hosted site cannot change other workspaces. A `siteId` reaches workspace
 * meters through that site's workspace; a `tenantId` reaches workspace meters only.
 */
export type PluginQuotaTarget = { tenantId: string } | { siteId: string };

/** A meter the host knows: core meters and those plugins registered. */
export interface PluginQuotaMeterInfo {
  key: string;
  scope: QuotaScope;
  label: string;
  unit: QuotaUnit;
  /** `core`, or the id of the plugin that registered it. */
  owner: string;
}

/**
 * Configured ceilings. Every plugin may register meters and check them.
 * `set` writes the same limits a platform operator edits: it requires
 * `platform:tenancy`, runs only on the installation's root site (also for the
 * plugin's own workspace), and is refused on behalf of an AI agent or API
 * key. A missing limit is unlimited.
 */
export interface PluginQuotasApi {
  register(meter: QuotaMeterRegistration): Unsubscribe;
  /**
   * Whether `delta` more units still fit. Core meters (`sites`, `users`,
   * `content`, `media.bytes`) are counted by the host. A plugin meter needs
   * `used`, the plugin's own current count, before the new units.
   */
  check(key: string, input?: { delta?: number; used?: number }): Promise<QuotaDecision>;
  /** With `target`, the meter of that workspace or site (see `PluginQuotaTarget`). */
  get(key: string, target?: PluginQuotaTarget): Promise<QuotaMeterView>;
  /**
   * `null` clears the meter back to unlimited. Without `target`, this plugin's
   * own workspace or site; with it, that one (see `PluginQuotaTarget`).
   */
  set(key: string, limit: number | null, target?: PluginQuotaTarget): Promise<void>;
  /** Every meter the host enforces. Optional: older hosts do not provide it. */
  meters?(): Promise<PluginQuotaMeterInfo[]>;
}

export type PluginRowValue = string | number | boolean | null;

/** Column equality filters. A `null` value matches `IS NULL`. */
export type PluginRowMatch = Record<string, PluginRowValue>;

export interface PluginRowOrder {
  column: string;
  direction?: "asc" | "desc";
}

/** Bounds on one column. Values are compared as the database compares them. */
export interface PluginRowRange {
  gt?: Exclude<PluginRowValue, null>;
  gte?: Exclude<PluginRowValue, null>;
  lt?: Exclude<PluginRowValue, null>;
  lte?: Exclude<PluginRowValue, null>;
}

export interface PluginRowFindOptions {
  /** Defaults to 100, capped at 500. */
  limit?: number;
  /** Deterministic order. Add `id` last when other columns can tie. */
  orderBy?: PluginRowOrder[];
  /**
   * Range conditions, combined with the equality `where`:
   * `{ created_at: { gte: "2026-10-01 00:00:00", lt: "2026-11-01 00:00:00" } }`.
   */
  range?: Record<string, PluginRowRange>;
  /**
   * Keyset paging: return the rows after this one in `orderBy` order. Pass the
   * `orderBy` column values of the last row of the previous page; every
   * `orderBy` column is required and may not be null. Requires `orderBy`.
   */
  after?: PluginRowMatch;
  /**
   * Lock the matched rows (`SELECT … FOR UPDATE`) until the surrounding
   * `transaction` ends. Has no lasting effect outside a transaction.
   */
  lock?: boolean;
}

export interface PluginRowIncrementOptions {
  /**
   * Lower bounds the row must still meet after the change. A row that would
   * fall below one is left alone and is not counted.
   */
  min?: Record<string, number>;
  /** Plain values written in the same statement, such as `updated_at`. */
  set?: PluginRowMatch;
}

/**
 * Row operations on plugin-owned tables, always scoped to the current site.
 * Inside `transaction`, the same methods run on the transaction's connection
 * and errors propagate instead of returning empty results.
 */
export interface PluginRowOps {
  findOne(
    table: string,
    where?: PluginRowMatch,
    options?: Omit<PluginRowFindOptions, "limit">,
  ): Promise<Record<string, unknown> | undefined>;
  find(table: string, where?: PluginRowMatch, options?: PluginRowFindOptions): Promise<Record<string, unknown>[]>;
  /**
   * Insert one row. Returns `false`, and writes nothing, when a unique key
   * already holds an equal value. Use it to claim an idempotency key or event.
   */
  insert(table: string, row: PluginRowMatch): Promise<boolean>;
  upsert(table: string, row: PluginRowMatch, options?: { match?: string[] }): Promise<void>;
  /**
   * Set `values` on every row matching `where`. Returns the number of matched
   * rows, so a status or version in `where` works as compare-and-set.
   * `where` must name at least one column.
   */
  update(table: string, where: PluginRowMatch, values: PluginRowMatch): Promise<number>;
  /**
   * Add integer deltas in one statement (`available = available - 2`), so
   * concurrent callers cannot lose each other's change. Returns matched rows.
   */
  increment(
    table: string,
    where: PluginRowMatch,
    deltas: Record<string, number>,
    options?: PluginRowIncrementOptions,
  ): Promise<number>;
  /** Returns the number of deleted rows. `where` must name at least one column. */
  delete(table: string, where: PluginRowMatch): Promise<number | void>;
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
   *
   * Tables that already exist get the declared columns and indexes they lack,
   * so adding a column to a declaration upgrades existing installations. An
   * added column is nullable and not unique (existing rows have no value);
   * declare a unique index for it instead. Types, removed columns and removed
   * indexes are never changed: a plugin migrates its data itself.
   */
  ensureSchema(
    tables: PluginSchemaTable[],
    options?: { target?: PluginDatabaseTarget; rebuild?: string[] },
  ): Promise<PluginSchemaApplyResult>;
  /**
   * Drop this plugin's prefixed tables. Pass the same `tables` / `target` used
   * with `ensureSchema`. Omit `tables` to drop every table owned by the prefix.
   * Call this from `deleteData()` on the main site. Another site cannot drop
   * the tables: the host deletes that site's rows instead.
   */
  dropSchema(
    tables?: PluginSchemaTable[],
    options?: { target?: PluginDatabaseTarget },
  ): Promise<PluginSchemaApplyResult>;

  /**
   * Delete this site's rows from the plugin's tables. Tables stay, so other
   * sites keep their rows. `site_id` is the only match.
   */
  clear(tables?: PluginSchemaTable[]): Promise<PluginSchemaApplyResult>;

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
    where?: PluginRowMatch,
    options?: Omit<PluginRowFindOptions, "limit">,
  ): Promise<Record<string, unknown> | undefined>;

  /**
   * Matching rows in a plugin-owned table, always scoped to this site.
   * `limit` defaults to 100 and is capped at 500.
   */
  find(
    table: string,
    where?: PluginRowMatch,
    options?: PluginRowFindOptions,
  ): Promise<Record<string, unknown>[]>;

  /**
   * Delete matching rows in a plugin-owned table. `where` must include at
   * least one column besides the implicit site scope.
   */
  delete(table: string, where: PluginRowMatch): Promise<void>;

  /** See `PluginRowOps.insert`. */
  insert(table: string, row: PluginRowMatch): Promise<boolean>;
  /** See `PluginRowOps.update`. */
  update(table: string, where: PluginRowMatch, values: PluginRowMatch): Promise<number>;
  /** See `PluginRowOps.increment`. */
  increment(
    table: string,
    where: PluginRowMatch,
    deltas: Record<string, number>,
    options?: PluginRowIncrementOptions,
  ): Promise<number>;

  /**
   * Run `fn` in one transaction on the database holding this plugin's tables:
   * it commits when `fn` resolves and rolls back when it throws. Calls to
   * `ctx.databases` row methods made while `fn` runs join the same
   * transaction, as does a nested `transaction`. Keep network calls out of
   * `fn`; locks are held until it returns.
   */
  transaction<T>(fn: (tx: PluginRowOps) => Promise<T>): Promise<T>;

  /** Column names for a plugin-owned table, or `[]` when the table does not exist. */
  columns(table: string): Promise<string[]>;

  /**
   * This plugin's rows on another site in the installation. Requires
   * `platform:tenancy` and the installation's main site. Absent on older hosts.
   */
  forSite?(siteId: string): PluginRowOps;
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
  readonly roles: PluginRolesApi;
  readonly users: PluginUsersApi;
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
    /** Durable dispatch queues outbound webhooks first and propagates queue failures. */
    emit<K extends ActionName>(hook: K, event: ActionPayload<K>, options?: { durable?: true }): Promise<void>;

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
   * Workspaces and sites. Read the request with `current()`. Creating,
   * suspending, and deleting requires `platform:tenancy`.
   */
  tenancy: PluginTenancyApi;

  /**
   * Network-wide behaviour set on the main site. Requires `platform:network`.
   * Absent without that permission and on older hosts. See `PluginNetworkApi`.
   */
  network?: PluginNetworkApi;

  /**
   * Workspace and site ceilings. Register a meter, then `check` it before
   * creating a record the host does not count itself. `set` requires
   * `platform:tenancy`.
   */
  quotas: PluginQuotasApi;

  /**
   * Private files for this site, never public. Requires `files:private`.
   * Stored on the storage the site resolves to (its own S3 connection, the
   * root site's, the environment bucket, or local disk) and counted against
   * the site's `files.count` / `files.bytes` limits. Serve one with a route
   * that returns `{ file: { key } }`. Absent on older hosts.
   */
  files?: PluginFilesApi;

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
   * Placeholder images for empty image slots. Use `placeholder()` instead of
   * shipping a private fallback so the site owner's choice applies everywhere.
   * No permission required.
   */
  media: import("./placeholders.js").PluginMediaApi;

  /**
   * Create content types and pages the plugin needs. Requires `content:create`.
   * Publishing a page also requires `content:publish`. `deleteType` requires
   * `content:delete`. Existing slugs are left alone on create (idempotent).
   * `listPublished` and `getPublished` require `content:read`.
   */
  content: PluginContentApi;

  /** The site's configured locales. Read-only; no permission required. */
  i18n: {
    /** The site's default locale code (BCP-47), e.g. `en-US`. */
    defaultLocale(): Promise<string>;
    /** Every active locale code, default first. */
    locales(): Promise<string[]>;
    /** The site's time zone (IANA) from Settings → General, e.g. `Europe/Amsterdam`. `UTC` when unset. */
    timeZone(): Promise<string>;
    /**
     * Every ISO 3166-1 country with its name in `locale` (default: the site's
     * default locale), sorted by name. The same list core and plugin settings use.
     */
    countries(locale?: string): Promise<Array<{ code: string; name: string }>>;
  };

  /**
   * The site's Discussion CAPTCHA. Absent on older hosts. `config()` never
   * includes the secret.
   */
  captcha?: PluginCaptchaApi;

  /**
   * Call another active plugin's own HTTP route in-process. The session is the
   * one you pass; this does not grant that plugin's capabilities. Absent on
   * older hosts.
   */
  plugins?: PluginBridgeApi;

  /** The site's configured assistant. Absent on older hosts. */
  ai?: PluginAiApi;

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
  /**
   * Called when a site activates the plugin and the module is already running
   * because another site loaded it first. Create tables here. `activate` still
   * runs the first time the module loads.
   */
  provision?(ctx: PluginContext): void | Promise<void>;
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
