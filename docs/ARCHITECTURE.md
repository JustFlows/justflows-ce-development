# Architecture

Justflows is one Express application with three deliberately different render
paths. Production releases ship all compiled output; installation never asks a
site owner to run Vite, TypeScript, npm build, or pnpm build.

## Source and test layout

The monorepo separates framework-neutral domain packages from Express and React
integration. Server helpers, routes, and admin pages are grouped by domain:

```text
apps/server/
  src/
    server.ts                  Express entry point
    register-routes.ts         Explicit route registration and ordering
    lib/<domain>/              Server helpers: auth, content, cache, rendering, etc.
    routes/<domain>/           HTTP handlers: auth, content, design, settings, etc.
    routes/manage-api/         Management API boundary
    middleware/                Request middleware
    views/                     EJS views and static HTML fallbacks
  tests/unit/<domain>/
  tests/integration/routes/<domain>/
  tests/integration/middleware/
  tests/integration/database/
  admin-ui/
    src/pages/admin/<domain>/  Feature pages and their panels
    src/components/            Shared and feature-grouped React components
    tests/                     Browser tests mirroring pages, components, and helpers
  public-scripts/src/          Standalone public browser scripts
packages/<name>/
  src/                         Framework-neutral implementation and public exports
  tests/                       Package-owned unit and integration tests
plugins/hello-world/
  src/                         Example plugin implementation
  tests/unit/                  Example plugin tests
```

Tests are outside production source trees. The admin browser suite has its own
Vitest configuration; server HTTP and database suites stay with the server.
See [naming and placement conventions](CONVENTIONS.md) for ownership rules and
[local test commands](TESTING-EXTENSIONS.md#workspace-verification) for execution.

## Public website and SEO

Public pages are rendered completely on the server by
`apps/server/src/routes/public/public-site.ts` and the EJS views under
`apps/server/src/views`. The first HTML response contains the published blocks,
navigation, the page title, the canonical URL, and language alternates, plus
whatever an SEO plugin adds through `html.title`, `html.canonical`, and
`html.head` (meta description, Open Graph tags, structured data). Search
crawlers do not need to execute React or wait for an API request to discover
page content.

The public renderer also owns localized URLs, redirects to canonical paths,
`robots.txt`, a basic `sitemap.xml` (plugins add paths through
`seo.sitemapPaths`), theme CSS, page caching, and preview authorization. Do not
move public content or SEO metadata into the admin React bundle.

### Syndication feeds

RSS 2.0 / Atom 1.0 / JSON Feed 1.1 output is not host-rendered. It is owned by
the first-party **SEO Toolkit** plugin (`justflows.seo`, published through the
plugin registry, not bundled in this repo), which is activated like any other
plugin and also writes the SEO meta tags. It wires itself up through public SDK
surfaces only:

- `ctx.http.get("/feed.xml", …)` and the locale / type / author variants
  (`ctx.content.listPublished()` provides the entries; `ctx.i18n` the locales);
- `html.head` filter for the `<link rel="alternate">` autodiscovery tags;
- `content.published|updated|unpublished|deleted` actions to drop its cached
  feed bodies (`ctx.cache`, `feed:` prefix);
- `staticExport.routes` filter to seed the exporter with the feed URLs.

| URL                           | Feed                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `/feed.xml`                   | Site-wide — the content types in the SEO setting `feedTypes` (posts by default)       |
| `/<type>/feed.xml`            | One content type                                                                      |
| `/author/<username>/feed.xml` | One author                                                                            |
| `/<locale>/…/feed.xml`        | Any of the above, for a non-default locale (`.atom` / `.json` alongside every `.xml`) |

Feeds are locale-aware, list the newest `feedItemCount` entries (default 20),
exclude scheduled (`publishedAt` in the future), expired, and per-entry
opted-out (`fields.seoFeedExclude`, the "Exclude from feeds" checkbox on any
item's SEO tab) items, carry plain-text summaries (or none, per
`feedContentDepth`), optionally an author (`feedIncludeAuthor`, default off) and
featured image (`feedIncludeImage`), and advertise a `rel="self"` link plus an
optional WebSub hub (`feedWebSubHub`). Settings live on the `justflows.seo`
plugin (Admin → Extensions → SEO). Per-taxonomy feeds from
issue [#102](https://github.com/JustFlows/justflows-ce/issues/102) are not built
yet — the `taxonomies` / `terms` tables have no term-assignment UI or public
archive to feed from.

The site can still be **crawled to static files** for object-storage / CDN
hosting: `apps/server/src/lib/static-export/` fetches every published route over
loopback and writes the HTML, assets, `sitemap.xml`, `robots.txt`, the
syndication feeds (via the plugin's `staticExport.routes` seeds), and
`theme.css` to a folder, with a manifest and optional publish-triggered
rebuilds. See [Static / edge export](STATIC-EXPORT.md).

## Authenticated admin SSR

The Vite/React admin has two entry points:

- `apps/server/admin-ui/src/entry-server.tsx` renders the requested route with React's
  server renderer and React Router's `StaticRouter`.
- `apps/server/admin-ui/src/entry-client.tsx` hydrates that markup with `BrowserRouter` and
  installs CSRF handling for later mutations.

For an authenticated `/admin/*` navigation, Express validates the session,
prefetches the shared shell data and the current route's initial read requests,
renders the React tree, and embeds an escaped JSON snapshot in the document.
The hydration client serves those initial GETs from the snapshot, so it does not
repeat them as browser Fetch/XHR traffic. The cache expires after hydration;
saves, deletes, uploads, explicit refreshes, and later navigation continue to use
the authenticated API.

The embedded snapshot is a delivery optimization, not a security boundary.
Only data already authorized for the current session may be serialized. Admin
HTML is `private, no-store` and carries `X-Robots-Tag: noindex, nofollow,
noarchive`.

Login, registration, and first-run installation can be served by the lightweight
root startup layer before the full Express application is ready. They use the
same client bundle but do not require the authenticated admin SSR data path.

## Build artifacts

`pnpm --filter @justflows/server build` produces:

```text
apps/server/dist/                         compiled Express server, views, and catalogs
apps/server/dist/lib/<domain>/            compiled helpers and worker entrypoints
apps/server/admin-ui/dist/client/         browser HTML, JavaScript, CSS, assets
apps/server/admin-ui/dist/server/         Node SSR bundle (entry-server.js)
```

The updater and first-run bootstrap consider the application built only when
the Express output, client HTML, and SSR entry all exist. Docker copies both
admin outputs into the runtime image. `scripts/make-zip.sh` builds them before
creating an official shared-hosting archive. The archive excludes dedicated
`tests/` folders, `tsconfig.tests.json`, and Vitest configurations. Production
TypeScript builds do not emit test files.

Consequently:

- Docker users build the image through Docker Compose and never invoke Vite.
- Release ZIP users upload prebuilt artifacts and install runtime dependencies
  through the browser bootstrap.
- Core updates may use the prebuilt artifacts contained in the update archive.
- Installed sites apply a core update only when it is verified (see
  `SECURITY.md`). With `JUSTFLOWS_CORE_RELEASE_KEY_FILE` set,
  `scripts/make-zip.sh` writes `core-integrity.json` into the archive and
  `justflows.zip.sig` through `scripts/sign-core-release.mjs`. Attach the
  signature to the GitHub release beside
  `justflows.zip` and `justflows.zip.sha256`; the API gateway serves it as
  `signatureUrl`.
- Only source contributors need pnpm and the build commands.

## Development

Use the normal workspace commands:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm dev
# Run verification separately from the development process:
pnpm test --force
pnpm typecheck
```

Root `pnpm build` orders workspace dependencies through Turbo. Internal `file:`
dependencies have explicit build edges in `turbo.json`; keep them aligned with
package manifests. Root test and typecheck tasks depend on their package builds.
For a focused server run after building, use `pnpm --filter @justflows/server test`.

The admin client and SSR builds deliberately use separate Vite configurations.
The browser build is split into stable React vendor, admin-page, and visual
builder chunks. Keep large feature families in those explicit chunk groups so
the client does not regress to a single monolithic bundle; the SSR renderer
remains one Node entry because it must synchronously render every admin route.
Universal components must not read `window`, `document`, `navigator`, or
`localStorage` during render. Browser-only work belongs in effects, event
handlers, or the client entry. New initial GET requests must be added to the
route-aware prefetch list in `apps/server/src/lib/admin/admin-ssr.ts` or replaced with
a server loader, and should have an SSR test.

## Multi-site routing

The host is resolved to one workspace before content, media, or admin handlers
run. Routing lives in the installation database. A workspace that chose a
separate database is queried through that connection for the rest of the
request. See [Multi-site and tenancy](MULTISITE.md).

## Scheduled content lifecycle

The server owns persisted publishing/expiry deadlines and the
`@justflows/jobs` scanner in `apps/server/src/lib/content/content-scheduling-db.ts`. Row-locked
transactions commit content, history, webhook deliveries and an event together;
post-commit events invalidate caches and notify plugins. The latest saved working
revision replaces the live snapshot only at its due time. Signed single-entry
previews render through the public renderer with public theme/navigation data.
See [Scheduled publishing](SCHEDULING.md) for timing, retries and API contracts.
