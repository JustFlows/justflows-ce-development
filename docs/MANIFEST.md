# Manifest reference

Two related shapes exist.

## Workspace plugin (`justflows.json` in `plugins/<name>/`)

The SDK `PluginManifestSchema` is what `activate()` sees at runtime: `id`,
`name`, `version`, `license`, `engines.justflows`, `permissions`, `main`, and
optional `adminMenu`.

Copy `plugins/hello-world/justflows.json` and keep a namespaced id
(`acme.seo`, not `seo`).

## Packaged `.jfpkg` (`justflows.json` at the archive root)

Installer `PackageManifestSchema` is the install contract:

| Field                | Notes                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | Must be `1`                                                                                                                                                                                                                                                                                                                   |
| `type`               | `plugin`, `theme`, or `css-provider`                                                                                                                                                                                                                                                                                          |
| `id`                 | Dot-namespaced, e.g. `acme.my-plugin`                                                                                                                                                                                                                                                                                         |
| `name`               | Display name                                                                                                                                                                                                                                                                                                                  |
| `version`            | Semver (`1.2.3`)                                                                                                                                                                                                                                                                                                              |
| `publisher`          | Required                                                                                                                                                                                                                                                                                                                      |
| `license`            | Required; GPL-compatible for Marketplace                                                                                                                                                                                                                                                                                      |
| `entrypoints.server` | Plugin JS entry inside the archive                                                                                                                                                                                                                                                                                            |
| `adminMenu`          | Requires `admin:extend` in `permissions`. Optional `contentType` on an item lists those CMS entries on the plugin host page.                                                                                                                                                                                                  |
| `engines.justflows`  | Supported Justflows CE semver range; checked before install                                                                                                                                                                                                                                                                   |
| `settingsSchema`     | Optional Admin → plugin settings fields                                                                                                                                                                                                                                                                                       |
| `contentTypes`       | Optional CMS type slugs the plugin owns. On uninstall the host deletes those types and every entry when `deleteContentOnUninstall` is on                                                                                                                                                                                      |
| `assets`             | Optional client-side assets shipped in the package: `{ dir?, scripts?, styles? }`. The host serves `<dir>/**` (default `public`) at `/ext/<id>/**` and auto-adds the `scripts` / `styles` to every public page. See [PLUGINS.md](PLUGINS.md#client-side-assets)                                                               |
| `adminApp`           | Plugin-only. Requires `admin:extend` in `permissions`. A self-contained admin build `{ dir?, locales, routes: [{ path, entry, title? }] }`. `locales.en` is required and is the fallback catalog (a flat JSON object of strings, path relative to `dir`). The host serves `<dir>/**` at `/ext/<id>/admin/**` (admin-authenticated) and mounts each route's `entry` in a same-origin `<iframe>`. See [PLUGINS.md](PLUGINS.md#ship-your-own-admin-app) |

Themes use `justflows-theme.json` (or `justflows.json` with `type: "theme"`).
See [THEMES.md](THEMES.md).

Invalid manifests fail install. Tests live in
`packages/installer/tests/unit/package-manifest.test.ts`.

This compatibility field and its SDK schema are shared by plugins, themes, and
CSS providers. The legacy top-level `justflows` field is accepted for existing
packages but is deprecated. New packages use `engines.justflows`. See
[SDK-COMPATIBILITY.md](SDK-COMPATIBILITY.md) for the full compatibility policy.
