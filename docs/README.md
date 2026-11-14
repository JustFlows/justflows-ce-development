# Author documentation

Justflows Community Edition is extended with plugins, themes, and CSS providers.

| Guide                                                 | When to read it                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [Scheduled publishing](SCHEDULING.md)                 | Publish dates, expiry, revisions, timezones, agenda and preview links |
| [Search](SEARCH.md)                                   | Public and admin search, index lifecycle, and external backends       |
| [Content visibility](CONTENT_VISIBILITY.md)           | Who can view content, rule precedence, and plugin rule types          |
| [Access control](ACCESS-CONTROL.md)                   | Custom roles, scoped user access, and device sessions                 |
| [Sign-in and password pages](AUTH.md)                 | Member pages in the theme, staff pages under the admin path           |
| [Redirect manager](REDIRECTS.md)                      | Redirect rules, 404 reports, URL suggestions, CSV and automation      |
| [Permalinks](PERMALINKS.md)                           | URL structures, locale prefixes, taxonomy bases, and redirects        |
| [Architecture](ARCHITECTURE.md)                       | Source/test layout, public rendering, admin SSR, builds, and hosting  |
| [Secure self-hosting](SELF-HOSTING-SECURITY.md)       | TLS, proxies, edge origins, least privilege, secrets, and writable paths |
| [Edge protection](EDGE-PROTECTION.md)                 | CDN/WAF caching, bots, DDoS boundaries, origin lockdown, and rollback |
| [Multi-site and tenancy](MULTISITE.md)                | Workspaces, host routing, current or separate databases, and signup   |
| [Naming and structure conventions](CONVENTIONS.md)    | Adding a folder or file: what to name it and where it goes            |
| [Plugin author guide](PLUGINS.md)                     | First plugin: lifecycle, context, admin pages                         |
| [Hooks](HOOKS.md)                                     | Actions, gates, and filters                                           |
| [Webhooks](WEBHOOKS.md)                               | Signed outbound events, retries, and plugin event types               |
| [Federated management API](FEDERATED-API.md)          | API keys and the `/api/manage/v1` surface for headless operation      |
| [Bring your own AI](AI.md)                            | MCP server for Claude/ChatGPT/Cursor, OAuth, BYOK admin assistant     |
| [Email delivery](EMAIL.md)                            | Transport setup, delivery logs, suppression, and provider plugins     |
| [Manifest](MANIFEST.md)                               | `justflows.json` / `justflows-theme.json` fields                      |
| [SDK compatibility](SDK-COMPATIBILITY.md)             | Version ranges, runtime versions, deprecation, and API stability      |
| [Permissions](PERMISSIONS.md)                         | Plugin permissions vs user capabilities                               |
| [Extension trust](EXTENSION-TRUST.md)                 | What extension permissions and signatures do not constrain            |
| [Incident response](INCIDENT-RESPONSE.md)             | Contain, reinstall, rotate, restore, and notify                       |
| [Diagnostics](DIAGNOSTICS.md)                         | Debug mode, CLI checks, traces, and plugin health checks              |
| [Resource limits](RESOURCE-LIMITS.md)                 | Shared and per-process limits in multi-worker deployments             |
| [Packaging](PACKAGING.md)                             | Building a `.jfpkg` for Admin → Plugins                               |
| [Extension review](EXTENSION-REVIEW.md)               | Marketplace requirements, automated checks, and human review          |
| [Threat model](THREAT-MODEL.md)                       | Actors, assets, trust boundaries, and accepted risks                  |
| [Security releases](SECURITY-RELEASES.md)             | Maintainer runbook from private report to advisory                    |
| [Themes](THEMES.md)                                   | Styles, patterns, demo home/blog layouts, resolution order            |
| [Blocks](BLOCKS.md)                                   | Plugin blocks, page/post builders, blog lists, layout and styling     |
| [Builder document architecture](BUILDER-DOCUMENT.md) | Canonical block document, ids, nesting, breakpoints, migrations       |
| [Builder preview and recovery](BUILDER-PREVIEW.md)   | How the canvas matches the page, deliberate differences, unavailable blocks |
| [Block editor contract](BLOCK-CONTRACT.md)           | Optional fields plugin blocks declare for the builder                 |
| [Security advisories](SECURITY-ADVISORIES.md)         | Signed advisory feed, check results, and publishing                   |
| [Media and responsive images](MEDIA.md)               | Derivative generation, formats, focal point, regeneration, and the web server file for `/uploads` |
| [Local testing and extensions](TESTING-EXTENSIONS.md) | Workspace commands, database suites, and extension testing            |
| [Cache](CACHE.md)                                     | `ctx.cache` and revalidation                                          |
| [Backup and recovery](BACKUP-RECOVERY.md)             | Archive protection, recovery objectives, and restore drills           |
| [Static / edge export](STATIC-EXPORT.md)              | Export published pages to files for object storage or a CDN           |
| [Progressive Web App](PWA.md)                         | Installable public-site PWA: manifest, icons, offline, updates        |
| [Trash and retention](TRASH.md)                       | Recoverable deletion, restore, purge, and media warnings              |
