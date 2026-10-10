# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [0.3.5] [UNRELEASED]

### Added

- **Widget areas: sidebars that plugins and themes can fill.** Appearance → Customize → Widgets edits each area as blocks, with draft and publish, and lets each language replace the blocks shown in every language. Choose per content type which area shows and where: left, right, or above the content. Core ships a `sidebar` area; themes declare more in `justflows-theme.json` (`widgetAreas`, defaults in `widgets/<key>.json`) or place one with the `core.widget-area` template block, and plugins add areas with default blocks and content types through the `widgets.areas` filter. Also available through the management API and MCP tools (`widget_areas_*`, `widget_layout_update`). The `widgets` plugin API namespace is now reserved for core.

- **Set Cache-Control per content type or individual post.** Inherit site settings, disable caching, or configure a validated header. Per-post overrides live under Advanced and follow drafts and revisions. Mandatory private types have no override control. Policies govern live pages, shared page caches and static exports. Adds migration `0046_content_type_cache_control`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Customize frontend account pages in the page builder.** The core `account` content type seeds a default page with editable headings, layout and account-section blocks. Personal data stays request-scoped. Authentication and exclusions from caches, public APIs/search, sitemaps and static exports follow the content type, including renamed URLs and pagination. Adds migration `0045_account_pages` for existing sites. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Workspace owners have a frontend account.** `/account` on the root site lists only the signed-in owner's workspaces, sites, subscriptions and resource limits. Owners can rename workspaces and sites, create sites within their plan's allowance and access each site's sign-in. Root owners land here after login; no root admin access is required. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Show the workspace's root owner.** Workspace details display the owner's name, email and user ID with links to their user page. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Plugins can set limits for another workspace or site.** `ctx.quotas.set(key, limit, { tenantId } | { siteId })` and `ctx.quotas.get(key, target)` reach a given workspace or site, with `platform:tenancy` and only from the installation's root site; `ctx.quotas.meters()` lists every meter. Calls without a target behave as before. Shop's subscription plans use this to apply platform limits to a subscriber's workspace.
- **New workspaces name their administrator to platform plugins.** The `tenancy.workspaceCreated` action carries `workspace.created`'s fields plus the first administrator's email; listening requires `platform:tenancy`, so `workspace.created` stays free of personal data. Shop uses it to give new workspaces a default plan.
- **Plugins can take back a role they gave.** `ctx.users.removeRole(target, role, actor)` removes one of the plugin's own additional roles, never the primary role (`users:manage`). Shop uses it when a membership subscription ends.

- **Measure local and external storage for the platform and each website.** Diagnostics and Platform → Website show media, private files, and static exports, with local/external totals and a separate logical record total. Physical usage includes staging, trash, retained exports, and earlier private-storage connections. Measurements run in the background; unreadable storage stays unknown. Adds machine-readable storage snapshots to the root diagnostics and site APIs. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Enforce a combined storage allowance per website.** The `storage.bytes` limit, editable as Total storage in site Limits and Platform Defaults, caps local plus external physical bytes. Media uploads and derivatives, private-file writes and storage copies, S3 trash/restore moves, and local/remote static-export writes check the remaining allowance under a database-backed site lock shared across workers. Existing files stay when limits are lowered; new growth is refused, and a configured cap fails closed when usage cannot be measured. Category limits still apply. Adds migration `0043_storage_quota_locks`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Static exports can use the existing S3 / OVH storage connection.** Tools → Static site export selects local files or object storage (`STATIC_EXPORT_STORAGE_DRIVER=local|s3`). Object storage reuses the installation’s `STORAGE_S3_*` connection without changing media storage. Each site has a separate export prefix based on its stable site id, so changing its domain preserves the exported files. Local output remains available for staging and preview. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))
- **Serve exported pages from a private bucket through the existing CDN origin.** The app signs S3 reads and streams exported public pages with their content type, cache policy, and conditional/range response headers, so Bunny can keep using the app as its origin. Admin, API and plugin routes, authenticated visits, query-string requests, and export crawls stay on the live app. Missing objects or storage failures fall back to live rendering. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

### Changed

- **Give plugin APIs neutral public URLs.** Plugins declare `apiNamespace` and use `ctx.http.url()` or the SDK’s `pluginApiUrl()` helper to expose `/api/<namespace>/…` URLs. The host preserves legacy aliases and the same site, authorization, CSRF, rate-limit and request-body policies. Shop’s frontend uses `/api/shop/…`, including checkout and private account actions. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Provide a default frontend user account at `/account`.** Every signed-in user sees core profile details and server-rendered sections from active plugins through the typed `account.sections` hook; root workspace owners also see their workspaces and initial limits. The former `/platform-account` URL redirects here. Account pages and APIs bypass browser, page, static-export, service-worker and proxy caching and send private/no-store headers. Shop contributes customer details, orders and subscription actions. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Publish object-storage exports only after uploads complete.** Content-hash HTML objects are uploaded before a single deployment pointer switches the served routes. Upload failures report an export failure and preserve the previous deployment. Removed routes stop being served from the export; old immutable objects remain until Clear export. Configured CDN caches are purged for the site after deployment. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))
- **Clear export also removes the current site’s deployed objects.** In object-storage mode, Clear removes the deployment pointer, exported objects, and interrupted uploads from that site’s reserved namespace, then clears its local output. Other sites, media uploads, and private plugin files are preserved. See docs/STATIC-EXPORT.md for configuration, storage layout, and origin behavior. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

### Fixed

- **Link workspace subscriptions to their root-site owner.** Workspaces retain their root billing user; Shop links a customer's single owned workspace when assigning or activating a plan and retries previously unapplied limits. Adds migration `0044_workspace_owner`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Workspace administrators also receive a root-site account.** Workspace creation creates a Subscriber account on the installation's root site for billing, including workspaces with isolated users or a separate database. Existing root accounts are reused without changing their password or permissions. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Check trashed media references without reloading every page and menu per file.** Trash listings load and serialize reference documents once per site operation. ([#108](https://github.com/JustFlows/justflows-ce/issues/108))
- **Batch permalink generation for lists, navigation, search, sitemaps, and exports.** Share permalink settings, category relationships, and locale-specific home resolution instead of querying for every link. ([#96](https://github.com/JustFlows/justflows-ce/issues/96))
- **Reuse SEO settings between page identity and metadata rendering.** Read related plugin settings together while retaining legacy values and locale fallback. ([#9](https://github.com/JustFlows/justflows-ce/issues/9))
- **Batch comment moderation and trash deletion writes.** Preserve per-comment audits, spam training, approval notifications, and cache invalidation. ([#50](https://github.com/JustFlows/justflows-ce/issues/50))
- **Batch historical revision pruning and reuse each site's retention setting.** Keep historical-only deletion guards and the existing prune limit. ([#65](https://github.com/JustFlows/justflows-ce/issues/65))
- **Avoid repeated content scans when building redirect history and legacy aliases.** Index identities and count alias sources once while retaining ambiguity checks. ([#100](https://github.com/JustFlows/justflows-ce/issues/100))
- **Avoid repeated manifest scans and deployment-pointer reads during object-storage exports.** Reuse indexed file metadata and one validated pointer read. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))
- **Read home, blog, and error-page selections once when deleting a content batch.** Home resolution also reuses an already loaded page when its locale and status match. ([#72](https://github.com/JustFlows/justflows-ce/issues/72))

- **Audit entries for accounts visitors create themselves.** A plugin creating a user without a signed-in actor (Shop's account creation at checkout) now records the audit entry with no actor; on PostgreSQL the empty actor id made the audit insert fail silently.

- **Identify pages served from object-storage static exports.** Exported responses include `X-Justflows-Render: static-export`, so operators can distinguish an exported page from live fallback and check Bunny's `CDN-Cache` header separately. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

- **Verify a domain's TXT challenge after its nameservers have switched.** Nameserver checks accept the exact `_justflows.<domain>` verification token at the authoritative DNS provider without requiring a switch back. Missing or incorrect tokens still fail; Justflows does not publish the challenge or permit DNS edits before ownership is proven. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Object-storage exports contain HTML only.** Images, media, styles, scripts, and other non-HTML resources keep their existing URLs instead of being copied into the export bucket. Full and incremental S3 exports stop downloading assets; the next successful deployment removes previously referenced duplicate asset objects from the export namespace without touching the original media. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))
- **Admin exports run in the background and report progress through status polling.** The Run action returns immediately instead of holding a request open throughout the crawl and uploads, avoiding long export requests timing out at a CDN or proxy. Unexpected HTML API responses now show an actionable message instead of a JSON parsing error. Existing synchronous CLI clients remain supported. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

- **Block access to export metadata through shared upload storage.** The `/uploads` handler rejects the reserved `static-export` namespace, including encoded paths, so deployment metadata and stored export objects cannot be fetched through upload URLs. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

## [0.3.4]

### Added

- **Plugins can attach files to emails.** `ctx.mail.send({ attachments: [{ filename, content, contentType }] })` sends up to 5 files (PDF, PNG, JPEG, CSV, plain text, calendar; 10 MB each, 15 MB together) through SMTP, sendmail, or a plugin transport (`message.attachments`). The delivery log keeps only their names, types, and sizes, so a delivery retried from the admin is sent without them. Shop uses this to send invoices and credit notes as PDF. See docs/EMAIL.md.
- **Private file storage for plugins.** `ctx.files` (permission `files:private`) stores files for one site that are never public, such as products sold as downloads, and a plugin route answers `{ file: { key } }` to have the host stream one, with `Range` support and without revealing the storage address. Settings → Storage sets an S3-compatible connection (AWS, OVH, Cloudflare R2, MinIO, …) on the root site for every site; a site may save its own when its plan allows `feature.ownStorage`; with it off, the Storage page is removed from that site's admin. Without one, private files go to the installation's `STORAGE_DRIVER=s3` bucket under `.private/` (not when `STORAGE_S3_PUBLIC_URL` makes it public; `/uploads` never serves that folder) or to `PRIVATE_STORAGE_PATH` on disk. Each site has its own folder. A changed storage starts a background copy of existing files; downloads keep working meanwhile. New limits `files.count` and `files.bytes` count private files per site. Adds migration `0042_private_files`. See docs/PLUGINS.md and docs/MULTISITE.md.
- **Plugin routes can take file uploads.** A route registered with `binaryBody: { maxBytes }` receives the raw request body as a `Buffer` (up to 1 GiB) instead of JSON, with CSRF and rate limits unchanged.
- **Plugins can read date ranges and page through their rows.** `ctx.databases.find()` accepts `range` (`gt`, `gte`, `lt`, `lte` per column) and `after`, a keyset cursor that continues after the last row of the previous page in `orderBy` order. Together they read any number of rows in a period, 500 at a time. Works on PostgreSQL, MySQL, and MariaDB. See docs/PLUGINS.md.
- **Plugins can read one published page with its blocks.** `ctx.content.getPublished({ type, slug, locale })` returns a published entry and its blocks, in the visitor's language when a translation is published, or `null`. It requires `content:read` and is optional on the SDK type, so plugins on older hosts keep working. Shop uses it for its shared product layout. See docs/PLUGINS.md.

### Fixed

- **Plugin admin pages can open PDFs in a new tab.** Tabs opened from a plugin's admin page no longer inherit its frame sandbox (`allow-popups-to-escape-sandbox`), so Chrome shows PDFs and printable pages there instead of blocking them (`ERR_BLOCKED_BY_CLIENT`).

## [0.3.3]

### Added

- **A website can connect its own domain.** Settings → Domains adds a domain by DNS records (a TXT check plus a CNAME) or, with Bunny DNS, by pointing the domain's nameservers at the platform. A background check verifies DNS, attaches the hostname, and issues the certificate before the domain is served. A connected domain can become the primary address, and the site's other addresses then redirect to it. A domain that is never verified is released; one that stops pointing here is no longer served. With nameservers, the website manages its own MX, TXT, and other records. Adds migration `0039_custom_domains`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Offer custom domains as a paid feature.** Platform → Custom domains turns the feature on, chooses Bunny.net or this server, sets your own nameservers, and holds an upgrade link. Each website's access comes from the limits `feature.customDomains`, `domains.custom`, and `feature.managedDns`, which Defaults and plugins can set per plan. Plugins with `platform:tenancy` can refuse a domain with the `domain.beforeAdd` gate and react to `domain.added`, `domain.activated`, `domain.failed`, and `domain.removed`. `/api/domains/tls-allowed` answers Caddy's on-demand TLS check. See docs/MULTISITE.md. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

- **Dropdown plugin settings from core lists.** A plugin setting can be a `select`, with its own choices or with `optionsSource: "timezones"` or `"countries"`, filled in from the same lists as Settings → General. Saving refuses a value that is not listed. Core now has one ISO country list. Plugins can read the site's time zone and that country list with `ctx.i18n.timeZone()` and `ctx.i18n.countries()`. See docs/PLUGINS.md.
- **Plugin jobs can run for every site.** A job registered with `perSite: true` runs once for each site where the plugin is active, inside that site's context and database, and receives `siteId`. One site's failure does not stop the others. Background jobs are now described in docs/PLUGINS.md.
- **Plugins can write their tables atomically.** `ctx.databases.transaction()` runs several row calls as one transaction, and `insert()`, `update()`, and `increment()` give plugins a unique-key claim, compare-and-set, and a guarded counter in one statement. `find()` and `findOne()` accept `orderBy` and `lock`. Works on PostgreSQL, MySQL, and MariaDB, on the shared database or a plugin's separate one. See docs/PLUGINS.md.

### Changed

- **Plugin row filters match `null` with `IS NULL`.** `ctx.databases.find()`, `findOne()`, and `delete()` used to compare `null` with `=`, which matched nothing. An invalid column name in a filter is now an error instead of being dropped from the filter.
- **Only active hostnames route.** A hostname a website is still verifying, or one that failed its checks, is not served. Hostnames that already existed, and ones an operator adds on a website page, stay active. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Connecting a domain by nameservers needs a TXT check first.** Add the `_justflows` TXT record at the domain's current DNS provider, then change the nameservers. A domain that already uses the platform's nameservers connects with DNS records instead. DNS records can be edited once the domain is verified. Adds migration `0040_security_hardening`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

### Fixed

- **Plugin admin pages keep their language and route after a reload.** The host delivers context when hydration attaches, even if the plugin iframe loaded before its handlers. Later language and catalog changes reach the frame too. ([#69](https://github.com/JustFlows/justflows-ce/issues/69))

- **Plugin updates accept dropdown settings.** The package installer now accepts `select` settings and preserves their fixed choices and core country or time-zone sources, allowing Shop 0.1.3 to install. Startup logs now report an active plugin's missing module or registration failure.

- **Transactions on a plugin's separate database.** A plugin's separate database ignored transactions and reported no changed rows; both now work as on the main database.
- **A website's settings stay inside that website.** Installation SMTP credentials are only used with the installation's own mail server, and a site that sends through its own server enters its own password. Only the main site can allow private AI provider addresses. Removing or reinstalling a theme, or switching CSS provider, on one site no longer changes the files another site uses. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Plugin routes answer only on sites where the plugin is on**, and a sign-in only counts on the site it was made for. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **A site that cannot be looked up is not served.** When the site list, a site's own database, or its plugin list cannot be read, the request gets a temporary error instead of single-site behaviour. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Managing users does not grant more access than you have.** Someone with user management can assign roles, custom roles, permissions, and scopes only within their own access, and cannot change or remove an administrator. A permission they hold only partly, such as for their own content, cannot be given to anyone else. API keys are limited to their own permissions and scope.
- **Uploaded packages must be pinned or marketplace-signed.** A signature inside the package's own manifest is no longer accepted.
- **Outbound requests check the address they connect to.** Webhooks, AI providers, and agent downloads refuse private addresses in every IPv6 form, at connection time. A webhook response is read only up to a small limit and within the delivery timeout.
- **Uploads are bounded.** Each site has a limit on uploads in progress, oversized uploads are refused before and while they are read, uploads accept only a few small form fields, image processing runs a few at a time, and generated image sizes count toward media limits from the moment the upload is accepted.
- **Static export only crawls the site being exported.** A website other than the main site cannot choose the address the exporter connects to, and the exporter reaches the site through this application rather than the site's own DNS. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Removing an unverified domain leaves the CDN alone.** Only a hostname this installation attached is detached when a domain is removed or expires. Adds migration `0041_domain_provider_attachment`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Dependencies:** multer 2.4.0, qs 6.16.0, ip-address 10.7.3, and esbuild 0.25.12 for drizzle-kit.

## [0.3.2]

### Added

- **Turn site features on or off, and cap each kind of content.** A website can limit users, posts of each type, custom content types, media files, media megabytes, plugins, and custom roles. It can also turn off comments, theme upload, design, roles, responsive images, security sections, PWA, redirects, and the other site admin sections. Off hides that menu and blocks the feature. An empty number means no limit. A feature left on stays available. Defaults copy onto a website when it is created. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Set the limits a new workspace or website starts with.** Platform → Defaults stores a number for each limit. Content types a plugin has already created, such as a shop's products, are included. A new workspace and a new website copy those numbers when they are created. An empty field means no limit. Workspaces and websites that already exist keep the limits on their own pages. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Platform has its own place in the admin menu.** Workspaces and Sites are the tabs at the top of that section. Settings no longer includes Platform. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Assign limits to a workspace or a website.** A platform operator sets how many sites a workspace may have, and how many users, content entries, and megabytes of media a website may have. An empty field means no limit. New items are refused at the limit; existing items stay. Plugins register their own meters and call `ctx.quotas.check` before they create a record. A plugin with `platform:tenancy` can set the same limits. See docs/MULTISITE.md. Adds migration `0038_quota_limits`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

### Fixed

- **Remove a workspace even when its separate database was never provisioned.** Permanent deletion tolerates missing site or workspace tables and an already missing separate database, then removes the workspace from the platform database. Other database errors still stop deletion. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Turning a plugin off on another site clears that site's plugin menu.** Shop screens such as Import products stayed under Extensions after deactivate because the shared module was not unloaded and a short admin-app cache kept those routes. That site's menu now drops inactive plugins immediately. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Turning a plugin off on another site can delete that site's plugin data.** Another site cannot uninstall a plugin. When `deleteDataOnUninstall` or `deleteContentOnUninstall` is on, deactivate there runs the same site-scoped cleanup as a remove: the `deleteData` hook, owned pages and posts, and that site's rows. Tables stay for other sites. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **A turned-off site feature removes its control.** Create user roles, custom theme upload, the assistant, and responsive image tools stay out of that website's admin when the switch is off. The server still refuses the action. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Saving the signup database updates the connection workspaces already use.** Changing the host, port, database name, or username on Platform → Workspaces writes that connection, and workspace rows that still point at the previous one pick up the new values. Test connection checks the login. A signup that cannot reach the database does not leave a workspace behind. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))

## [0.3.1]

### Fixed

- **An update comes back after it restarts.** The update installed dependencies from a lockfile that named sharp's Linux binary but did not include the file, then restarted. The new process could not start, and the site stayed on the temporary error page. The update now installs that binary for the machine it is running on before it restarts. Release archives lock the binary as well, so a later install can find it.

## [0.3.0]

### Added

- **A full-admin agent can edit the whole site.** MCP tools now cover the header library, the footer, page templates, theme appearance, reusable blocks, patterns, error pages, permalinks, trash, analytics, comment rules, cookies, and email templates. A page's header is set with `content_set_header`. Each tool calls the management API with the same capability check as the admin. A full-admin key sees every one of these. Zip uploads, webhook secrets, API keys, and applying a core update stay in the admin. ([#159](https://github.com/JustFlows/justflows-ce/issues/159))

### Fixed

- **Theme and plugin images use the responsive variants.** A shop card, a theme HTML tile, or any other plugin image that points at an upload is now served as AVIF or WebP, with a sized JPEG fallback, the same way an image block is. A hero background is included. Turning responsive markup off in Tools still serves the original. ([#103](https://github.com/JustFlows/justflows-ce/issues/103))
- **An uploaded theme keeps its Customizer section.** Controls declared in the theme package show in the Customizer, and the block inspector shows the fields that package named. The theme's own colours, fonts, and sizes are the starting values. A theme already installed picks this up from its package without being uploaded again. ([#165](https://github.com/JustFlows/justflows-ce/issues/165))

## [0.2.9]

### Added

- **A plugin can be offered to other sites.** On Plugins, the main site turns on “Allow on other sites” for each plugin. Another site can then activate or deactivate it. It is not turned on there until that site does so. That site cannot install a plugin, open the Marketplace, or remove a plugin. Only the main site can remove one. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Edit a website from Platform.** A platform operator opens a website from the workspace list. Its page shows the site id and the website's name, description, address, domains, status, and database connection. Those fields can be changed there. Moving a website onto a different database stays a separate step. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Manage a website's users from Platform.** The website page links to a Users page where a platform operator lists, adds, edits, and removes that site's accounts, changes their role, and sets a new password. It works for websites with isolated users and on a separate database: the accounts are read from and saved to the database that website uses. If that database cannot be reached, the page says so and changes nothing. Each change is logged in the website's audit log and in the platform audit. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Remove a deleted website completely.** On Platform, a website that is suspended or already marked deleted can be removed at once. Pages, users, and files go with it. A shared database is not dropped. The same cleanup runs on its own after a number of days set on that page. 0 leaves deleted websites in the list until they are removed there. The platform workspace cannot be removed. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Delete a customer website from its settings.** An administrator of a site created later can delete that website under Settings. They confirm by typing the hostname. The platform site cannot be deleted this way, and a shared signup database is left in place. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Multi-site workspaces with a database choice.** One installation can serve many hostnames. Each workspace uses the current database or a separate database, with isolated users or shared users and per-site roles. Unknown hosts are refused. Platform operators suspend and reactivate a workspace without affecting the others. Public signup assigns `slug.example.com` on the current database. A separate database is chosen only by a platform operator who supplies the connection. Plugins read the current workspace and, with `platform:tenancy`, create and manage workspaces through `ctx.tenancy` and `/api/manage/v1/tenants`. See docs/MULTISITE.md. Adds migration `0037_tenancy`. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Store uploads in S3, R2, or MinIO.** `STORAGE_DRIVER=s3` now stores media in an S3-compatible bucket, signed with AWS Signature V4. Set `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`, and `STORAGE_S3_ENDPOINT` for anything other than AWS. The older `S3_*` names are still read. Media URLs stay `/uploads/...`: Justflows streams them from the bucket, or redirects to `STORAGE_S3_PUBLIC_URL` when set. `STORAGE_S3_PREFIX` lets several installs share a bucket. `pnpm storage:sync` copies existing local uploads into the bucket. Before this, the setting was read but ignored. See docs/MEDIA.md.

### Fixed

- **A manual restart no longer tells every host to use Plesk.** On this kind of server the notice says to restart the Justflows service. Plesk is mentioned only when the app is running under Passenger.
- **Saving performance settings finishes the restart.** The save stopped the app and systemd started it again, but the page only watched a health check that stays unfinished until the app has loaded, and it gave up before that. It then said to restart the app in Plesk. The app now loads as soon as the process starts, and the page waits until that load has finished.
- **An update reloads the running app.** Applying an update, or saving the server cache, only asked Phusion Passenger to reload. A site started by systemd kept serving the previous version. Justflows now restarts itself under systemd, Docker and other containers, Kubernetes, PM2, forever, supervisord, OpenRC, s6, runit, launchd, nodemon, and a Windows service. When nothing is supervising the process, it starts the app again.
- **A sub-site uses its own name and pages.** The public site read the first website in the database, so a sub-site showed the workspace name in the browser title, header, and description, and could serve that website's pages, comments, and mail name. Those now come from the website the visitor opened. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Deactivating a plugin removes its admin pages from that site.** Shop stayed active on the main site, and its screens (Import products, Bulk edit, Attributes, and the rest) stayed in the top menu of a site that had turned Shop off. That site's menu now lists only plugins that site has turned on. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Activating a plugin on the main site creates its tables in every site database.** Shop tables were created only in the main site's database, so a site on its own database had none. The main site now creates those tables in each site database when the plugin is activated there, and again when the server starts with that plugin already active. Another site still cannot create or delete them. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Another site shows the plugin version the main site installed.** A site on its own database kept the copy from when the plugin was first offered, so Plugins there still said Shop 0.1.1 after the main site updated to 0.1.2. That site now shows and activates the main site's current package. It stays off until that site turns it on. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **A website on the platform domain is a subdomain.** Opening it from Platform showed the domain kind as custom. A hostname under the signup domain, such as `dirkswebsite.justflows.com`, is a subdomain. A hostname outside that domain stays a custom domain. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **A customer site can turn static export off.** Tools on that site has its own switch. Turning it off stops new exports and automatic rebuilds of that website. It does not change the installation, and files already exported stay until that site clears them. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **An agent stays on the website it was connected to.** The MCP address shown in the admin is that site's own `/api/mcp`. A key or sign-in for one website is refused on another, so it cannot read or change the other site. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Customer sites no longer show the server folder or the recovery environment variable.** Clearing a static export says it removes this website's export. The admin-path recovery instructions stay on the platform site. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **CDN settings stay on the platform site.** A customer site can clear its own cached pages. It cannot change the CDN connection. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **A saved page shows on the public site without waiting for the CDN.** When revalidation clears pages, content, menus, theme, CSS, or site context, the CDN drops that site's cached pages as well. Each site connects its own CDN under Settings → CDN, where it can test the connection and purge the site by hand. Bunny.net is the first provider. The API key is encrypted and is not shown again. `BUNNY_API_KEY` and `BUNNY_PULL_ZONE_ID` still apply to every site without its own connection. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **The admin sidebar on a customer site.** Every admin page asked the installation for updates, which a customer site is not allowed to see, so the browser reported 403. The sidebar now receives only the installed version. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **A site icon shows on the public site.** The public page was kept at the CDN for 30 days, so the icon saved in the admin never appeared on the website. Public pages are no longer stored there unless browser cache is turned on. A customer site's address no longer replaces the installation address. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Each site keeps its own object cache.** Menus, theme, and published pages were stored under keys that omitted the site, so one site could be served another's cached page. Those entries now include the site id and are written to `.cache/<siteId>/`. Removing a website removes that folder. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Installation settings stay on the platform site.** Static export and responsive-image settings are written to the installation `.env` and apply to the whole process. A customer site no longer shows those forms. Its export still runs into its own folder. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Public signup can use a separate database.** Platform → Public signup stores one database connection. Every new signup creates its workspace there, and this installation keeps the platform site and the routing. The password is encrypted and is not shown again. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Signing in at a renamed admin address.** The redirect from that address back to the login page was cached, so a correct password and authenticator code landed on the login page again. That redirect is no longer cached. ([#51](https://github.com/JustFlows/justflows-ce/issues/51))
- **Each site keeps its own admin address.** The custom admin path was remembered for the whole installation, so a customer site's `/admin` showed the under-construction page after the main site moved to another path. Each site now uses only the path saved on that site. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Public signup from another site.** Creating a workspace through `POST /api/signup` no longer requires the admin CSRF cookie. The marketing site can submit the form. Signup stays rate limited. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Public signup settings on PostgreSQL.** Saving the signup domain stored the JSON as a string, so Platform showed an empty form after refresh. The saved domain is read back into the form. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Plugins and themes on PostgreSQL.** Saving a plugin wrote `0` into the boolean `safe_mode` column, so the plugins and themes pages failed before they could reach the Marketplace. Language defaults had the same integer/boolean mismatch.
- **Fresh PostgreSQL install.** The consolidated baseline indexed `audit_log.occurred_at` before that column existed, and three later tables used `varchar` foreign keys against `sites.id` and `users.id`. A new PostgreSQL database can finish installation. The matching columns are added in the compatibility step, and those foreign keys are `uuid`.
- **Admin menu on a second site.** The sidebar stayed on Dashboard because the signed-in role was loaded from `127.0.0.1`. That address is not a site once another hostname exists, so every other menu item was hidden. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Installation pages stay on the main site.** Updates, diagnostics, platform, and the server cache are hidden from a site created later. That site keeps its own content, users, and settings. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Each site's files stay in its own folder.** Trashed media moves into `uploads/<siteId>/.trash/` instead of a shared trash; items trashed earlier still restore. A static export from a second site crawls that site's hostname and writes to `static-export-sites/<hostname>/` instead of the main site's `static-export/`, and auto-rebuild queues each site separately. "Save as new theme" forks go to `packages-installed/sites/<siteId>/themes/`. The `STATIC_EXPORT_*` settings can only be changed on the main site. See docs/MULTISITE.md. ([#23](https://github.com/JustFlows/justflows-ce/issues/23))
- **Deleting a saved theme.** Deleting a theme made with "Save as new theme" failed with "Theme install path is invalid".
- **Trashed media could be downloaded through Apache.** The generated root `.htaccess` now refuses `.trash` paths; existing installs pick it up on their next start.

## [0.2.8]

### Added

- **Connect Claude, ChatGPT, Cursor and other AI agents over MCP.** Justflows now runs an MCP server at `/api/mcp`, switched on under Settings → API ("Let AI agents connect over MCP"). It also needs the management API switch. Cursor, Claude Code, Claude Desktop and VS Code connect with an API key. claude.ai and ChatGPT connectors sign in through OAuth 2.1 and a Justflows consent screen where the user can narrow the permissions. Settings → API → Connect an AI agent shows the MCP URL, creates a key with a Content editor, Full admin, or Read only preset, gives copy-ready setup for each client, and warns when the site is not on public HTTPS. Connected apps lists OAuth grants with last use and one-click revoke, under Settings → API for administrators. See docs/AI.md. ([#159](https://github.com/JustFlows/justflows-ce/issues/159))
- **MCP tools come from the management API.** Agents can discover the site, its content types and blocks, and create, edit, schedule, publish and trash content of any type. They can upload media from a URL and set alt text, manage menus, moderate and reply to comments, manage content types, change settings, languages and redirects, activate plugins and themes, clear the cache, and run a static export. Each tool calls the management API handler in-process with the same capability and scope checks. A session sees only the tools it can use, and users & roles tools stay off unless the key or grant turns them on. Agent-written blocks are validated against the block registry. New entries are drafts, and updates need the current version. Every agent change is audit-logged, and revision history shows "via Claude". Plugins add tools through the new `mcp.tools` filter (SDK: `McpToolDefinition`). ([#159](https://github.com/JustFlows/justflows-ce/issues/159))
- **Bring your own AI key: an assistant in the admin.** Settings → AI stores site-wide Anthropic, OpenAI, or OpenAI-compatible (OpenRouter, Azure OpenAI, Mistral, Groq, Ollama, LM Studio) keys. The API also supports personal keys for users with the new `ai:use` capability (administrators and editors by default); these take precedence for them. Provider configuration lives only under Settings → AI, with no AI controls on Security → Account. Keys are encrypted, write-only, and never sent to the browser. The assistant panel streams answers, uses the same tools as the MCP server as the signed-in user, runs read-only tools automatically, and asks for approval with a before/after preview before every change. The content editor's AI menu rewrites, shortens, or expands selected text, writes the excerpt and SEO metadata, writes image alt text, drafts from a brief, and translates into a linked draft. Every suggestion is reviewed before saving. Optional per-user daily limit. Conversations stay in the browser. Adds migration `0036_ai_byok`. ([#159](https://github.com/JustFlows/justflows-ce/issues/159))
- **Management API: media details and content search.** `PATCH /api/manage/v1/media/{id}` changes alt text, caption, and focal point. `GET /content` accepts `search` and `author` filters. ([#159](https://github.com/JustFlows/justflows-ce/issues/159))
- **Bulk edit from a plugin's content list.** When a plugin lists a content type (like Shop → Products) and ships a `{path}/bulk-edit` admin page, selecting rows shows a "Bulk edit" button next to Delete. The selection is handed to the plugin page through `sessionStorage` (`jf.admin.bulkSelection`). An `adminApp` route nested under one of the plugin's own pages (for example `products/bulk-edit` under `products`) no longer needs its own `adminMenu` entry: it stays out of the sidebar and uses the parent page's section.
- **Plugin and theme updates.** Plugins, Themes, and Marketplace show "Update available" when the Marketplace has a newer build that works with this version of Justflows, with an "Update to vX" button and "Check for updates". An active plugin is switched to the new build without a restart. If the new build fails to activate, the plugin is marked as an error and the reason is shown. Each plugin or theme has an "Auto-update" switch: a background job checks twice a day and installs updates within the same major version. Major updates wait for an administrator, and `JUSTFLOWS_DISABLE_AUTO_UPDATE=1` turns automatic updates off. Beta builds are only offered when beta installs are allowed. Updates go through the same signature, digest, and commercial-listing checks as installs, and are audit-logged.

### Changed

- **Database migrations `0001` through `0036` are consolidated into one `0036_baseline` file per dialect,** down from 51 files to 3. Fresh installs run the full baseline. Existing sites run only the parts of the baseline they have not recorded yet: a site on `0012_baseline` or any later migration skips everything it already applied, so earlier steps (like the `user_role` enum that `0034` removes) are never replayed. The baseline is then recorded once in `_migrations`, and later schema changes continue at `0037`.

## [0.2.7]

### Added

- **Polish, Ukrainian, and Russian.** Added public-site and admin interface translations, including navigation, comments, search, app installation prompts, and error and maintenance pages. All three languages are available in the admin language selector and server-rendered admin pages. Ukrainian and Russian are also offered in the installation language picker.

- **Demo mode.** The Demo mode plugin adds a Demo role and a demo sign-in for trying the site. That account can edit content. It is not an administrator, so settings, users, plugins, and themes stay closed to it, and the plugin never edits the administrator account. On a schedule it deletes the content, media, and comments that demo user created, then asks the plugins an administrator selected to restore their own data through the `justflows.demo.targets`, `justflows.demo.snapshot`, and `justflows.demo.restore` hooks.
- **SDK: `ctx.content.deleteCreatedBy(userId)`.** Permanently deletes content that user authored, media they uploaded, and comments they wrote, and drops their unpublished working revisions on other entries. It does not delete the user, and it refuses an administrator. Requires `content:delete`.
- **Placeholder images.** Justflows ships neutral placeholder images for a generic image, a featured image, a thumbnail, an avatar, and the social share image. Featured Image and Post List show the placeholder when a post has no image, an Image block without an image shows the generic one, and a page with no share image falls back to the site logo and then the share placeholder. Settings → Placeholders replaces any placeholder with your own image or turns them all off, and Featured Image and Post List can each turn them off. `og:image` is now an absolute URL.
- **SDK: `ctx.media` placeholders.** `ctx.media.placeholder(kind)` and `placeholderHtml(kind)` return the site's placeholder from a block's `render()`. `ctx.media.registerPlaceholder()` ships a default for a plugin's own kind, and the `media.placeholder` filter replaces or clears one. See docs/PLUGINS.md.
- **Shop page.** `/shop` lists published catalog products. A sidebar can hold search and category and tag filters. Products show in a grid by default, or as a list. Commerce → Shop page turns the sidebar, search, each filter, the default layout, and the visitor layout switch on or off.
- **Shop blocks choose from the catalog.** Product list and Related products show all products, products related to a product, products you pick, or products from chosen categories or tags, with a sort order and a product count. Gallery, Buy box, Breadcrumbs, and the details accordion can show a picked product on any page. Breadcrumbs follow the product's category, and every shop block field has a label and help text.
- **SDK: richer plugin block fields.** A block schema field can set `label`, `help`, `optionLabels`, `optionsUrl` (choices loaded from a same-origin route), `multiple` (a checklist saved as a string array), and `showWhen` (hide the field unless another prop matches). See `PluginBlockField` and docs/PLUGINS.md.
- **Product pages sell the catalog item.** A product detail page shows that product's price, stock, and variations. Choosing an option such as size updates the price, SKU, and stock, and Add to cart stores the selected variation. Related products come from the catalog. The product template no longer repeats the blog title and date.
- **Shop cart page.** `/shop/cart` lists each product with its photo, options, unit price, and line total. Quantities can be changed or removed, the subtotal follows the catalog tax display, and checkout stays closed until every line can be sold. Shipping is left for checkout. The cart template no longer shows the blog date and excerpt.
- **Shop checkout page.** `/shop/checkout` collects contact, shipping, and billing, then prices delivery, tax, and discounts from the shop settings. Country lists follow the selling and shipping countries. Guest checkout closes when the shop requires an account. Enabled payment methods are offered without collecting card details, and a placed order is stored as awaiting payment.
- **Shop registers a Customer role.** Activating the Shop plugin adds a `customer` user role with no administration access. It appears in New User Default Role, user invites, and the user editor, and can be the role new registrations receive. Deactivating Shop removes it from those lists.
- **Shop → Customers can add a customer.** The form collects the sign-in account, phone, company, tax ID, invoice address, and shipping address. The new account is also created under Admin → Users with the customer role. Plugins that declare `users:manage` can create users only in a role they registered.
- **Shop → Customers can edit a customer.** Open a customer to change their name, phone, company, tax ID, invoice address, and shipping address. The sign-in address stays on the user account.
- **Shop → Customers can import customers.** CSV, JSON, and XML files create or update customers, including invoice and shipping addresses. A new email also creates a user with the customer role. A matching email updates the shop record and leaves the existing sign-in alone.
- **Shop → Payments connects the provider accounts.** Turn on Stripe, PayPal, Mollie, Adyen, Square, bank transfer, cash on delivery, or check. Sandbox and live secrets stay in plugin secrets and are not returned to the browser. The page lists payment attempts, captures, cancellations, refunds, and disputes. Another plugin can add a gateway, including Justflows Payments, through the `justflows.shop.payments.gateways` filter.
- **Shop → Payments has a page per provider.** Open Mollie and choose Mollie checkout or the methods active on that profile. Checkout offers one of those, not both. Each method is its own choice and sends the customer straight to that method. Payment method logos at checkout can be turned on or off.
- **Mollie payments include the shop order.** Starting a Mollie payment sends the Justflows user id, the shop customer and order ids, billing and shipping addresses, the visitor's language, a cancel link, and the order lines with tax. The ids are stored in the payment's metadata.
- **Shop → Shipping calls DHL, PostNL, and DPD.** Test connection asks DHL Express for live rates, PostNL for delivery options, and DPD to sign in and list pickup points. Sandbox mode uses each carrier's test host. PostNL and DPD do not return a contract price, so the rate on the zone is still what the customer pays for those two.
- **Shop → Shipping covers zones and carriers.** Add shipping zones by country, postcode, or the rest of the world, then offer flat rate, free shipping, local pickup, or a carrier service. DHL, DPD, and PostNL are included. Another plugin can add a carrier through the `justflows.shop.shipping.carriers` filter. Carrier API keys stay in plugin secrets and are never sent back to the browser.
- **Plugins can keep pages out of the static export.** The new `staticExport.exclude` filter lists paths the exporter leaves to the live app, such as a cart, checkout, or account page. Those paths are never crawled, even when linked. Copies from earlier runs are removed, and the generated `.htaccess` and `_nginx.conf` route them to the app. With `STATIC_EXPORT_ORIGIN_URL` set, links and form actions that point at them go to that origin. Shop uses it for its cart, checkout, order confirmation, customer account, and order tracking pages. See docs/STATIC-EXPORT.md. ([#24](https://github.com/JustFlows/justflows-ce/issues/24))
- **Admin → Users opens a user page.** Click a user's name or row to open `/admin/users/<id>`. The page shows the account ID, role, created and last-updated dates, whether two-factor sign-in is on, the user's effective capabilities, and their authored content with counts by status and links to the 10 most recently updated items. Editors with `users:read` can now open this page too, read-only. Administrators also see the user's 20 most recent audit entries, IP addresses included, and can download the user's personal data. `GET /api/users/:id` returns these fields.
- **Users can have additional roles.** A user keeps one main role and can also hold other built-in or plugin roles, such as a subscriber who is also a shop Customer. Tick them under Additional roles on the user page, or send `additionalRoles` to `PATCH /api/users/:id`. Additional roles only add capabilities. Admin-only checks and the last-administrator guard still read the main role, and Administrator can only be a main role. An author or contributor can still edit only their own content when the role is an additional one. Admin → Users shows the extra roles next to the main one. Adds migration `0035_user_additional_roles`.
- **Existing users can become shop customers.** Adding a customer in Shop → Customers, or importing one, with an email that already signs in now links that user and gives them the Customer role. Before, this failed with "already exists". Their password and main role stay unchanged. A signed-in user who places their first order also gets the Customer role. The other way round works too: anyone who gets the Customer role, as main or additional role, from Admin → Users, an invite, or sign-up, now appears in Shop → Customers.
- **SDK: `ctx.users.addRole()`, `ctx.users.get()`, and `session.roles`.** `ctx.users.addRole({ userId } | { email }, role, actor)` gives an existing user one of the plugin's own roles as an additional role. `ctx.users.get(userId)` reads a user with all their roles. Both need `users:manage`, like `ctx.users.create`. Plugin HTTP sessions now include `roles`, with the main role first. All three are optional on older hosts. See docs/PERMISSIONS.md.
- **Plugin errors show up in Diagnostics.** Every plugin's `ctx.logger.error()` call, every exception from a plugin hook handler, and every uncaught plugin route failure now lands in Admin → System → Diagnostics → Recent errors, tagged `plugin:<id>`. Plugins do not opt in and cannot opt out. A failing plugin route now also returns a `requestId`.
- **Beta installs from the Marketplace.** A plugin or theme can set `registry.beta: true` in `justflows.json`. Admin → Marketplace and Themes show a Beta badge on it. Install stays off until an administrator turns on Settings → Marketplace → Allow installing beta plugins and themes, and each beta install then asks for confirmation with a warning first. `POST /api/marketplace/install` enforces the same setting and returns 403 while it is off. SDK: `isRegistryListingBeta()`.
- **Shop publishes health checks.** Diagnostics shows whether Shop setup is complete and whether each enabled payment gateway has its credentials for the current mode.

### Changed

- **Core updates are verified by default.** Every release now ships `justflows.zip.sig`, an Ed25519 signature over the archive and its version, next to `justflows.zip`. Update, force reinstall, automatic updates, and uploads all refuse an archive without a valid signature. To upload a release by hand, select `justflows.zip` and `justflows.zip.sig` together. A pinned `JUSTFLOWS_UPDATE_DIGEST` or an HMAC made with `JUSTFLOWS_UPDATE_SIGNING_KEY` still lets an operator apply their own build. `JUSTFLOWS_ALLOW_UNSIGNED_CORE_UPDATES=1` turns the check off. An operator's `JUSTFLOWS_UPDATE_SIGNING_KEY` no longer blocks the Update button, because official releases carry their own signature.

- **Shop sandbox mode uses the PostNL shipping sandbox.** With Sandbox / test mode on, Test connection still asks PostNL for delivery options, and it also creates a confirmed shipment on the PostNL shipping sandbox and reads that shipment's status. Live mode does not create a shipment.

- **SDK:** A plugin declares CSRF exemption, a host rate limit, and raw-body capture on the `ctx.http` route itself (`PluginHttpRouteOptions`). The host applies that policy and no longer matches Shop cart, checkout, catalog, or payment-webhook URLs.

- **Theme layout targets come from the active plugin.** `theme.layoutScopes` adds a customizer layout section (content width and wide width) for a public prefix and the pages under it. `permalinks.typeBases` contributes that type's default permalink base. Core ships neither; deactivating the plugin removes both. Shop registers Product (`/product`) and Shop (`/shop`) while it is active.

- **Plugin content lists show one row per item.** A menu page such as Shop → Products lists the site's default language only. Other translations stay on the content editor, where the language switcher already lives.

### Fixed

- **Inactive plugin roles temporarily use the default role.** Stored primary and additional role assignments are preserved when a plugin is disabled. An unavailable primary role uses the site's default role (Subscriber if that default is unavailable too); inactive additional roles grant no access. Reactivating the plugin restores those roles automatically. ([#22](https://github.com/JustFlows/justflows-ce/issues/22))

- **Admin feedback receives focus and scrolls into view.** New or changed confirmations, warnings, errors, and action results (including newly created API keys) now receive keyboard focus across the admin and full-screen editors. Errors take priority, dialog focus stays inside the dialog, and loading or unsaved-change indicators do not interrupt editing. ([#12](https://github.com/JustFlows/justflows-ce/issues/12))

- **Shop orders reserve stock, and a paid order commits it.** Placing an order holds tracked stock for the inventory hold time: available goes down and reserved goes up. When the payment is captured, that quantity moves to committed. An unpaid hold returns to available when the hold time ends. Opening Commerce → Inventory commits stock for payments that were already captured and releases holds that have expired.
- **Shop sends order, payment, and refund emails.** Placing an order emails the customer (Order confirmed) and the store contact address (New order). Capturing a payment emails Payment received, and recording a refund emails Refund issued. Commerce → Emails lists each message that went out. A template that is switched off is not sent.
- **Mollie checkout opens Mollie's payment page.** Choosing Mollie at checkout starts a payment and sends the customer to Mollie. A test API key opens Mollie's test payment page. The order stays awaiting payment until Mollie reports it paid. Bank transfer, cash, and check still confirm on this page.
- **Shop product pages calculate tax.** When tax is on, the product price, `{{price}}`, and related products follow Prices in the catalog. A price entered excluding tax is shown with tax added when the catalog displays prices including tax. The price suffix is filled in. When the catalog shows prices excluding tax, the product page shows that net price large and the including-tax price in small text beside it.
- **A rejected Mollie key shows on Diagnostics.** Shop tested a standard API key against Mollie's organization endpoint, which only accepts an organization token, so a sandbox key from Developers → API keys was refused. The connection test now uses the current profile. Admin → System → Diagnostics lists that failure on the overview and under Plugin health checks. ([#57](https://github.com/JustFlows/justflows-ce/issues/57))
- **Product options show in the content editor menu.** Editing a product listed one Product data item for the whole catalog. Images, pricing, inventory, shipping, attributes, variations, categories, and tags are now separate menu entries, and the editor shows the one you pick.

## [0.2.6]

### Added

- **Inline images, footnotes, and math formulas in the paragraph/quote editor.**
  The inline rich-text toolbar gained an image button (upload a file, paste a
  URL, or pick from the media library), strikethrough, and a "More formats"
  menu covering inline code, highlight, subscript/superscript, keyboard
  input, language markup, footnotes, and inline math (LaTeX, rendered with
  KaTeX). Footnotes are numbered in document order and collected into a
  footnotes list at the end of the page on the public site; math renders
  identically — self-hosted, no external requests — in both the editor's
  canvas and the published page.

### Fixed

- Public navigation accessibility labels and PWA install/update prompts now use the site translation catalogs, while preserving custom install text. ([#127](https://github.com/JustFlows/justflows-ce/issues/127))
- Completed missing translation keys for builder controls, security settings, and update progress in all five admin languages. Restart messages, block counts, and language previews now respect localization; blank translations are filled, and under-construction and static error pages translate their text and declare the correct document language. ([#17](https://github.com/JustFlows/justflows-ce/issues/17))

- **Selected paragraph/heading blocks looked cluttered in the page builder.**
  A selected-and-focused text block stacked three near-identical highlight
  layers — the block row's own selection background, a redundant duplicate
  outline, and the text field's hover tint — into one oversized, muddy box
  with no visible boundary between "this block is selected" and "this is the
  text field." The editing field now renders as a clean white inset with a
  clear border, and grows a little on focus instead of hugging the text.
- **Site URL changes in Settings could revert after a restart.** Saving a new
  site URL only updated the running process's environment, not the `.env`
  file it was loaded from, so the change was lost the next time the server
  restarted and `loadConfig()` re-read the stale value from disk.

## [0.2.5]

### Added

- **Configurable public-site PWA.** Settings → PWA lets a site owner turn
  their public site into an installable, offline-friendly Progressive Web
  App: app identity and generated icons, theme/background colors, display
  mode, a validated start URL, up to four app shortcuts, an install prompt,
  a branded offline fallback, and bounded static-asset caching. Disabled by
  default; enabling requires no build step, plugin, or file edit. Disabling
  retires the service worker cleanly at its existing URL so installed apps
  recover without manual cleanup. ([#127](https://github.com/JustFlows/justflows-ce/issues/127))
- **Customizable 404 and error pages.** Theme customize → **Error pages** lets
  an admin choose, per class (404, 403, 410, 429), what renders: the theme's
  own template resolution, Justflows' built-in page, or a specific published
  page — offered once per translation group, so the matching locale renders
  automatically. The template hierarchy gains `403`, `410`, `429`, and a
  shared `error` fallback slot alongside the existing `404`; themes can ship
  `templates/403.json` / `410.json` / `429.json` / `error.json` through the
  same per-site override mechanism (draft/publish/reset) 404 already had. The
  chosen source never changes the HTTP status — a selected page still answers
  403/404/410/429, it cannot 200 a blocked or missing resource — and every
  error response is sent `Cache-Control: private, no-store`. 500 and a new,
  separate **maintenance mode** (Settings → Site visibility, distinct from
  "Site is live") always render a static, dependency-free page with an
  admin-editable heading/message and no database, cache, or plugin-runtime
  access, so they still work during a database outage; the pre-boot `server.js`
  layer's boot-failure response no longer leaks the underlying error message
  and now renders the same branded page. Both the static fallback and the
  built-in 404/403/410/429 pages are localized from the request (URL prefix,
  then `Accept-Language`) across the site's bundled languages. A real 410 now
  fires for a URL whose page was trashed (soft-deleted) rather than never
  existing, until trash retention expires it into a normal 404; the public
  site's global and search rate limiters now answer 429 with the themed page
  instead of plain JSON/text. Admin-provided heading/message text is
  sanitized before storage and HTML-escaped at render; built-in copy never
  reflects the request path, query, or headers.
  ([#92](https://github.com/JustFlows/justflows-ce/issues/92))

## [0.2.4]

### Added

- **Comment spam filtering and submission throttling.** Public comment
  submissions now go through a local heuristic scorer (links, keywords,
  repeated text, disposable email domains, a render-age token, and terms
  learned from "mark as spam") that auto-approves, holds, or auto-marks spam
  per configurable score thresholds in Settings → Discussion → Spam
  protection. Signed-in commenters get a separate rate-limit bucket alongside
  the existing per-IP one. Admins get author/domain/IP/phrase block and allow
  lists (with one-click "Block email/domain/IP" actions from the moderation
  queue), a "hold a first-time commenter" option, an "auto-approve a
  returning commenter" option, and a configurable spam retention/purge
  window. A new `comments.spamBackend` SDK filter lets a plugin attach an
  external spam-scoring service (Akismet-style) without becoming a hard
  dependency — the host always applies its own thresholds. All checks run
  server-side; blocklist/allowlist changes are audit-logged.
  ([#109](https://github.com/JustFlows/justflows-ce/issues/109))

### Fixed

- **Admin content list and menu/content pickers hid content in non-default languages.** Admin → Content, the "add items" picker in Menus, and the page picker in the menu designer all scoped their `/api/content` requests to the site's default published language, so editors couldn't find or select pages/posts written in any other language. These admin views now list content across every language; Admin → Content gained a language filter chip row (shown once the site has more than one language), and the menu content picker shows each item's locale next to its slug.

- **Replying to a comment on a translated post could fail with "Cannot reply to that comment".** The public comment thread lists comments from every translation of a post — a comment left on one language shows under every locale of that post — but submitting a reply checked the parent comment's content id against only the page currently being viewed, rejecting replies to a comment that lived under a sibling translation. Reply submission now matches the parent against the whole translation group, the same grouping already used to render the thread.

## [0.2.3]

### Added

- **Scheduled publishing and expiry.** Schedule posts, pages, custom content and
  working revisions from the editor, with browser/site timezone display, a
  filterable publishing agenda and signed draft-preview links. Database-backed
  jobs catch up after restarts and publish or expire each entry independently of
  its translations. Actual transitions update webhooks, feed hooks, sitemap and
  caches, with revision history and schedule audit entries. ([#98](https://github.com/JustFlows/justflows-ce/issues/98))

- **Force reinstall from Admin → Updates.** A "Force reinstall" button
  re-downloads and reapplies whatever the update gateway currently publishes
  as latest, even when it's the version already installed, to repair a
  corrupted core install (a bad copy, an interrupted dependency install, a
  manually edited file) without waiting on a new release. It runs the exact
  same verified pipeline as a normal remote update — checksum and signature
  checks included — and still restarts the site.

### Fixed

- **Core update dependency install could fail with `ERR_PNPM_OUTDATED_LOCKFILE`.**
  `scripts/make-zip.sh` shipped the full monorepo `pnpm-lock.yaml` in release
  archives alongside `package.json` manifests that `prepare-hosting.js` had
  already stripped `devDependencies` from for npm hosting, so
  `pnpm install --frozen-lockfile` rejected the mismatch on any host with pnpm
  on `PATH`. Release archives no longer include `pnpm-lock.yaml`, and applying
  a core update now removes a stale one left by an earlier release before
  installing, so dependency install falls through to the npm +
  `package-lock.json` the package actually ships.

## [0.2.2]

### Added

- **Diagnostics: email and storage test actions.** Admin → System →
  Diagnostics' "Test services" panel now covers **email** (sends a real test
  message through the configured transport to the site's admin address) and
  **storage** (a write/read/delete round trip against the configured uploads
  directory) alongside the existing database, cache, and jobs checks. The
  server-host reproduction commands are now copyable with one click.
  ([#57](https://github.com/JustFlows/justflows-ce/issues/57))

- **Built-in site search.** Public `/search` pages and the `core.search` block
  support locale, type, taxonomy/date filters, relevance, highlighting, and
  pagination. Admin content search uses a shared incremental database full-text
  index with access scopes; Tools adds visibility settings and index rebuild.
  The headless search API and documented plugin backend interface preserve
  live publication checks, with rate limiting and opt-in anonymous metrics stored in the database (no console or file logging).
  ([#101](https://github.com/JustFlows/justflows-ce/issues/101))

- **Automatic responsive images and modern formats.** Raster uploads now
  generate a configurable set of width-scaled variants plus WebP (and AVIF when
  enabled) alongside the untouched original, inline on upload and backfillable
  from a new **Admin → Tools → Responsive images** job with progress and
  per-file failures. Every public surface that renders an uploaded image now
  goes through one resolver — `core.image`, the **Gallery** block (grid,
  masonry, carousel, slideshow, list, and lightbox), blog-post-list featured
  thumbnails, and the Featured Image theme block — emitting `<picture>` /
  `srcset` / `sizes` with format fallback, intrinsic `width`/`height` to prevent
  layout shift, and `loading="lazy"` / `decoding="async"` defaults with an
  `eager` opt-out (`fetchpriority="high"`) for above-the-fold images; the
  exported `renderResponsiveImage` / `renderMediaImage` helpers give plugin and
  theme blocks the same output. Each asset carries a focal point, set by
  clicking the subject in the Media Library, that drives thumbnail crops and
  `object-position`. Generation, a public-markup toggle
  (`JF_IMAGE_RESPONSIVE_MARKUP` — serve originals everywhere without deleting
  variants), AVIF, quality, widths, max dimension, EXIF/GPS stripping, thumbnail
  size, and a keep-original filename allowlist are all configurable in the same
  panel and written to `.env` as `JF_IMAGE_*` with no restart. SVGs are never
  rasterised, variants live under the same `uploads/` path so CDN/S3 offload and
  static export cover them for free, and migration `0027_media_responsive`
  supports all database dialects. See `docs/MEDIA.md`.
  ([#103](https://github.com/JustFlows/justflows-ce/issues/103))

- **Headless federated management API.** Revocable API keys (Admin → Settings →
  API) authenticate a versioned `/api/manage/v1` surface that federates content
  (CRUD, publish, revisions), media, comments, menus, content types, users,
  roles, settings, languages, redirects, plugin/theme listing and activation,
  cache and static-export triggers, and diagnostics/health behind the same
  capability checks as the admin UI — no parallel business logic. Each key
  carries an explicit capability set never broader than its creator's,
  re-checked against the owner's current access on every request, plus optional
  `AccessScope`, expiry, and allowed-IP / allowed-origin lists; the secret is
  shown once and stored only as a hash with a visible `jfk_` prefix. A master
  switch and per-key / global rate limits apply without a restart, wildcard CORS
  never reaches an authenticated route, and every create / rotate / revoke and
  auth failure is audited by key id. Admin → Settings → API is now the single
  home for both HTTP-API switches — the public-content API toggle moves here
  from Admin → Settings. `GET /api/manage/v1/events` publishes the event catalog with payload
  schemas, and a key with `settings:manage` self-registers and manages its own
  webhook endpoints. The full surface is described by a `bearerAuth` OpenAPI 3.1
  document at `GET /api/manage/v1/openapi.json`. Migration `0026_api_keys`
  supports all database dialects.
  ([#135](https://github.com/JustFlows/justflows-ce/issues/135))

### Fixed

- Unknown multi-segment public URLs (for example `/foo/bar`) now render the
  site's themed 404 — the theme's `templates/404.json` when it ships one,
  otherwise the built-in Justflows 404 — instead of Express's bare
  `Cannot GET`. Single-segment paths already did this; deep paths fell through
  the public router.

## [0.2.1]

### Fixed

- Admin links and navigation now use the configured custom admin URL, including
  content lists, sidebar links, builder shortcuts, and plugin links opened in a
  new tab. Rendered links preserve query strings and fragments, so copying or
  opening a link no longer falls back to `/admin` and returns a 404.
  ([#51](https://github.com/JustFlows/justflows-ce/issues/51))

### Added

- **Redirect manager.** Administrators can create, edit and disable exact,
  prefix and restricted-regex redirects with internal, content or validated
  external destinations; import/export CSV; review slug/permalink URL history;
  and turn aggregate public 404 reports into redirects. Loop checks include
  permalink history, safe equal-status chains collapse, and mutations are
  audited. Migration `0025_redirect_manager` supports all database dialects.
  ([#100](https://github.com/JustFlows/justflows-ce/issues/100))

- **Permalink settings.** Administrators can choose post URL presets or custom
  token structures, configure content-type and taxonomy bases, and select a
  trailing-slash policy. Known previous URLs redirect to current URLs with 301s;
  reserved routes and URL collisions are checked before saving. Core public
  links, canonical tags, and sitemap entries follow the active structure.
  ([#96](https://github.com/JustFlows/justflows-ce/issues/96))

- **Visual menu designer.** Admin → Menus is now a full designer instead of a
  flat link list: a drag-and-drop item tree with indent/outdent and undo/redo, a
  live `?preview=1` iframe, and one-click design presets. Each menu carries a
  layout/design contract (`design` column, migration `0024_menu_designer`) —
  layout (`horizontal`, `vertical`, `dropdown`, `multi-level-dropdown`, `mega`,
  `footer`, `drawer`), hover/click activation, alignment, a per-menu mobile
  breakpoint with a collapse pattern (`dropdown`, `accordion`, `drawer-right`,
  `drawer-left`, `fullscreen`) and enter/exit motion, plus depth and
  items-per-level caps. A NULL `design` renders the built-in defaults, so every
  existing menu is unchanged. Edits autosave to a `draft_items` / `draft_design`
  working copy that only the preview path reads; **Publish** promotes it and
  clears the draft. New front-end: the `partials/nav-menu.ejs` renderer,
  `/js/site-nav.js` (desktop flyouts, off-canvas mobile drawer, keyboard
  navigation, `prefers-reduced-motion`), and the `.jf-nav` styles shipped in the
  default theme's `global.css`.
  ([#61](https://github.com/JustFlows/justflows-ce/issues/61))

- **Per-item menu options.** Menu items gain a style preset and per-button
  styling (background / text / border colours validated as safe CSS values,
  radius, size, full-width), an icon or image (validated as safe asset URLs), a
  badge, a description line, `title` text, and extra `rel` tokens (`nofollow`,
  `sponsored`, `ugc`, `external` — `noopener noreferrer` is always added for
  `target="_blank"`). A `mega` layout's top-level items hold multi-column
  regions whose content is authored as blocks, sanitized on write against a
  fixed safe-block allowlist (no `core.html` / `core.code` / `core.embed`) and
  rendered through the same block pipeline as page content.
  ([#61](https://github.com/JustFlows/justflows-ce/issues/61))

- **Menu item visibility rules.** An item can be shown or hidden by visitor auth
  state, role, locale, or a plugin-provided condition. The checks are enforced
  server-side (fail-closed — an unknown or deactivated condition hides the item),
  and a menu that uses any auth/role/condition rule bypasses the shared public
  cache so every request resolves against the real session; the cacheability
  test itself is cached and invalidated on every menu save, so menus without
  rules cost nothing extra. Device targeting (`desktop` / `tablet` / `mobile`)
  is presentation-only, applied with the shared `data-jf-devices` CSS primitive
  now emitted into `/theme.css` for every theme.
  ([#61](https://github.com/JustFlows/justflows-ce/issues/61))

- SDK: `menu.design.presets` and `menu.visibility.evaluate` filters for plugins
  and themes, `MenuDesignSeed` / `MenuDesignPreset` types, and the menu
  layout / mobile-pattern / activation / alignment enums plus the mega-menu
  safe-block allowlist exported from `@justflows/sdk` as the single source the
  host re-exports. `navigation.items` now runs after the host resolves a menu
  (visibility applied), so appended items sit alongside the author's. See
  [Hooks → Contributing a menu design preset](docs/HOOKS.md#contributing-a-menu-design-preset).
  ([#61](https://github.com/JustFlows/justflows-ce/issues/61))

- **Platform support for syndication feeds.** The RSS 2.0 / Atom 1.0 / JSON Feed
  1.1 feature itself ships in the first-party **SEO Toolkit** plugin
  (`justflows.seo`, via the plugin registry); this release adds the host and SDK
  surfaces it needs, all of them generally useful:
  - `ctx.content.listPublished(query?)` — a plugin can read published entries
    (by type / locale / author / date; scheduled and expired excluded), requires
    the `content:read` permission.
  - `ctx.i18n.defaultLocale()` / `ctx.i18n.locales()` — the site's configured
    locales, read-only.
  - The `html.head` filter context gains `locale` (the page's content locale),
    so a plugin can emit locale-aware `<head>` tags.
  - A manifest may declare `hostCooperative: true`. The runtime normally leaves
    the first-party ids it renders itself (`justflows.seo`, …) inactive; the flag
    means the installed module only augments (feed routes, autodiscovery) and is
    safe to activate.
  - The hard-coded `justflows.seo` settings schema was removed from the host — an
    installed SEO plugin now supplies its own. Its "SEO" nav entry points
    straight at `/admin/plugins/justflows.seo/settings` (see the plugin-path
    convention under **Changed**).
  - Content editor → **SEO** tab gains an **Exclude from RSS / Atom / JSON feeds**
    checkbox for every content type (`fields.seoFeedExclude`), shown only while an
    SEO plugin that owns feeds is active.
    Per-taxonomy feeds remain open — the `taxonomies` / `terms` tables have no
    term-assignment UI or public archive yet.
    ([#102](https://github.com/JustFlows/justflows-ce/issues/102))

### Changed

- **Plugin, theme, and css-provider ids are now `justflows.<name>` only.** The
  manifest validator (`PLUGIN_ID_RE`, exported from `@justflows/sdk`) rejects any
  other namespace at install — the platform is first-party-curated, and the
  `justflows.` prefix is what the admin URL and `/ext/<id>/…` asset mount are
  built from.

- **Every plugin admin page now lives under `/admin/plugins/<pluginId>`, and a
  manifest declares its paths _relative_ to that namespace.** `adminMenu[].path`,
  `adminApp` route `path`, and `setupPath` are now a lowercase leaf (`"orders"`,
  `"orders/refunds"`) or `""` / omitted for the namespace root — never a leading
  `/`, `admin`, the plugin id, or a `.`; an absolute path is rejected at install.
  The host composes the absolute `/admin/plugins/<id>/…` URL from `manifest.id`
  (`resolvePluginAdminPath`, exported from `@justflows/sdk`), so a URL always says
  whether a screen is core or plugin-owned. Host-rendered first-party pages
  (Analytics, Cookie Consent) moved off their old top-level routes
  (`/admin/analytics`, `/admin/consent`); the `/admin/seo` → settings redirect is
  gone (its nav entry is `path: "settings"`); the SSR prefetch table no longer
  carries any plugin-specific route. First-party plugins (`justflows.analytics`,
  `justflows.consent`, `justflows.forms`, `justflows.seo`, `justflows.shop`) must
  be repackaged and reinstalled to pick up the new manifest paths.
  ([#102](https://github.com/JustFlows/justflows-ce/issues/102))

- Hand-authored scripts and styles under `public/` (`/js/site-nav.js`,
  `/js/site-chrome.js`, …) are served with `Cache-Control: no-cache` instead of
  a day-long `max-age`. They sit at stable, unversioned URLs and are not
  content-hashed, so a long TTL pinned stale copies after an update; `no-cache`
  still keeps the file cached and revalidates cheaply against the ETag (`304`).
  Content-hashed admin bundles keep their long cache lifetime.
  ([#61](https://github.com/JustFlows/justflows-ce/issues/61))

## [0.2.0]

### Fixed

- Core updates (Admin → Updates, both the uploaded `justflows.zip` and the
  remote "Update" button) no longer hang forever on _"Updating…"_. The
  copy/migrate/`pnpm install`/build/restart pipeline used to run synchronously
  inside the HTTP request that started it, blocking the single Passenger worker
  for minutes — so the site served nothing (the browser's request, `/admin`,
  everything 499'd) and, if the process was recycled or OOM-killed mid-run, the
  admin page was left with a request that never resolved. The work now runs in a
  detached worker process (`apps/server/dist/lib/core-update-worker.js`); the
  request returns immediately and both the caller and the admin UI follow
  progress through `.updates/status.json` (new `GET /api/updates/status`). A file
  lock rejects a second concurrent update with `409`, a run whose worker has
  died self-heals instead of wedging the UI, the admin page re-attaches to a running
  update after a reload, and its `fetch`es carry timeouts. Dependency install
  now uses `pnpm --frozen-lockfile` (matching the workspace) instead of
  `npm install` at the repo root, falling back to npm only when pnpm is not on
  `PATH`. The one transitional upgrade to this build runs the pipeline in the
  foreground (still writing status) when the worker cannot be bootstrapped from
  the archive.

## [0.1.9]

### Added

- Plugin-owned admin apps. A plugin can declare `adminApp` in its manifest and
  ship a self-contained HTML build; the host serves it at
  `/ext/<pluginId>/admin/**` and mounts each declared route in a same-origin
  `<iframe>` inside the admin shell (`PluginHostPage`). The two sides talk only
  over `postMessage` via the new `@justflows/admin-bridge` package — no shared
  React runtime, no core page, no core route. See
  [PLUGINS.md → Ship your own admin app](docs/PLUGINS.md).
  ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

### Changed

- **Forms is now a fully standalone plugin.** The host no longer implements it:
  `lib/forms-public.ts`, `routes/forms.ts` (`/api/forms`), the
  `/justflows-forms/submit` endpoint, the `justflows.forms.form` render
  special-case and `/js/jf-forms.js` injection in `public-site.ts`, the
  `plugin-runtime` activation skip, the `admin-menu` / `plugins-db` fallbacks,
  and the admin-UI `FormsPage` + `BlockInspector` picker were all removed. The
  plugin (`plugin-registry-service/plugins/forms` v0.2.0) ships its own block,
  submit route, admin app, and public enhancement script. The additive,
  permission-gated `ctx.mail.send()` SDK API lets Forms send submission
  notifications through the host-configured transport without exposing mail
  credentials; a multi-form site loses the block's form picker until a generic
  plugin-block inspector lands.
  ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

- Static / edge export. A new exporter
  (`apps/server/src/lib/static-export/`) crawls the site's own running server
  over loopback and writes every published page, its assets, locale variants,
  `sitemap.xml`, `robots.txt`, `favicon.ico`, the themed `404`, and the
  `/theme.css` build to `STATIC_EXPORT_DIR` (default `./static-export`), plus a
  `_static-export.json` manifest with per-file `sha256` and `Cache-Control`
  advice, plus a Cloudflare Pages / Netlify `_headers` file derived from the
  active Performance suite browser-cache settings. Run it from Admin → System →
  Tools → “Static site export”, `pnpm export:static`, or
  `justflows export static`. A master
  `STATIC_EXPORT_ENABLED` switch, output directory, public base URL,
  dynamic-endpoint origin, crawl limits, and auto-rebuild are editable from the
  Tools page and written to `.env` (`STATIC_EXPORT_*`), applied without a
  restart. **Clear export** (Tools card / `pnpm export:static -- --clear`)
  deletes the whole output folder; disabling the feature or auto-rebuild leaves
  files on disk. `STATIC_EXPORT_AUTO=1` re-runs a targeted incremental export (and
  prunes removed pages) after publish, unpublish, delete, menu, theme, or
  settings changes, debounced via the existing `cache.revalidated` action.
  Every same-origin sub-resource a page references is downloaded — `/theme.css`,
  `/js/*`, uploads, and plugin / custom-theme scripts and assets on their own
  paths (`/ext/<plugin>/…`, `/themes/<theme>/…`); only `/admin`, `/api` and the
  auth/submit endpoints are skipped. A targeted incremental run also fetches any
  asset a rebuilt page _newly_ references (an image or gallery block added to a
  page) even though it skips re-downloading unchanged ones — previously those
  files 404'd on the static host until the next full export. The
  `staticExport.assets` filter adds URLs the scanner cannot see. Plugins can now ship client-side assets first-class: a
  `manifest.assets` block (`{ dir?, scripts?, styles? }`) makes the host serve
  `<dir>/**` at `/ext/<id>/**` — no `ctx.http` route or `html.head` filter —
  and **concatenate every active plugin's scripts/styles into one
  content-hashed `/jf-plugins.<hash>.{js,css}` bundle** added to each public
  page (`PLUGIN_ASSETS_BUNDLE=0` for one tag per file). A marketplace plugin's
  front-end lands in the export automatically as that single bundle
  (`plugins/hello-world` demonstrates it). Pageview analytics keep counting: the
  Analytics plugin ships a `jf-analytics.js` beacon via `manifest.assets`, so it
  rides the `/jf-plugins.<hash>.js` bundle into the export with no
  analytics-specific code in the exporter. The exporter only stamps every page
  with a generic `window.__JF_ORIGIN__` hint; the beacon acts on that stamp
  (absent on the live server render, where views are counted server-side) and
  POSTs to the `/justflows-analytics/collect` ingest endpoint (rate-limited,
  CORS). The Cookie Consent runtime ships the same way, and its two calls (the
  record beacon and the cookie-disclosure fetch) resolve against
  `window.__JF_ORIGIN__` too, so a split-origin export still reaches them. Two
  additive `PluginHttpResponse` fields back this: `revalidate: true` runs the
  site-wide cache revalidation that `PUT /api/plugins/<id>/settings` does (so
  saving Consent settings regenerates the export under auto-rebuild, not only
  after a manual full export), and `cors: true` adds
  `Access-Control-Allow-Origin` for a vouched-for export origin on a public read
  the runtime fetches cross-origin (the Consent cookie-disclosure route). The
  Forms enhancement script ships the same way. Form blocks now
  submit in place: `jf-forms.js`
  posts by `fetch()` and shows the confirmation without leaving the page
  (native `<form>` POST is the no-JS / CAPTCHA fallback); `/justflows-forms/submit`
  gained a JSON response mode and CORS for allowed origins
  (`APP_URL` / `STATIC_EXPORT_BASE_URL` / `STATIC_EXPORT_ALLOWED_ORIGINS`, plus
  `localhost` off production). Keep the submit endpoint reachable via a hybrid
  proxy or `STATIC_EXPORT_ORIGIN_URL` (which also rewrites `<form action>` to an
  absolute URL). Object-storage/CDN deployment is documented (`aws s3 sync` /
  `rclone` / `rsync` + manifest-driven invalidation) with additive
  `staticExport.routes` / `staticExport.assets` / `staticExport.formAction` /
  `staticExport.completed` / `staticExport.deploy` SDK hooks. See
  `docs/STATIC-EXPORT.md`.
  ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

- The page builder now has a categorized block-pattern library with theme-width
  previews, editable insertion, six accessible token-driven section starters,
  local and optionally synced site patterns, locale variants and RTL-aware UI,
  validated JSON import/export, additive theme SDK registration, required-block
  checking, `ctx.patterns.register()` contributions with automatic plugin
  lifecycle cleanup, and a bounded, sanitized opt-in marketplace directory.
  ([#110](https://github.com/JustFlows/justflows-ce/issues/110))

- Admin → System → Diagnostics completes the developer-tooling workflow with
  plugin scheduler status and safe failed-job retries, non-destructive database,
  cache, and scheduler test actions, copyable CLI reproduction guidance, and an
  additive `ctx.diagnostics.register()` SDK for permission-gated, namespaced,
  sanitized plugin health checks. This builds on the debug toolbar, request
  traces, support bundles, and core diagnostics shipped in 0.1.8.
  ([#57](https://github.com/JustFlows/justflows-ce/issues/57))

### Fixed

- Core updates (Admin → Updates, both the uploaded `justflows.zip` and the
  remote "Update" button) no longer hang forever on _"Updating…"_. The
  copy/migrate/`pnpm install`/build/restart pipeline used to run synchronously
  inside the HTTP request that started it, blocking the single Passenger worker
  for minutes — so the site served nothing (the browser's request, `/admin`,
  everything 499'd) and, if the process was recycled or OOM-killed mid-run, the
  admin page was left with a request that never resolved. The work now runs in a
  detached worker process (`apps/server/dist/lib/core-update-worker.js`); the
  request returns immediately and both the caller and the admin UI follow
  progress through `.updates/status.json` (new `GET /api/updates/status`). A file
  lock rejects a second concurrent update with `409`, a run whose worker has
  died self-heals instead of wedging the UI, the admin page re-attaches to a running
  update after a reload, and its `fetch`es carry timeouts. Dependency install
  now uses `pnpm --frozen-lockfile` (matching the workspace) instead of
  `npm install` at the repo root, falling back to npm only when pnpm is not on
  `PATH`. The one transitional upgrade to this build runs the pipeline in the
  foreground (still writing status) when the worker cannot be bootstrapped from
  the archive.

- Static export on a proxied host (Passenger, Plesk) no longer fails with
  _"The site at http://127.0.0.1:3000 is not installed yet — nothing to
  export."_ The crawl origin now resolves to `STATIC_EXPORT_CRAWL_URL` (new,
  editable on the Tools page) or, on production, `APP_URL` — the site's real
  domain — falling back to loopback only in development or when neither is set.
  The production bootstrap wrapper (`server.js`) answered `/api/healthz` without
  the `installed` flag the full app includes, so over the public URL the export
  read the site as uninstalled; the wrapper now mirrors the full app's healthz
  shape. As a belt-and-braces measure the readiness check no longer trusts a
  bare `/api/healthz`: an unclear health result is cross-checked against `/`,
  which only redirects to `/install` when the site genuinely is not set up, so
  an installed site behind any intercepting layer still exports. The exporter
  also retries once against `APP_URL`, and the failure message now names every
  origin it tried.
  ([#24](https://github.com/JustFlows/justflows-ce/issues/24))

## [0.1.8]

### Changed

- Database migrations no longer ship a separate `.mariadb.sql` file. The runner
  resolves MariaDB to `NNNN_name.mariadb.sql`, then the MySQL file, then the bare
  `.sql` (`migrationFileCandidates` in `run-migrations.ts`) — the DDL for the two
  has been byte-for-byte identical in every tracked migration. The redundant
  `0013`–`0016` `.mariadb.sql` files are removed (MariaDB now reads the identical
  `.mysql.sql`); `0012_baseline` keeps its three-file set. Existing installs are
  unaffected: those migrations are already recorded in `_migrations` and never
  re-read, and a fresh MariaDB install applies the same statements as before. A
  future migration adds a MariaDB-specific file only if the DDL must diverge.

- Per-theme customization documents (Customizer mods, homepage design, blog
  design, plus their draft copies) move out of `site_settings` into a dedicated
  `theme_designs` table — one row per (site, theme, kind) with a `doc` /
  `draft_doc` pair, the same shape as `template_parts`. `site_settings` is for
  site-level preferences, not theme/plugin configuration (plugins already use
  `plugin_data`). Migration `0015_theme_designs` adds the table; a one-time
  application backfill on boot (`theme-designs-migrate.ts`) copies the legacy
  `theme_mods.* / theme_home.* / theme_blog.*` (and `*_draft.*`) rows over and
  deletes them, draft-only customizations included. No API or UI change.

### Added

- Themes gain a WordPress-style **template hierarchy**. A theme ships one JSON
  block document per slot under `templates/` (`index`, `front-page`, `single`,
  `single-<type>`, `page`, `page-<slug>`, `singular`, `archive`, `404`, …) and
  shared chrome under `parts/`; the renderer resolves a request to an ordered
  candidate list (`template-hierarchy.ts`) and uses the first that exists, so a
  theme now owns page structure without touching the core EJS. New context
  blocks — `core.post-title`, `core.post-content`, `core.post-meta`,
  `core.post-excerpt`, `core.featured-image`, `core.template-part` — render the
  current request's content inside a template. Theme builder → **Templates**
  edits any template visually; edits are stored per-site in the new
  `theme_templates` table (migration `0023_templates`, draft/publish/reset like
  `template_parts`) and a per-slug override still yields to a more specific theme
  file. The bundled Default theme ships `index` / `front-page` / `single` /
  `page`. `demo/home.json`, `demo/blog.json`, and `demo/footer.json` stay as
  back-compat fallbacks for the `front-page` / `home` / `footer` slots. New CLI:
  `justflows theme templates` and `justflows theme scaffold <slug>`; new SDK
  exports: `TEMPLATE_SLOTS`, `TemplateDocSchema`, `ThemeTemplatesManifestSchema`.

- Admin → Emails adds a versioned system-email design and template editor with
  global branding, typed variables, locale variants, draft/publish workflow,
  desktop/mobile/plain-text previews, sanitized test sending, safe built-in
  render fallbacks, and core account, password, two-factor, security, and
  administrative templates. Published template/version identity follows each
  delivery into the existing privacy-masked mail diagnostics, while security
  templates remain mandatory. Access is gated by a dedicated
  `email-templates:read` / `email-templates:manage` capability pair, separate
  from `mail:read` / `mail:manage`, so administrators can grant template editing
  per user or per custom role without exposing the mail delivery log.
  ([#63](https://github.com/JustFlows/justflows-ce/issues/63))

- Admin → Content → Trash adds recoverable, site-scoped deletion for every
  built-in and custom content type, media, comments, and menus. Restore keeps
  revisions and relationships intact and reports slug collisions explicitly;
  configurable per-site retention drives a daily purge job, while manual purge
  and empty-trash actions are administrator-only. Referenced media requires a
  confirmation before permanent deletion, and trash, restore, and purge actions
  are audited. ([#108](https://github.com/JustFlows/justflows-ce/issues/108))

- Admin → Settings → Outgoing mail adds separate From, Reply-To, and envelope
  sender identities, provider transport registration, full test-transport
  responses, privacy-masked delivery/dead-letter logs, manual retry,
  per-type suppression, delivery limits, and SPF/DKIM/DMARC guidance. Transport
  secrets and retry payloads remain encrypted at rest; `mail:read` and
  `mail:manage` capabilities control operational access. ([#104](https://github.com/JustFlows/justflows-ce/issues/104))

- Admin → Users now supports site-local custom roles with a capability editor,
  safe built-in defaults, assignment guards, audit events, SDK hooks, and
  capability-first enforcement across the user and content APIs.
  ([#22](https://github.com/JustFlows/justflows-ce/issues/22))

- Per-user capability grants and explicit denies can be layered on a role,
  with server-enforced content-type, locale, site, and ownership scopes plus a
  human-readable effective-access preview. Policy changes revoke existing
  cookies and cannot be applied to the acting administrator's own account.
  ([#53](https://github.com/JustFlows/justflows-ce/issues/53))

- Account Security lists database-backed device sessions, marks the current
  device, revokes one session or all other sessions, and makes ordinary logout
  end only the current device. This ships the session-control slice of the
  larger identity roadmap; OIDC/OAuth, SAML, and administrator MFA policy still
  remain before that roadmap item is complete.
  ([#54](https://github.com/JustFlows/justflows-ce/issues/54))

- **SDK:** access-policy contracts (`AccessPolicy`, `AccessScope`, effective
  capability/scope helpers), access-change hooks, resolved capability and
  scope fields on authenticated plugin HTTP sessions, and a runtime capability
  registry (`ctx.capabilities.register()`). Commerce and other extension-owned
  capabilities are no longer hard-coded in core; only active plugins contribute
  their domains to the role editor and authorization policy.
  ([#53](https://github.com/JustFlows/justflows-ce/issues/53))

- First-party **Cookie Consent** plugin (`plugins/consent`): a categorized
  consent banner and preference center (necessary, preferences, analytics,
  marketing) with accept-all / reject-all parity, granular toggles, a keyboard-
  and screen-reader-accessible modal that respects `prefers-reduced-motion`, and
  a re-open trigger. Every visitor-facing string is stored per site language and
  the runtime picks the visitor's locale from `<html lang>`; translating the
  banner does not invalidate stored consent. Admin → Extensions → Cookie Consent
  also carries a full **design panel** — layout (bar / floating box / blocking
  modal), placement (top, bottom, any corner), theme-inherited or explicit
  colours (validated, applied as CSS custom properties), and panel/button radius
  and width — with a live preview. It exposes a first-party
  `window.justflowsConsent` API that the custom-code injector, Analytics, and
  other plugins can query before loading anything non-essential; gates tagged
  `<script type="text/plain" data-jf-consent="…">` snippets and off-site oEmbeds
  behind their category with a per-embed unlock; and stores versioned consent
  records (policy hash, timestamp, choices, locale, coarse device) that are
  exportable as CSV and erasable per record — or turns record logging off
  entirely so no `plugin_data` rows are written and no beacon is sent. Best-effort EU-only display uses the
  visitor's timezone — no IP lookup, no third-party dependency, all logic and
  storage first-party. A new synchronous `analytics.head` filter lets the plugin
  defer the Analytics plugin's Google Tag until analytics consent is granted,
  without blocking first paint.
  ([#113](https://github.com/JustFlows/justflows-ce/issues/113))

- **SDK:** a site cookie registry. Extensions declare every non-essential cookie
  they set through `ctx.cookies.declare({ name, category, purpose, … })` — one
  of `necessary` / `preferences` / `analytics` / `marketing` — and read the full
  resolved registry (host cookies plus every active plugin's) with
  `ctx.cookies.list()`. Operators re-classify any cookie by name in
  Admin → Extensions → Cookie Consent, stored site-wide
  (`GET`/`PUT /api/cookies`). The Cookie Consent plugin uses it to disclose
  cookies per category in the preference center and to expire a category's
  cookies the moment it is withdrawn; `window.justflowsConsent.allowed(name)`
  resolves a single cookie against it.
  ([#113](https://github.com/JustFlows/justflows-ce/issues/113))

- Admin → System → Diagnostics adds administrator-only runtime, database,
  migration, cache, plugin and typed-hook inspection; correlation IDs on every
  HTTP response; bounded sanitized error retention; a persistent production
  debug-mode warning; and explicitly confirmed, size-limited support bundles
  containing exactly the redacted information previewed in the dashboard.
  ([#57](https://github.com/JustFlows/justflows-ce/issues/57))

- **SDK:** Published compatibility and deprecation policy for plugins, themes,
  and CSS providers; their shared `engines.justflows` manifest range is enforced
  by the installer before a package leaves staging; plugins additionally receive
  explicit Justflows, SDK package, and SDK API versions through `ctx.runtime`;
  and CI snapshots the public SDK export surface so an export cannot disappear
  without review and the required deprecation cycle. Existing top-level
  `justflows` package ranges remain supported as a deprecated compatibility
  alias.
  ([#20](https://github.com/JustFlows/justflows-ce/issues/20))

- Self-service password reset. A "Forgot password?" link on the sign-in and
  registration screens emails a single-use, time-limited link
  (`JF_PASSWORD_RESET_TTL_MINUTES`, default 60) that lets an administrator or a
  user set a new password without shell access or a database edit. Tokens are
  stored only as SHA-256 hashes, bound to one account, and invalidated on use,
  on any password change, and on expiry; the request response is identical
  whether or not the address exists, and both the request and the redemption are
  rate limited per address and per IP. A completed reset revokes every session
  but establishes none, so a second factor (`#54`) still applies at the next
  sign-in. Administrators can disable the flow or restrict it to chosen roles
  under Admin → Settings, and every request, completion and failure is written
  to the audit log. When outgoing mail is not configured, the
  `justflows user reset-password --email you@example.com` CLI command is the
  documented fallback; with `NODE_ENV=development` the reset link is also printed
  to the server console. New `password_resets` table (migration
  `0017_password_resets`).
  ([#93](https://github.com/JustFlows/justflows-ce/issues/93))

- Admin Home shows a dismissible "Welcome to JustFlows" discovery panel to
  administrators: curated cards linking to the documentation, Marketplace and
  roadmap on `justflows.com`, the JustFlows Discord, and the in-app Updates page.
  The cards are static and bundled — no remote feed, no injected markup or
  scripts, no tracking — so Admin Home renders and works identically with no
  network. Each administrator can minimize or
  dismiss the panel and bring it back; the choice is stored per user (new
  `user_preferences` table, migration `0016_user_preferences`, and
  `GET` / `PUT /api/preferences`) and mirrored to `localStorage` for an instant,
  offline-safe first paint. ([#52](https://github.com/JustFlows/justflows-ce/issues/52))

- Admin → Security → Admin URL can move the administration entry path away
  from `/admin`, with reserved-path validation, a reachability check and
  automatic rollback, configurable 404/redirect behavior for the old path,
  and a `JF_ADMIN_PATH_RECOVERY` environment override for proxy/cache recovery.
  Sign-in and registration now follow the configured path: `POST /api/auth/login`
  and `/register` return a `redirectTo`, so the pre-session `/login` page no
  longer sends an authenticated non-subscriber to a stale `/admin` (which, with
  the default "not found" behavior for the old path, was a 404).
  ([#51](https://github.com/JustFlows/justflows-ce/issues/51))

- Each form built under Extensions → Forms has its own "Require a CAPTCHA on this
  form" switch in the builder. When on, the form reuses the provider and keys
  already configured under Settings → Discussion (Turnstile, hCaptcha, reCAPTCHA
  v2, or reCAPTCHA v3) — no second key to enter. The widget renders in that form,
  `/justflows-forms/submit` verifies the token server-side (reCAPTCHA v3 checks a
  form-specific action and the score threshold) before storing or emailing the
  submission, and the honeypot still runs first. The provider/verify/widget code
  is now shared between comments and forms (`apps/server/src/lib/captcha.ts`);
  the public CSP already widens whenever a provider is selected, so it covers
  both.

- The `core.color-scheme` block gains design variants beyond buttons and icons:
  a two/three-button segmented control, a single sun/moon toggle, a switch
  control, a compact dropdown, plain text labels, and icon buttons with
  tooltips — selectable per block in the page builder with a live preview and an
  "Animate the icon change" option that honours `prefers-reduced-motion`. Every
  variant reuses the existing preference engine in `/js/site-chrome.js`
  (pre-paint apply, explicit choice persisted, live OS tracking while on
  System/Auto, CSP-safe) rather than duplicating theme-state logic. The single
  toggle carries `data-jf-theme="toggle"` and the dropdown a
  `data-jf-color-scheme-select` `<select>`; both are driven by the same
  delegated listeners. Focus is now always visible on the controls.
  ([#60](https://github.com/JustFlows/justflows-ce/issues/60))

- `core.color-scheme` is also customizable per block: `size` (`sm`/`md`/`lg`),
  `radius` (`pill`/`rounded`/`square`), and overridable icons and labels
  (`lightIcon` / `darkIcon` / `autoIcon`, `lightLabel` / `darkLabel` /
  `autoLabel` — blank keeps the defaults, author values are HTML-escaped). The
  default theme now styles the widget entirely through `--jf-color-scheme-*`
  custom properties (resting / hover / active / focus colors, border, radius,
  spacing, font size) with theme-token fallbacks, so a theme or the Theme
  Customizer can restyle it without overriding rules. `--jf-color-scheme-hover-bg`
  / `-hover-fg` default to the resting colours (hover shows only the border
  highlight) until set. The builder surfaces the five colour hooks in the
  block's Theme-styling → All theme variables list, so an author can recolour
  the selected/hover state of one instance without writing CSS.
  ([#60](https://github.com/JustFlows/justflows-ce/issues/60))

## [0.1.7]

### Added

- Admin → Themes now loads every published theme from the hosted marketplace,
  shows installed, paid, and coming-soon states, installs community themes
  through the existing signed package flow, and can delete inactive installed
  themes while protecting the active and bundled themes. ([#13](https://github.com/JustFlows/justflows-ce/issues/13))

- Google reCAPTCHA v2 and v3 are now available alongside Cloudflare Turnstile
  and hCaptcha under Settings → Discussion. Public comment forms load the
  selected checkbox or score-based integration and verify its single-use
  response server-side before accepting a submission; v3 also enforces the
  expected action and configurable minimum score.
  ([#49](https://github.com/JustFlows/justflows-ce/issues/49))

- Header builder in the theme customizer (Theme builder → Header): a library of
  named headers, one marked the site default and shown on every page. Each page
  picks its header from a dropdown in the page builder — the site default, a
  named header, or _None_ — instead of editing header chrome inline; the choice
  persists immediately via `PUT /api/content/:id/header-ref`, independent of the
  page's Save. Every header carries a base config plus sparse per-language
  overrides (exact locale merged over the base). Draft/publish mirrors the
  footer.

- New `template_parts` table (migration `0012`) — site-wide chrome documents
  (header library, footer blocks) are design artifacts and now have their own
  table instead of JSON rows in `site_settings`. A one-time boot backfill moves
  existing `template_part.*` / `template_part_draft.*` settings across.

- Plugin/theme header designs via hooks: `header.templates` (contribute named
  headers that appear in the per-page picker, `build()`-rendered at request
  time), `header.resolve` (own a page's header per request), `header.config`
  (adjust the resolved header before render). New SDK types `HeaderConfig`,
  `HeaderTemplate`, `HeaderBuildContext`, `HeaderResolveContext`. See
  `docs/HOOKS.md`.

- Built-in header and language-switcher blocks now offer full locale, short
  locale, flags, flag and locale, or flag and country-name styles. Each style
  uses an accessible dropdown; builder previews match the mobile-first,
  responsive public output.
  ([#59](https://github.com/JustFlows/justflows-ce/issues/59))

- Public comments, end to end: a `Comments` block (drop it on a post) renders
  the approved, threaded discussion and an accessible submission form.
  Visitors submit at `POST /justflows-comments/submit` — same-origin checked,
  IP rate limited, honeypot and optional Cloudflare Turnstile / hCaptcha /
  Google reCAPTCHA v2 / v3
  guarded, bodies reduced to a small safe formatting whitelist. New comments
  hold for moderation by default and the admin is emailed; commenters can opt
  into reply notifications and unsubscribe in one click
  (`/justflows-comments/unsubscribe`). Approved comments render without ever
  exposing commenter email addresses or IPs.
  ([#50](https://github.com/JustFlows/justflows-ce/issues/50))

- Settings → Discussion controls the site comment policy (on/off, hold for
  moderation, moderator email, author links, auto-close after N days, page
  size, length and reply-depth limits, CAPTCHA provider and keys); a per-post
  Discussion control overrides it either way. Admin → Comments gains
  pagination, inline reply and edit, and permanent delete from the trash.
  ([#50](https://github.com/JustFlows/justflows-ce/issues/50))

- New `comments.render` filter hook: a plugin receives the rendered
  `justflows.comments.thread` markup plus the threaded `PublicComment[]` and
  form/policy state (`CommentsBlockRenderContext`) and can restyle or fully
  replace the HTML. The submission endpoint, `comments` table, and moderation
  API are unchanged. New SDK types `CommentsBlockRenderContext` and
  `PublicComment`. Comment timestamps are also normalised across database
  drivers before rendering (Postgres returns `Date`, MySQL a string).
  ([#50](https://github.com/JustFlows/justflows-ce/issues/50))

- Every theme folder under `themes/` is registered in the `themes` table
  automatically on the admin themes/customizer load (previously only
  `justflows.default` was seeded), so a bundled or dropped-in theme is
  selectable without a `.jfpkg` upload. `syncBundledThemes` also refreshes an
  existing row's `name` / `version` / `manifest` from the folder while leaving
  its `status`, `activated_at`, and `css_variables` as the admin left them.

- Themes can ship default site chrome resolved live at render, the same way
  `demo/home.json` works: `demo/footer.json` (block document — Theme builder →
  Footer seeds its canvas from it, `GET /api/template-parts/footer` returns
  `fromThemeDefault`) and `demo/header.json` (sparse `PageHeaderConfig` merged
  over `DEFAULT_PAGE_HEADER`, used when the header library has no default entry).
  Nothing is written to the database on activation; an admin edit always wins.

- `patterns/product.json` and `patterns/post.json` double as the starting canvas
  for a new `product` / `post` content row whose editor opens empty
  (`defaultBlocksForContentType`), matched by an explicit type allowlist.

- Theme-contributed Customizer controls: a `customize` block in
  `justflows-theme.json` adds sections/controls (`color` / `range` / `select` /
  `font`, keyed by `--custom-property`) that flow to `:root` through the
  existing schema-driven mods pipeline — `schemaWithThemeControls` merges them
  onto `THEME_CUSTOMIZE_SCHEMA`, and `mergeMods` / `defaultModsFromSchema` /
  `modsToCssVariables` are now generic over section keys.

- Per-block styling without CSS. `style` (the Layout panel) gains `background`,
  `textColor`, `accent` (validated colours; `transparent` / `none` clear a
  background), `opacity` (0–100%), and `vars` — per-instance overrides of theme
  CSS custom properties written onto the block's own root element. A
  `blockControls` map in the theme manifest promotes chosen theme variables to
  first-class inspector fields per block type (dropdown / slider / colour), with
  an "All theme variables" section covering the rest. `GET
/api/themes/style-tokens` serves the list (name, current value, range bounds,
  select presets) and drives the per-block **Custom CSS** panel's variable
  reference.

- The page builder links the active theme's stylesheet into the canvas
  (`GET /theme.css?scope=<selector>` → `scopeThemeCss` confines every selector
  to one wrapper class, `:root` / `html` / `body` become the wrapper,
  `@keyframes` stay global), and block previews emit the real `jf-*` markup, so
  the canvas renders with actual theme styling.

### Changed

- Admin update discovery now follows full Semantic Versioning precedence,
  including prerelease-to-stable updates such as `0.1.7-dev` or `0.1.7-rc` to
  `0.1.7`. ([#87](https://github.com/JustFlows/justflows-ce/issues/87))

- Database migrations `0001` through `0012` are consolidated into one
  `0012_baseline` file per supported dialect, reducing the shipped migration
  footprint from 36 files to 3. Fresh installs and existing sites run the same
  ordered schema changes, completed baselines are recorded in `_migrations`,
  and subsequent schema changes continue at migration `0013`.

- The page builder no longer renders always-on header chrome; each page instead
  references a header from the new library. Existing per-page headers
  (`fields.jfHeader`) are converted to library entries once, on first boot, and
  the page is pointed at the matching entry. Posts and error pages now render
  the site-default header rather than a hardcoded default.

- The content edit screen (`/admin/content/:id`) is settings-only for every
  content type — the inline page-builder canvas is gone, replaced by an **Open
  page builder** button. Its panels (SEO, Discussion, Revisions, Advanced) moved
  from one long right-rail scroll into a left sub-nav, leaving only Publish in
  the rail.

### Fixed

- `core.html` blocks now wrap their content in a single `<div class="jf-html">`.
  Custom HTML with several top-level nodes previously had its block class,
  scoped CSS, and style overrides applied only to the first element.

### Removed

- "Saved headers" (`/api/header-presets`) — replaced by the header library
  (`/api/headers`). Old `header_presets` settings rows are left in place but
  unused.

## [0.1.6]

### Added

- Plugin registry listings declare `registry` on `justflows.json`:
  `commercialMarketplace` (internal commercial catalogue), `listed` (publisher
  visibility after internal approval), `free`, `comingSoon` (visible but not
  installable), and when paid `price.amount` / `price.currency`. Admin →
  Marketplace hides unlisted rows, shows a Coming soon badge instead of
  Install, and still sends paid listings to Justflows checkout. Explicit
  `registry` flags take precedence over legacy catalogue fields, so a free
  listing never inherits a stale paid price or commercial action.

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
  `content.render`. Shop registers storefront blocks (gallery layouts with an optional lightbox, buy box,
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
