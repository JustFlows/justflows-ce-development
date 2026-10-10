import { z } from "zod";
import {
  isValidPluginApiNamespace,
  AdminMenuItemSchema,
  gplLicenseValidationMessage,
  isGplCompatibleLicense,
  PluginAssetsSchema,
  PluginAdminAppSchema,
  RegistryListingSchema,
  ExtensionEnginesSchema,
  PLUGIN_ID_RE,
  RELATIVE_ADMIN_PATH_RE,
  resolvePluginAdminPath,
  ThemePatternRegistrationSchema,
} from "@justflows/sdk";

const CssAssetSchema = z.object({
  href: z.string().optional(),
  src: z.string().optional(),
  integrity: z.string().optional(),
  crossOrigin: z.enum(["anonymous", "use-credentials"]).optional(),
  defer: z.boolean().optional(),
});

/** Unified manifest schema for plugins, themes, and css-providers (.jfpkg) */
export const PackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.enum(["plugin", "theme", "css-provider"]),
    id: z
      .string()
      .regex(PLUGIN_ID_RE, "ID must be justflows.<name> (lowercase, e.g. justflows.seo)"),
    apiNamespace: z.string().refine(isValidPluginApiNamespace, "Invalid or reserved plugin API namespace").optional(),
    name: z.string().min(1).max(100),
    /**
     * Anchored at both ends. `.regex()` runs RegExp.test(), which only honours
     * the `^`, so a pattern ending at the patch number accepted anything after
     * it — including "1.0.0/../../.." — and the installer joins this value into
     * the destination path. Optional prerelease and build metadata are kept so
     * versions such as "0.1.3-rc" still validate.
     */
    version: z
      .string()
      .max(64)
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
        "Version must be a semantic version, e.g. 1.2.3 or 1.2.3-rc.1",
      ),
    publisher: z.string().min(1),
    description: z.string().max(500).optional(),
    license: z.string().min(1, "Package license is required and must be GPL-compatible"),
    homepage: z.url().optional(),
    /** Runtime compatibility contract for the host installer. */
    engines: ExtensionEnginesSchema.optional(),
    /** @deprecated Use engines.justflows in new manifests. */
    justflows: z.string().optional(),
    /** Plugin-only: server entrypoint path within the package */
    entrypoints: z
      .object({
        server: z.string().optional(),
        admin: z.string().optional(),
      })
      .optional(),
    /** Theme-only: theme entrypoint */
    entrypoint: z.string().optional(),
    /** Theme-only: registered pattern id to a safe package-relative JSON path. */
    patterns: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/), ThemePatternRegistrationSchema)
      .optional(),
    /** CSS-provider-only: npm packages installed locally on activation */
    stylesheets: z.array(CssAssetSchema).default([]),
    /** CSS-provider-only: optional scripts loaded from installed packages */
    scripts: z.array(CssAssetSchema).default([]),
    permissions: z.array(z.string()).default([]),
    /**
     * When true, the main site may offer this plugin to other sites. Those
     * sites can activate it and change only their own rows.
     */
    allowMultisite: z.boolean().optional(),
    dependencies: z.record(z.string(), z.string()).default({}),
    settingsSchema: z
      .record(
        z.string(),
        z.object({
          type: z.enum(["string", "number", "boolean", "text", "select"]),
          label: z.string().min(1),
          description: z.string().optional(),
          default: z.unknown().optional(),
          localized: z.boolean().optional(),
          options: z
            .array(z.object({ value: z.string().max(200), label: z.string().min(1).max(200) }))
            .max(200)
            .optional(),
          optionsSource: z.enum(["timezones", "countries"]).optional(),
        }),
      )
      .optional(),
    /**
     * Plugin-only: admin sidebar entries the package owns. Kept here so the
     * declaration survives install and can be re-read from the stored manifest.
     */
    adminMenu: z.array(AdminMenuItemSchema).max(20).optional(),
    // Relative to `/admin/plugins/<id>` like `adminMenu` paths — see the SDK
    // `RELATIVE_ADMIN_PATH_RE` doc. `""` is the namespace root; omit for "no
    // setup wizard".
    setupPath: z
      .string()
      .max(100)
      .regex(RELATIVE_ADMIN_PATH_RE, "Setup path must be relative to /admin/plugins/<id>")
      .optional(),
    /**
     * Plugin registry / Marketplace listing. The publisher fills this in;
     * the registry uses it for commercial vs community, visibility, coming-soon, and price.
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
     * Plugin-only: client-side assets shipped in the package. Kept here so the
     * declaration survives install and can be re-read from the stored manifest.
     */
    assets: PluginAssetsSchema.optional(),
    /**
     * Plugin-only: a self-contained admin app the plugin ships and the host
     * mounts in an `<iframe>` for each declared route. Kept here so the
     * declaration survives install and can be re-read from the stored manifest.
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
    if (manifest.setupPath && !manifest.permissions.includes("admin:extend")) {
      ctx.addIssue({
        code: "custom",
        path: ["setupPath"],
        message: 'Declaring setupPath requires the "admin:extend" permission',
      });
    }
    if (manifest.adminApp && !manifest.permissions.includes("admin:extend")) {
      ctx.addIssue({
        code: "custom",
        path: ["adminApp"],
        message: 'Shipping an admin app requires the "admin:extend" permission',
      });
    }
    if (!isGplCompatibleLicense(manifest.license)) {
      ctx.addIssue({
        code: "custom",
        path: ["license"],
        message: gplLicenseValidationMessage(manifest.license),
      });
    }
    if (manifest.patterns && manifest.type !== "theme") {
      ctx.addIssue({
        code: "custom",
        path: ["patterns"],
        message: "Only themes may register patterns",
      });
    }
  })
  // Resolve the plugin-relative admin paths against the manifest id so the
  // stored manifest (and everything that reads it) carries absolute
  // `/admin/plugins/<id>/…` URLs — matches the SDK `PluginManifestSchema`.
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

export type PackageManifest = z.infer<typeof PackageManifestSchema>;
