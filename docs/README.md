# Author documentation

Justflows Community Edition is extended with plugins, themes, and CSS providers.

| Guide                                              | When to read it                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| [Search](SEARCH.md) | Public and admin search, index lifecycle, and external backends |
| [Access control](ACCESS-CONTROL.md)                | Custom roles, scoped user access, and device sessions             |
| [Redirect manager](REDIRECTS.md)                   | Redirect rules, 404 reports, URL suggestions, CSV and automation  |
| [Permalinks](PERMALINKS.md)                        | URL structures, locale prefixes, taxonomy bases, and redirects    |
| [Architecture](ARCHITECTURE.md)                    | Public SEO rendering, admin SSR, hydration, builds, and hosting   |
| [Naming and structure conventions](CONVENTIONS.md) | Adding a folder or file: what to name it and where it goes        |
| [Plugin author guide](PLUGINS.md)                  | First plugin: lifecycle, context, admin pages                     |
| [Hooks](HOOKS.md)                                  | Actions, gates, and filters                                       |
| [Webhooks](WEBHOOKS.md)                            | Signed outbound events, retries, and plugin event types           |
| [Federated management API](FEDERATED-API.md)       | API keys and the `/api/manage/v1` surface for headless operation  |
| [Email delivery](EMAIL.md)                         | Transport setup, delivery logs, suppression, and provider plugins |
| [Manifest](MANIFEST.md)                            | `justflows.json` / `justflows-theme.json` fields                  |
| [SDK compatibility](SDK-COMPATIBILITY.md)          | Version ranges, runtime versions, deprecation, and API stability  |
| [Permissions](PERMISSIONS.md)                      | Plugin permissions vs user capabilities                           |
| [Diagnostics](DIAGNOSTICS.md)                      | Debug mode, CLI checks, traces, and plugin health checks          |
| [Packaging](PACKAGING.md)                          | Building a `.jfpkg` for Admin → Plugins                           |
| [Themes](THEMES.md)                                | Styles, patterns, demo home/blog layouts, resolution order        |
| [Blocks](BLOCKS.md)                                | Plugin blocks, page/post builders, blog lists, layout and styling |
| [Media and responsive images](MEDIA.md)            | Derivative generation, formats, focal point, and regeneration     |
| [Testing extensions](TESTING-EXTENSIONS.md)        | Unit tests and running against CE                                 |
| [Cache](CACHE.md)                                  | `ctx.cache` and revalidation                                      |
| [Static / edge export](STATIC-EXPORT.md)           | Export published pages to files for object storage or a CDN       |
| [Trash and retention](TRASH.md)                    | Recoverable deletion, restore, purge, and media warnings          |
