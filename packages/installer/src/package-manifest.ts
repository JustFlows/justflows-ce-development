import { z } from "zod";
import {
  AdminMenuItemSchema,
  gplLicenseValidationMessage,
  isGplCompatibleLicense,
  RegistryListingSchema,
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
      .regex(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/, "ID must be dot-namespaced e.g. acme.my-plugin"),
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
    license: z
      .string()
      .min(1, "Package license is required and must be GPL-compatible"),
    homepage: z.url().optional(),
    /** Semver range for Justflows compatibility */
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
    /** CSS-provider-only: npm packages installed locally on activation */
    stylesheets: z.array(CssAssetSchema).default([]),
    /** CSS-provider-only: optional scripts loaded from installed packages */
    scripts: z.array(CssAssetSchema).default([]),
    permissions: z.array(z.string()).default([]),
    dependencies: z.record(z.string(), z.string()).default({}),
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
     * Plugin-only: admin sidebar entries the package owns. Kept here so the
     * declaration survives install and can be re-read from the stored manifest.
     */
    adminMenu: z.array(AdminMenuItemSchema).max(20).optional(),
    setupPath: z
      .string()
      .regex(/^\/admin\/[a-z0-9][a-z0-9\-/]*$/, "Setup path must be an /admin/… route")
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
          .regex(/^[a-z][a-z0-9-]{0,59}$/, "Content type slug must be lowercase letters, numbers, and hyphens"),
      )
      .max(20)
      .optional(),
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
    if (!isGplCompatibleLicense(manifest.license)) {
      ctx.addIssue({
        code: "custom",
        path: ["license"],
        message: gplLicenseValidationMessage(manifest.license),
      });
    }
  });

export type PackageManifest = z.infer<typeof PackageManifestSchema>;
