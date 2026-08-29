# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [0.1.6-rc] [Unreleased]

### Added

- Plugin registry listings declare `registry` on `justflows.json`:
  `commercialMarketplace` (internal commercial catalogue), `listed` (publisher
  visibility after internal approval), `free`, `comingSoon` (visible but not
  installable), and when paid `price.amount` / `price.currency`. Admin →
  Marketplace hides unlisted rows, shows a Coming soon badge instead of
  Install, and still sends paid listings to Justflows checkout.

- Plugin settings, secrets, and schema metadata are stored in `plugin_data`.
  `site_settings` is only for site options. Activation is `plugins.status`.
  Shop writes store identity to `shop_stores` and treats catalog products as
  Content of type `product`, with `shop_products.content_id` for commerce
  fields (SKU, price, stock). Creating or editing a product shows those
  commerce fields and variations; `content.created` for type `product` inserts
  `shop_products`, and saving writes `shop_products`,
  `shop_product_variations`, and `shop_inventory`. Commerce rows are keyed by
  the content translation group, so SKU, prices, and stock stay in sync across
  locales while title, excerpt, and blocks stay per translation. The product
  page layout uses tags (`{{price}}`, `{{sku}}`, `{{title}}`, and others) that
  Shop fills from catalog and content fields on `content.blocks` and
  `content.render`.   Shop registers storefront blocks (gallery layouts with an optional lightbox, buy box,
  breadcrumbs, accordion, policies, reviews, related products, product list
  (inline price, CTA, swatches, tall images, overlay, simple, favorites, border
  grid, supporting text, hover CTA, and detail cards), detail shots)
  used by the Default theme **Product detail** pattern and the extra **Product
  mosaic**, **Product story**, **Product list**, and **Ecommerce storefront**
  (image tiles and feature sections) layouts. New products
  also get that Product detail page-builder layout (gallery, price, variations,
  specs). `ctx.databases.upsert` /
  `findOne` / `find` / `delete` write plugin tables; leftover `plugin.{id}:…`
  rows in `site_settings` are still read as a fallback and removed on the next
  save.

- New `theme.css` filter hook: an activated plugin can append CSS to the site
  stylesheet served at `/theme.css`, after the theme's own styles and the
  Customizer tokens but before the site owner's Additional CSS. It runs once
  per stylesheet build (not per page) so handlers may be async, and the plugin
  runtime already busts the `theme` cache on activate/deactivate, so the CSS
  appears and disappears with the plugin. The storefront component styles
  (`.jf-product-*`) moved out of the Default theme's `global.css` into the
  registry plugin's
  [`src/styles/shop.css`](https://github.com/JustFlows/plugin-registry-service/blob/main/plugins/ecommerce/src/styles/shop.css),
  which Shop registers on this hook and minifies once at build time to
  `dist/styles/shop.css`; the theme is now
  shop-agnostic. Shared rules stay in the theme — the gallery lightbox (also
  used by the core gallery block), the screen-reader utility, and the Ecommerce
  storefront pattern chrome.
  ([#28](https://github.com/JustFlows/justflows-ce/issues/28))

- Activating Shop creates the Product and Shop content types and the required
  storefront pages (Shop, Product detail, Product category, Cart, Checkout, Order
  confirmation, Customer account, Order tracking) when they are missing.
  Activating Shop also corrects the misspelled Page slug `prodcut-detail-page`.
  Plugins get `ctx.content.ensureType` and `ctx.content.ensurePage`
  (`content:create`; publishing also needs `content:publish`). Uninstall can
  call `ctx.content.deleteType` (`content:delete`) to remove those types and
  every entry. `ensurePage` updates title and excerpt when the slug already
  exists.

- Plugins can declare `setupPath` and serve a first-run step guide from
  `GET`/`POST /ext/{id}/setup`. Activating such a plugin opens that admin
  page. Encrypted `ctx.secrets` and `ctx.databases` probes support a shared
  or separate database without returning passwords. Plugins can create their
  own prefixed tables with `ctx.databases.ensureSchema()`. Shop uses this to
  collect commerce topology and store identity (all optional), then create
  `shop_*` tables on the chosen database. Topology is not a later toggle.
  After setup, `/admin/shop` is the Shop overview. Store identity and selling
  options live only on Admin → Plugins → Shop → Settings
  (`/admin/plugins/justflows.shop/settings`) and are stored on `shop_stores`.
  Every plugin implements a `deleteData` hook that the host calls on uninstall.
  Plugins may drop data silently or honour a `deleteDataOnUninstall` setting
  (Shop defaults to deleting `shop_*` tables) and a
  `deleteContentOnUninstall` setting (Shop defaults to deleting Shop and
  Product pages and posts). Shop declares `contentTypes: ["product", "shop"]`
  so the host removes those CMS types even if the plugin hook does not.
  `ctx.content.deleteType` requires `content:delete`.

- Plugins can add admin sidebar pages through the `admin.menu` filter
  (`admin:extend` required). The handler is registered in `activate()` and
  removed on deactivate. `GET /api/plugins/admin-menu` applies the filter and
  re-validates every item. Admin paths on that menu that have no dedicated SPA
  page open a generic plugin host screen instead of bouncing to the dashboard.
  A `commerce` sidebar domain exists for shop-style plugins and stays hidden
  until one of those plugins is active. After Shop finishes first-run setup it
  contributes the commerce top tabs (catalog, orders, checkout, and the other
  core merchant pages) on the generic plugin host — nested paths skip the
  setup wizard. A menu item may set `contentType` so the host lists those CMS
  entries; Shop → Products shows every Content row of type `product`.

- Admin → Menus can add any CMS content type (pages, posts, products, shop
  pages, and custom types), not only pages and posts. Saving still stores
  the content type slug; public menus resolve those links like pages.

- Admin → Updates now discovers new releases. It asks the Justflows API
  (`GET /v1/core/latest`, backed by the `JustFlows/justflows-ce` GitHub
  releases) for the latest stable version and, when it is newer than the
  running one, shows an **Update to vX.Y.Z** button that downloads the release
  `justflows.zip`, verifies it against the published `justflows.zip.sha256`,
  and installs it through the same pipeline as a manual upload. A major-version
  jump is labelled and still installs, but only on explicit confirmation. The
  gateway host (`https://api.justflows.com`) is fixed in the code and cannot be
  overridden by an environment variable, so a compromised environment cannot
  repoint core-update downloads.
  ([#87](https://github.com/JustFlows/justflows-ce/issues/87))
- Admin → Updates: **Automatic updates** toggle. When on, a daily job installs
  newer releases that keep the same major version (`0.x` → `0.y`); it never
  crosses a major boundary, since that can carry breaking changes. Every
  attempt, skip, and result is written to the audit log. The server-wide
  `JUSTFLOWS_DISABLE_AUTO_UPDATE` env var overrides the toggle.

### Fixed

- Public product pages replace `{{price}}`, `{{sku}}`, `{{title}}`, and the
  other product tags with catalog and content values. The host starts the
  plugin runtime before those filters, fills tags on the block tree before
  HTML render, then fills any tags still in the HTML.

- Admin → Plugins → Settings no longer goes blank after Save. Saving now
  returns the same schema and values as loading, and those hooks run on the
  plugin runtime instead of a separate empty registry. Reopening the page
  after a save keeps the form.

## [0.1.5] — 2026-08-27

### Added

- The install wizard lets you choose the default public-site language (installed
  as the default language) and optionally emails the full site details and
  admin credentials to the address you enter.

- Working revisions for every content type: saving a published item writes a
  draft without changing the live snapshot; visitors keep seeing the published
  version until an explicit publish copies the working revision across
  atomically. The editor lists the last five published versions and can restore
  one as a draft. Preview, compare, discard, and list status
  (“Published — draft changes”) follow that model.
  ([#65](https://github.com/JustFlows/justflows-ce/issues/65))

- Admin → Users: dedicated Edit User page (`/admin/users/:id`) — update
  display name and role, reset the account's password, and remove the user,
  giving an administrator full CRUD over accounts from one screen.
  ([#56](https://github.com/JustFlows/justflows-ce/issues/56))
- `GET /api/users/:id` and `GET /api/auth/me` (whoami) — session-scoped
  identity backing the page above and the role-aware admin UI below.
  ([#56](https://github.com/JustFlows/justflows-ce/issues/56))

### Changed

- A fresh install starts with object cache, cache revalidation, browser cache,
  and GZIP off, the site unpublished (`site_public` false), and search engines
  discouraged from indexing. Disabling object cache deletes every file in
  `.cache`.

- Site languages are any BCP 47 tag the site enables (`nl-NL`, `en-US`,
  `zh-Hant-TW`). The seeded default is `en-US`. Public URLs use the stored
  tag as-is. There is no built-in language list and no rewriting of `nl`
  to `nl-NL`. Existing `en` language and content rows are remapped to
  `en-US` on update. Admin → Languages accepts a free-form code; names
  come from the runtime.
  ([#78](https://github.com/JustFlows/justflows-ce/issues/78))

### Fixed

- Fresh install on MySQL/MariaDB dropped the default site settings (`key` is
  reserved), so Admin showed the site as live and search engines as allowed.
  Those rows now persist, so a new site stays unpublished with indexing
  discouraged.

- Fresh installs wrote `CACHE_ENABLED=0` but the running process kept serving
  page-cache hits: the cache singleton was created on the first request before
  `.env` existed (default on) and was never rebuilt. It now follows the env
  flag immediately, deletes leftover `.cache` files whenever cache is off, and
  public pages send `X-Jf-Page-Cache: BYPASS` when cache is off.

- Public navigation keeps the selected language: menu links no longer drop
  back to the default locale, and a missing translation page falls back to
  the default-language content instead of a 404.
  ([#78](https://github.com/JustFlows/justflows-ce/issues/78))
- Admin → Languages had no Remove control even though
  `DELETE /api/languages/:id` already existed. Non-default languages can
  now be deleted; the default language still cannot.
  ([#78](https://github.com/JustFlows/justflows-ce/issues/78))
- Admin → Menus listed every translation of a page or post when adding
  items, so Home appeared twice. The picker now shows only the default
  language; public menus still follow the visitor locale.
  ([#78](https://github.com/JustFlows/justflows-ce/issues/78))
- Admin → Content listed every translation as its own row. The list now
  shows only the default language; translations stay on the item editor.
  ([#78](https://github.com/JustFlows/justflows-ce/issues/78))
- Saving, autosaving, publishing, or discarding a draft no longer deletes the
  only revision row. Each distinct snapshot is kept as history (last 5) so
  authors can restore it. ([#65](https://github.com/JustFlows/justflows-ce/issues/65))
- Revision rows were never stored on MariaDB: `source` is a reserved word, so
  INSERTs into `revisions` failed, and draft saves plus the first publish never
  wrote a restore point. Those writes now quote the column and record up to
  five historical versions. ([#65](https://github.com/JustFlows/justflows-ce/issues/65))
- Core zip updates on MySQL/MariaDB no longer fail migration `0010` with
  errno 121 (`Can't create table … revisions`) when adding working-revision
  columns. The dialect files stay additive (no new foreign key or stored
  generated unique slots on a table that already has InnoDB constraints).
  ([#65](https://github.com/JustFlows/justflows-ce/issues/65))
- Admin → Users **Remove** was a dead button — its `onClick` was missing. It
  now calls `DELETE` with a confirm prompt and removes the row on success.
  ([#56](https://github.com/JustFlows/justflows-ce/issues/56))
- `PATCH /api/users/:id` and `DELETE /api/users/:id` guarded against deleting
  yourself but not against demoting or deleting the last remaining
  administrator. Both now refuse when the change would leave the site with
  zero administrators. ([#56](https://github.com/JustFlows/justflows-ce/issues/56))
- A subscriber — a role with no admin capability at all — could still sign
  into `/admin` and land on a dashboard with nothing it could actually do.
  Login and the server's own `/admin` gate now send a subscriber to the site
  instead of the admin app. ([#56](https://github.com/JustFlows/justflows-ce/issues/56))
- An editor, author, or contributor could open admin pages and click controls
  whose backing API call was more restricted than the page itself — Content
  Types, Plugins (and plugin settings), Themes, Design, Menus, Settings,
  Languages, Forms, the content editor's set-as-home/blog-page toggle, and
  the page builder's reusable-block and header-preset library — surfacing a
  raw "no access" error instead of the control simply not being there. Each
  is now hidden (or, for Settings, the whole form is read-only) for a role
  that cannot use it, matching its actual `requireRole` on the server. This
  is a UX fix, not a security one: every route involved was already
  independently enforced server-side.
  ([#56](https://github.com/JustFlows/justflows-ce/issues/56))

## [0.1.4] — 2026-08-26

### Added — server-side rendering

- The authenticated Vite/React admin now renders every route on the Express
  server and hydrates in the browser. Shared shell data and each route's initial
  reads are embedded as escaped, request-scoped state, eliminating duplicate
  startup Fetch/XHR requests while preserving API calls for later interactions.
- Production builds now emit separate `admin-ui/dist/client` and
  `admin-ui/dist/server` artifacts. Docker images, shared-hosting ZIPs,
  first-run readiness checks, and core updates require and ship both, so site
  owners never need to run a frontend build.
- Admin documents and pre-session pages explicitly send
  `X-Robots-Tag: noindex, nofollow, noarchive`. The public website remains independently
  server-rendered with its existing SEO metadata, canonical URLs, language
  alternates, sitemap, robots policy, and structured data.

Findings from a full source audit. Nothing here changes content, themes or the
public site; all of it is authentication, packaging and transport.

### Fixed — critical

- **Package installer path traversal.** `version` in a `.jfpkg` manifest was
  validated by a regex anchored only at the start, so `1.0.0/../../..` passed and
  the install path escaped `packages-installed` — into an `fs.rm()` and an
  `fs.rename()`. Reachable from plugin, theme, CSS-provider and marketplace
  installs, and it ran _before_ the signature check, so a package Justflows
  correctly refused could still overwrite files. The pattern is now anchored at
  both ends and the destination is confined independently of it.

### Fixed — high

- Package verification runs while the package is still staged, so a refused
  upload no longer stays on disk in its final install location.
- `POST /api/bootstrap` required no authentication: its origin check passed any
  request without an `Origin` header, so plain `curl` could spawn the installer.
  It now takes the setup key, with loopback exempt, and is rate limited.
- `GET /api/bootstrap/status` served up to 64 KB of the npm install log to
  anonymous callers and never checked install state. It now returns only the
  installed flag once set up, and releases the log only to a caller holding the
  setup key. The log is deleted when the install completes.
- Pages served by root `server.js` — `/login`, `/install`, `/`, `/assets/*` —
  carried no security headers at all, because they never reach Express. Under
  Passenger that was every pre-sign-in page, and the login form was framable.
- Content-Security-Policy applied only to the public site. The admin, whose
  session can install extensions and replace the core, ran with no policy. It
  now has its own strict, enforcing policy, graded by the Security screen.

### Added

- Password change (Admin → Security → Your account) and administrator-initiated
  password reset. Neither existed; a compromised credential could not be rotated
  from inside the product. Both revoke every existing session.
- Two-factor authentication (TOTP, RFC 6238) with single-use recovery codes.
  Secrets and codes are encrypted at rest.

### Added — compliance and supply chain

- **Administrative audit log.** New `audit_log` table (migration 0008) and an
  Admin → Security → Audit log screen. Records sign-ins and failed sign-ins,
  password changes and resets, 2FA enrolment, account creation, role changes and
  deletions, plugin/theme/CSS-provider installs and activations, core updates,
  security-header changes, and public-API toggles. Nothing recorded any of this
  before, so a compromise could not be reconstructed. Writes never throw into
  the action they describe. Retention defaults to 365 days
  (`JF_AUDIT_RETENTION_DAYS`), because the log holds IP addresses.
- **Subject access and erasure.** `GET /api/users/:id/personal-data` returns
  everything held about an account; `POST /api/users/:id/erase` anonymises
  comments, deletes that person's form submissions, and strips address and user
  agent from their audit entries. Content is reassigned, not deleted — erasure
  is a right over personal data, not over a site's articles. Form-submission
  retention is available via `JF_SUBMISSION_RETENTION_DAYS`, off by default.
- **SBOM and checksums.** Each release now ships a CycloneDX 1.5 SBOM (inside
  the archive and beside it) and a `.sha256` file. A zip uploaded by FTP was
  previously the one artefact nobody could verify — which sat oddly next to the
  strict signature checking applied to plugins.
- **Secret scanning in CI.** `scripts/scan-secrets.mjs`, Node builtins only.

### Fixed — compliance and supply chain

- `security.txt` was not valid under RFC 9116: the REQUIRED `Expires` field was
  absent, `Canonical` was a bare path where a URI is required, and `Policy`
  named a different repository. Now built per request so `Expires` cannot go
  stale on a long-lived process.
- GitHub Actions were pinned to mutable tags; they are now commit SHAs with the
  release recorded in a trailing comment. Added a repository-wide least-
  privilege `permissions` block, and one per job.
- The container build ran `corepack prepare pnpm@latest`, overriding the pinned
  `packageManager` — so the image used whatever pnpm shipped that day rather
  than the version the lockfile was written by. The base image is now pinned by
  digest, and there is a `HEALTHCHECK`.
- Compose files gained `no-new-privileges`, `cap_drop: ALL`, a memory limit and
  a healthcheck. `read_only` is deliberately not set, and says why: the install
  wizard writes `.env` into the application root and extension installs write
  beside it, so a read-only root filesystem would break setup.
- The release zip excluded `.env.*`, which took `.env.example` and
  `.env.production.example` with it — while README and SECURITY.md both told
  readers to consult them. The exclusions are now explicit.
- Node version drift: `engines`, `.node-version` and Docker all said 22 while CI
  tested on 26. CI now uses 22, matching the floor the project claims and the
  runtime it ships.

### Fixed — medium

- CSRF tokens are bound to the session revocation counter, so they rotate on
  sign-out and password change instead of being fixed for the life of the site.
  A related bug is fixed: when the CSRF cookie was missing but a session was
  present, the re-issued cookie was random and could never validate.
- Plugin HTTP routes are CSRF-checked, no longer receive the `Cookie` header,
  cannot overwrite security or CORS response headers, and now receive the
  caller's session so a handler can authorise.
- The reference `nginx.conf` no longer drops the `Content-Disposition` the app
  attaches to PDF uploads, repeats security headers inside every `location`
  (nginx does not inherit them), marks them `always` so they survive error
  responses, and sends `X-XSS-Protection: 0` to match the app.
- Route handlers no longer serialise exceptions into responses; the four
  unauthenticated install-wizard messages are opaque and the detail is logged.
- Marketplace requests have timeouts, and downloads are size-capped while
  streaming rather than after buffering.
- CSS-provider npm dependencies must name a published version or range — URLs,
  git references and local paths were accepted and then executed.
- The site URL is validated identically by the install wizard and by settings.
- Minimum password length is 12 everywhere; `POST /api/users` allowed 8.

### Fixed — low

- Admin → Users no longer renders a hard-coded account list or leaves **Send
  invite** disconnected. It now loads the site's users from the database and
  provides an administrator-only invitation endpoint that creates the account,
  assigns the selected role, generates temporary credentials, sends them by
  email, and reports mail-delivery failures without hiding a successful insert.
- `GET /api/blocks` needed no session. It enumerates every registered block type
  including plugin-contributed ones — a precise inventory of installed
  extensions — and ran two database queries per call.
- Sign-in was not scoped to a site, so with more than one site row the account
  chosen depended on database row order.
- `safePath()` in root `server.js` compared with `startsWith(base)` and no
  separator, which also accepts a sibling directory sharing the prefix. It now
  matches the containment check the rest of the codebase uses, and resolves
  symlinks.
- The settings read was unscoped and capped at 100 rows with no `ORDER BY`, so a
  site with enough plugin settings could silently lose `active_theme` from the
  result and fall back to the default theme.
- CSRF rejections were emitted before the security-header middleware ran, so
  those 403s went out bare. Headers are now registered first.
- Uploads had a 100 MB per-file cap and no total, so any author could fill the
  volume. Both are now limits (`JF_MAX_UPLOAD_MB`, `JF_MAX_LIBRARY_MB`), and an
  oversized file answers 413 instead of 500.
- Rate limiting had a flat window, which lets an attacker run at exactly the
  limit indefinitely. Exhausting a window now lengthens the next one, up to 8x,
  and throttled responses carry `Retry-After`.

### Fixed — PostgreSQL compatibility

Found while scoping the settings query; all three would have thrown on postgres.

- Settings reads hardcoded MySQL backtick quoting for the reserved `key`
  column, which is a syntax error in PostgreSQL. Quoting is now driver-aware.
- `UPDATE sites … ORDER BY created_at LIMIT 1` is a MySQL extension; the row is
  now addressed by id.
- The settings-write fallback used `UUID()`, `NOW()` and `ON DUPLICATE KEY`.
  It was unreachable in practice and has been removed in favour of the existing
  driver-aware helper.

## [0.1.3] — 2026-08-25

### Added

- Any page can be the site home page. Theme customize now picks which page renders
  at `/` (or turns the current theme layout into a page). Until a page is chosen,
  the previous theme homepage layout still serves `/`.
- Every page can customize its header and navigation in the page builder: show or
  hide the header, choose a menu (or none), logo and title, layout, and stickiness.
  The theme Styles tab still sets the site-wide default header menu.
- **Saved headers.** Once a page's header is built the way you want, save it by
  name and apply it to any other page in one click — layout, widgets, and
  blocks included. Applying copies the configuration rather than linking it
  live, so the two pages stay independent afterward.
- Page-builder blocks can use entrance, hover, and press animations. The inspector
  exposes the full preset list; the canvas previews them with Motion. The public
  site plays the same effects with CSS and a small in-view script.
- Site chrome blocks in the page builder: light/dark toggle, language switcher,
  and login/register. Register only renders on the public site when Settings →
  Anyone can register is on. The same widgets can be enabled on a page header.
  Any block can also be dragged into the header itself.
- A **Colors (dark mode)** palette in the theme customizer. Dark mode is no longer
  whatever the theme hardcoded — every colour is editable from the admin and is
  applied both to an explicit choice and to visitors whose device asks for dark.
- An **Auto** option on the light/dark toggle, on the `core.color-scheme` block and
  on the page header. It clears the visitor's stored choice and follows the device.
- **Custom CSS per block** in the page builder, plus a CSS class field. `&` stands
  for the block; a selector without it is scoped as a descendant, so a block's CSS
  can never reach the rest of the page. Media queries and keyframes are supported;
  `@import` and `url(javascript:…)` are rejected on save and again on render.
- **Block JSON** editing in the inspector. Any block can be edited directly as
  JSON — type, version, props, and children — which is the only way to change a
  block's type in place or set a prop no inspector field exposes.
- **Spacing, size and alignment on every block.** Padding, margin, max width,
  min height, self-alignment, text alignment, corners and shadow, on any block
  type including a plugin's. Values are steps on the theme's spacing scale rather
  than raw lengths, so a page keeps its rhythm and the whole site tightens up on
  a phone when the scale does.
- **A real design-token system.** The Customizer gains Headings (font, weight,
  line height, letter spacing, H1–H3 sizes), Spacing (one number drives the whole
  scale), Corners, Shadows, and a wide-width control. It is now schema-driven:
  adding a control adds a token, with validation derived from the control's own
  type and bounds.
- **Reusable blocks.** Save any block to the library and link to it; editing the
  saved copy updates every page that uses it. Resolved on the server at render.
- **An editable site footer.** Theme builder → Footer edits the footer as blocks,
  with its own draft and publish. A site that never customises one keeps the
  built-in footer.
- **Undo and redo in the page builder**, with ⌘Z / ⇧⌘Z. Edits made in quick
  succession collapse into one step, and a text field keeps its own undo stack.
- **A grid layout block.** `core.grid` places blocks on a column grid instead of
  stacking them: drag a block to move it, drag either edge to resize, or type
  exact column/row numbers in the inspector. Placement lives on the child, so any
  block — including a plugin's — can be placed without a wrapper. Layouts stay
  responsive: nothing drops below half width on tablets, and everything goes full
  width on phones, in source order.
- **Page JSON** in the page builder. With no block selected the inspector shows
  the whole page — every block plus the page header — instead of an empty
  placeholder, and edits apply straight back. Block ids are preserved, so this
  edits the page in place rather than re-importing it.
- **A Contact page pattern** in the default theme, with a hero, contact
  details, and a form block wired to the site's default "Contact" form.
- Theme patterns can declare `requiresBlockTypes` in their JSON so the page
  builder's Patterns panel can tell the editor a pattern needs a plugin
  that isn't installed. The Contact pattern uses it for `justflows.forms.form`:
  if the Forms extension isn't active, its pattern card shows an inline
  notice with a link to Extensions instead of silently importing a block
  that won't render anything on the public site.
- **Three new Gallery layouts**: Carousel (a swipeable, scroll-snap slider),
  Slideshow (one image at a time, cross-fading), and List (full-width
  stacked rows). Grid and Masonry are unchanged. All three, like the
  existing layouts, are pure CSS on the public site — no client-side script.
  The inspector now hides the Columns field for layouts it doesn't apply to.
- **A first-class blog page.** Theme builder → Blog can select any page as the
  site's blog index or turn the active theme's default blog layout into a new
  published page. Content lists and page settings identify the selected page,
  and deleting it clears the setting automatically.
- **A Post List block** for building blog indexes on any page. It lists published
  posts newest first in a grid or list, can show featured images, dates, and
  excerpts, and supports either a per-block page size or the site's default.
  Numbered pagination lives below the page at `/page/2`, `/page/3`, and so on,
  including localized page URLs.
- Posts and other non-page content can now use the visual block builder. The
  library hides whole-page patterns and site-chrome widgets when editing a post,
  while pages retain the complete library and per-page header controls.
- **A Link List block** for footer columns, sitemaps, and resource lists, with an
  optional heading and reorderable links.
- Button, hero, call-to-action, and Link List URL controls can pick a published
  page or post by title while still accepting a typed internal or external URL.
  Image blocks now use the Media Library picker instead of requiring a URL.

### Fixed

- Visitors whose device asks for dark mode now get it. The public site defaulted
  to light and ignored `prefers-color-scheme` until the visitor clicked, and it
  now follows the device — live — until they choose for themselves.
- The Customizer's heading sizes now actually apply. A later rule in the default
  theme's typography block overrode them at equal specificity; that block is now
  the token-driven one, with the chosen size as the ceiling of a fluid `clamp()`.
- The page builder's own chrome uses the admin design tokens instead of 113
  hardcoded hex values, so it follows the admin theme like the rest of the UI.
- Per-block CSS no longer drops declarations written alongside rules.
  `padding: 2rem; & h2 { … }` — the shape the panel's own placeholder teaches —
  silently lost the padding.
- Customizer colours and Additional CSS now override the active theme. `/theme.css`
  emitted them _before_ the theme's own stylesheet, so at equal specificity the
  theme silently won. Theme styles come first now, then site tokens, then
  Additional CSS last.
- Empty page-builder columns accept dropped blocks. Each column is its own grid
  cell with a drop target that stays visible, so content is no longer rejected
  or stacked as a single column.
- Unchecking “Show site title” now hides the title on the public site. The header
  previously forced the title back on whenever the logo was also hidden.
- **Gallery's Masonry layout reverted to Grid on every save.** The gallery
  block stored its grid/masonry/etc. choice under `props.layout`, the same
  key the page builder already used — on any block, not just the gallery —
  for unrelated grid-placement data (`{ col, span, row, rowSpan }`, set by
  dragging a block around inside a `core.grid`). The document sanitizer that
  runs on every save treated any `layout` value as placement data; a string
  like `"masonry"` doesn't look like a placement object, so it silently fell
  back to the default and got dropped. "Grid" looked unaffected only because
  grid is also the fallback when nothing is stored. Grid placement now lives
  under its own `gridPlacement` prop, so the two can no longer collide;
  existing pages that already used grid placement are migrated on next save.
- **Inactive plugins were still live.** A plugin that was merely uploaded
  (status "installed", never activated) was treated as fully active: its
  admin menu entries showed up, its blocks worked in the page builder, and
  Analytics/Forms/Gallery served their public behavior. Only Forms, Gallery,
  and Analytics could reach the "installed" state without ever activating
  (custom plugin modules always started active), so this affected only the
  bundled extensions, but on any site that had them staged and not yet
  turned on. Every enabled-check now requires status `active`.
- **Deactivating or deleting a plugin didn't bust the page cache.** Activating
  a plugin invalidated cached pages so it would show up immediately;
  deactivating and deleting didn't, so a page cached while the plugin was
  active kept serving the old HTML — a deleted Forms plugin's form, for
  example, stayed live on cached pages until the cache separately expired.
  Both actions now revalidate the same way activation does.
- **A deactivated plugin's block type never left the page builder's catalog
  or the public renderer.** The block registry only ever gained entries; a
  block registered while Forms or Gallery was active stayed registered (and,
  for Gallery, kept rendering on the public site) after deactivation, because
  nothing ever unregistered it. Deactivating now removes the block type from
  both the picker and the render path immediately.
- The Contact pattern's inline "extension isn't active" notice no longer lets
  you import the pattern anyway — the import action is disabled while any
  block type it needs isn't in the active catalog, instead of just warning
  next to a working button.
- Publishing the footer now clears its old draft. A stale draft previously kept
  outranking the newly published footer in preview, making Publish appear to do
  nothing until the draft was discarded separately.

### Changed

- Documented file/folder naming conventions in a new `docs/CONVENTIONS.md`,
  linked from `docs/README.md` and `CONTRIBUTING.md`, covering `packages/*`,
  `apps/server`, the admin UI, plugins, themes, docs, licenses, migrations,
  and scripts.
- `public/js/*.js` (referenced by the site layout) is now tracked in version
  control instead of sitting untracked and un-gitignored.
- `packages/auth/src` no longer wraps single-file concerns in their own
  subdirectories: `password/hash.ts` → `password.ts`,
  `capabilities/index.ts` → `capabilities.ts`, `session/types.ts` →
  `session.ts`.
- `apps/server/src/lib/i18n/admin/` and `.../catalogs/` are renamed to
  `admin-catalogs/` and `site-catalogs/` so the admin-SPA and public-site
  translation catalogs are named symmetrically instead of one looking like
  the unqualified default.

## [0.1.2] — 2026-08-24

### Added

- Shared-hosting installs no longer need a terminal. Opening the domain shows a
  first-run `index.html` that runs `install:all` in the browser, then continues
  to the existing site wizard. The file is deleted once the site is installed.
  Git checkouts keep the developer `/install` path and cannot spawn that
  installer.

### Changed

- The README install guide matches the browser-first flow: shared hosting opens
  the domain (not `/install`), waits on `index.html`, then the site wizard;
  Docker and git checkouts are documented separately, including the setup key.

### Security

- Theme file reads (`justflows-theme.json`, patterns, demo home, styles) stay inside
  `themes/` or `packages-installed/`. A theme id or stored `installedPath` can no
  longer be joined straight into `readFileSync`.
- `/install`, `/login`, and `/register` are rate-limited with `express-rate-limit`
  before they `sendFile` the admin SPA. Unhandled-error and session-revocation
  logs pass request values through `logSafe` and `JSON.stringify` so they cannot
  inject log lines or format strings.
- CSS-provider default `input.css` is created with `wx` (no exists-then-write
  race). Bootstrap log tails `fstat` the already-open descriptor.
- CI no longer runs `actions/dependency-review-action`. That action needs GitHub
  Dependency graph, which public `justflows-ce` does not enable, so the job failed
  every PR. High/critical advisory gating remains `pnpm audit --audit-level high`.
- Fixed stored cross-site scripting in the SEO JSON-LD block. `buildSeoHeadHtml`
  serialised the page name, description, URL, and image with `JSON.stringify`,
  which escapes neither `<` nor `/`, so a content title or `seoTitle` field
  containing `</script>` closed the structured-data element and everything after
  it was parsed as HTML. Any account able to publish content — `author` and above —
  could run script on every public page, including for administrators browsing the
  site. The payload can read the non-`httpOnly` `jf_csrf` cookie and drive the
  admin API as the visitor. Structured data is now serialised through
  `jsonLdPayload()`, which escapes `<`, `>`, `&`, U+2028, and U+2029.

  Sites running 0.1.1 or earlier should audit `content.title` and the `seoTitle`
  and `seoImage` entries of `content.fields` for markup before upgrading.

- Content Security Policy is now **enabled and enforcing by default** on the public
  site. The policy is the one that already shipped in the Security screen
  (`default-src 'self'; object-src 'none'; script-src 'self'; …`). Its scope is
  `public`, so the admin interface is unaffected, and a stored configuration that
  deliberately disabled CSP is still honoured. A theme that relies on inline
  `<script>` or third-party script hosts will need those allowed under
  Admin → Security. `JF_SECURITY_HEADERS_DISABLED=1` restores the previous headers
  without database access.

- The Google tag no longer adds `'unsafe-inline'` to `script-src` when it cannot
  compute a hash for its inline snippet. It now degrades to not running rather
  than silently widening a policy the operator configured.

- Package authenticity is now **required by default**. A `.jfpkg` is refused unless
  it carries a valid marketplace signature or its SHA-256 digest is listed in
  `JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS`; the rejection message includes the digest so
  it can be pinned. Previously every trust check fell through to a silent pass
  unless `JUSTFLOWS_REQUIRE_SIGNED_PACKAGES=1` was set. Set
  `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1` to restore the old behaviour.

- Plugin modules are imported only for plugins whose status is `active`. Installing
  a plugin previously executed its top-level code immediately, so there was no
  state in which a package could be installed but not run.

- CSS-provider `postInstall` can no longer read, write, or execute outside the
  provider directory. `input` must name a file inside the package — it was resolved
  against the application root, so a manifest could copy `.env` into `input.css`,
  which the public asset route then served. `output` is confined to the provider's
  `dist/` and may not begin with `-`. Tailwind runs from the resolved binary in the
  install directory instead of `npx --yes`, which would fetch and execute whatever
  the manifest's dependency specifier pointed at, defeating `--ignore-scripts`.

- The `/css-providers` route serves files only from the provider's `node_modules/`
  and `dist/` directories, and only regular files. Build scaffolding such as
  `input.css` and `package.json` is no longer reachable.

- Theme customizer values are validated against a CSS grammar before being written
  into `theme.css`. Colours, font stacks, and custom-property names must match an
  allowlist and range controls are clamped to their schema bounds, so an editor can
  no longer close the declaration and inject arbitrary rules — which bypassed
  `sanitizeCustomCss` entirely. Values supplied by a theme package's
  `css_variables` are checked at the same chokepoint.

- Zip extraction rejects archives containing symbolic links, which both `unzip` and
  `7z` would otherwise restore, letting an entry that passes every path check write
  outside the destination. Extraction now also passes `-:` / `-snld`, and the
  destination tree is re-checked afterwards. The 7z entry listing is parsed with
  `-slt` rather than by taking the last whitespace-separated token, which truncated
  any filename containing a space.

- `.jfpkg` archives are inflated through a streaming gunzip with a running size
  ceiling. `gunzipSync` materialised the whole stream before the expanded-size
  limit could apply, so a 50 MB archive expanding to tens of gigabytes exhausted
  memory first.

- Values written to `.env` are rejected if they contain a line break or null byte.
  Because dotenv keeps the first occurrence of a key and `APP_URL` is written before
  the generated `APP_SECRET`, a newline in the installer's site URL let the caller
  choose the session signing key. `.env` permissions are now set explicitly after
  every write instead of relying on the create-only `mode` argument.

- The installer requires a full `http://` or `https://` site URL.

- Public routes no longer reflect exception text. Seven handlers returned
  `String(err)` as `text/html`, which leaked internal detail to anonymous callers
  and could reflect request-derived content. A catch-all error handler was added as
  a backstop.

- Read access tightened on endpoints that were reachable by any signed-in user or
  by nobody at all. `GET /api/settings` returns the mail transport, admin address,
  and registration policy to administrators only — a self-registered subscriber
  could previously read the SMTP host and username. `/api/comments`, `/api/health`,
  `/api/plugins`, and `/api/updates` now require a role rather than just a session.
  `/api/themes`, `/api/themes/patterns`, `/api/languages`, and `/api/marketplace`
  required no authentication at all. The marketplace proxy also forces a JSON
  content type instead of echoing the upstream one.

- `trust proxy` is configured (default `loopback`, override with `TRUST_PROXY`).
  Without it `req.ip` was the reverse proxy's address for every request, so the
  login and public-API rate limits shared a single bucket for all traffic — one
  client could lock out everyone, and per-IP brute-force protection did not exist.
  `isSecureRequest` now reads `req.secure` instead of trusting `X-Forwarded-Proto`
  from any client.

- The rate-limit table is bounded. Keys are attacker-chosen (an email address, an
  IP), and nothing evicted them, so a stream of unique login attempts grew the map
  until the process ran out of memory.

- Filesystem cache entries are keyed by a hash rather than by a lossy transform of
  the key. `/foo-bar`, `/foo.bar`, and `/foo/bar` all wrote to the same file, so
  anyone able to create content could choose a colliding slug and take over another
  page's cached output for the TTL. Namespace invalidation still works by prefix.

- The `?submitted=` form confirmation no longer bypasses the page cache on demand.
  It is constrained to a valid form id and honoured only with a same-origin
  referer; previously any visitor could append it to any URL and force a full
  render on every request.

- Session tokens can be revoked. A `token_version` counter (migration
  `0006_session_revocation`) is embedded in the token and compared on every
  request, and logging out now bumps it — previously logout only cleared the
  cookie and a captured token stayed valid for its full 14-day life. Sites where
  the migration has not yet run keep working without revocation rather than
  signing everyone out.

- The CSRF token is derived from the session (`HMAC(APP_SECRET, userId)`) instead
  of being a random value compared against itself. The old double-submit check only
  proved the caller could read a cookie on the domain, so anyone able to set one —
  through a subdomain they controlled — could forge both halves. `POST /api/auth/login`
  is no longer exempt, closing login CSRF; the login page is issued a token with
  its HTML.

- Public form submissions are rate limited per IP, and the `Reply-To` derived from
  submitted data must be a well-formed address with no CR/LF — the installed
  nodemailer has open header-injection advisories, so this is validated here rather
  than relied on downstream. Mail subjects are stripped of line breaks.

- Analytics records at most 200 distinct referrer hostnames per day, counting the
  rest as `other`. The hostname comes from the visitor's `Referer`, so the set was
  unbounded and attacker-chosen.

- Uploads are checked against magic bytes for the declared MIME type. `file.mimetype`
  comes from the client's own `Content-Type` part header, so arbitrary content could
  be stored under an image extension. PDFs in `/uploads` are served with
  `Content-Disposition: attachment` rather than rendered in the site's origin.

- `esc()` escapes apostrophes, and the hero block's `background-image` uses double
  quotes inside `url()`. A media URL containing `'` could previously close the
  CSS function and append declarations.

- Database connections use TLS by default whenever `DB_HOST` is not localhost.
  Neither driver negotiated it, so a managed database was reached in cleartext.
  `DB_SSL` forces it either way; `DB_SSL_REJECT_UNAUTHORIZED=0` allows a
  self-signed server certificate.

- The install wizard requires a one-time setup key. Until setup completed, anyone
  who could reach the site could claim it and become the administrator, and the
  connection step doubled as an unauthenticated port scanner. The database error
  is now uniform, the host and database name are URL-encoded like the credentials
  already were, and the key is checked before any connection is attempted.

  The key is written to `install-token/TOKEN.txt`, so it can be read with the same
  FTP client or File Manager used to upload the release — shared-hosting customers
  have no terminal and no way to see a server log. The folder ships an Apache deny
  rule, Node never serves it, and it is deleted once setup completes. The key is
  also printed to the log for VPS and Docker operators, and requests from
  localhost are exempt so local development is unaffected.
  `JUSTFLOWS_INSTALL_TOKEN` supplies your own for automated provisioning;
  `JUSTFLOWS_SKIP_INSTALL_TOKEN=1` opts out.

  Install state is also confirmed against the `sites` table at boot, so an
  instance that loses its `.env` cannot reopen the wizard on a live database.

- `sanitizeCustomCss` normalises CSS escape sequences and comments before matching.
  `@\69 mport` and `url(\6a avascript:…)` mean the same thing to a browser as their
  plain spellings but sailed past a literal blocklist. It is still a blocklist —
  the allowlist is on the theme-mod path, which is where editor input actually
  reaches `theme.css`.

- Password verification reads the iteration count from the stored hash instead of
  assuming a constant, so raising the work factor no longer invalidates every
  existing password. The factor is raised to 600,000 (OWASP guidance for
  PBKDF2-HMAC-SHA256) and old hashes are upgraded transparently on next login.
  The minimum password length is now 12, in the installer and at registration.

- The WordPress importer uses `requireRole` like every other route, instead of
  reading the session token directly — a demoted or deleted administrator kept
  import rights until their token expired.

- The admin UI attaches its CSRF token only to same-origin requests. The global
  `fetch` wrapper previously added it to every non-GET request regardless of
  destination.

- Rich text rejects protocol-relative URLs (`//attacker.example`), which
  `sanitize-html` permits by default and which bypassed the scheme allowlist
  entirely. `sanitizeHref` matches the scheme without requiring `//`, so `mailto:`
  links work — every one of them was being rewritten to `#`.

- The SMTP password is encrypted at rest with AES-256-GCM under a key derived from
  `APP_SECRET`. This does not defend against a compromised server, which already
  has the key; it defends against a database backup or a read-only disclosure
  handing over a working credential. Values stored by an earlier release are read
  as plaintext and re-encrypted on the next save.

- `/.well-known/security.txt` (RFC 9116) points at `security@justflows.com`.

- CI gained a dependency audit that fails on high or critical advisories, a CodeQL
  scan with `security-extended`, and dependency review on pull requests.

### Fixed

- The admin sidebar reads the installed version from `package.json` instead of a
  hardcoded `v0.1.1`.
- Signing out no longer clears the CSRF cookie without replacing it. Client-side
  navigation to `/login` then posted without a token and failed with "Invalid
  CSRF token". Logout now issues a fresh anonymous token, and the login page
  asks `/api/auth/csrf` if the cookie is missing.
- Structured-data `description` is no longer HTML-encoded before being placed in
  JSON, so `&` and quotes reach consumers as written instead of as `&amp;`
- `nodemailer` in `apps/server` was pinned to `^7.0.13` while the root manifest
  declared `^9.0.5`; the workspace resolved to the older, vulnerable copy. Both now
  resolve to 9.0.5, and `sharp` to 0.35.3, clearing both high-severity advisories.

- `npm run install:all` no longer crashes npm 12 arborist
  (`Cannot read properties of null (reading 'matches')`) when a pnpm
  `node_modules` tree is present. Production hosting patches also keep the
  dependency versions from `package.json` instead of pinning stale ranges.
- The install wizard no longer hangs on "Connecting to database…" when the
  server cannot boot. `/api/install` errors are shown in the UI, gzip no longer
  buffers server-sent events, and the production server bundle inlines
  `@justflows/*` so Passenger does not need `node_modules/@justflows/core`
  before `npm install` finishes.
- The site wizard no longer runs while first-run dependencies are still
  installing. `/install` waits (or returns to the bootstrap page) until files
  are ready; `/api/install` is only posted after the last wizard step.
- `install-token/TOKEN.txt` is written when Node starts, not only when the
  install POST checks the key, so the File Manager folder exists before the
  admin-account step.

## [0.1.1] — 2026-08-22

### Added

- Persisted custom content types and fields (PostgreSQL, MySQL, and MariaDB)
- Public `/api/v1` REST surface with OpenAPI, CORS, and rate limiting
- Built-in SEO: titles, canonicals, Open Graph, JSON-LD, sitemap, and robots.txt
- Plugin and theme author documentation
- CI quality gate for core packages, installer contracts, and admin axe checks

### Fixed

- Core zip updates continue when multilingual unique indexes are already applied

## [0.1.0] — 2026-08-20

### Added

- Community Edition of the Justflows platform: unified Express server, admin UI, and public site
- Browser install wizard with PostgreSQL, MySQL, and MariaDB support
- Plugin, theme, and CSS-provider installation via `.jfpkg`
- Typed SDK and plugin API for extension authors
- Docker Compose variants and shared-hosting install scripts
