# Manifest reference

Two related shapes exist.

## Workspace plugin (`justflows.json` in `plugins/<name>/`)

The SDK `PluginManifestSchema` is what `activate()` sees at runtime: `id`,
`name`, `version`, `license`, `permissions`, `main`, optional `adminMenu`.

Copy `plugins/hello-world/justflows.json` and keep a namespaced id
(`acme.seo`, not `seo`).

## Packaged `.jfpkg` (`justflows.json` at the archive root)

Installer `PackageManifestSchema` is the install contract:

| Field | Notes |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `type` | `plugin`, `theme`, or `css-provider` |
| `id` | Dot-namespaced, e.g. `acme.my-plugin` |
| `name` | Display name |
| `version` | Semver (`1.2.3`) |
| `publisher` | Required |
| `license` | Required; GPL-compatible for Marketplace |
| `entrypoints.server` | Plugin JS entry inside the archive |
| `adminMenu` | Requires `admin:extend` in `permissions`. Optional `contentType` on an item lists those CMS entries on the plugin host page. |
| `justflows` | Optional semver range for CE compatibility |
| `settingsSchema` | Optional Admin → plugin settings fields |
| `contentTypes` | Optional CMS type slugs the plugin owns. On uninstall the host deletes those types and every entry when `deleteContentOnUninstall` is on |

Themes use `justflows-theme.json` (or `justflows.json` with `type: "theme"`).
See [THEMES.md](THEMES.md).

Invalid manifests fail install. Tests live in
`packages/installer/src/package-manifest.test.ts`.
