# Multi-site and multi-tenant hosting

One Justflows installation can serve many sites. A **workspace** (tenant) owns one or more sites. Each site is reached by its own hostname. An unknown host is refused. It is never served as another workspace's site.

## Database choice

Every workspace chooses where its data lives:

| Choice | What it means |
| --- | --- |
| **Current database** | Content, users, media metadata, settings, themes, and plugin activation stay in the installation database. Rows are scoped by site. |
| **Separate database** | The workspace gets its own database. The installation database keeps only routing: the workspace, the hostname, and the encrypted connection. Tenant administrators never receive that password. |

A site can stay on the workspace database, stay on the current database, or get its own separate database. A dedicated database per site is that last option. Shared users cannot split across databases: either every site in the workspace uses the same database, or the workspace uses isolated users.

The connection uses the same driver as the installation (PostgreSQL, MySQL, or MariaDB). Credentials are encrypted with the installation secret. Platform → reveal writes an audit row and is limited to platform operators.

Creating the database uses the account you enter. That account needs permission to connect, and to `CREATE DATABASE` when the database does not exist yet. A failure is stored on that workspace only.

## Users

- **Isolated users.** Each site has its own accounts. The same email can exist on another site and is a different person.
- **Shared users.** One account in the workspace, with a role on each site. Signing in on a site uses that site's role. The session cookie is for that host only. Opening another site does not reuse it.

The first administrator created by the installer is a **platform operator**. Platform operators manage workspaces, suspension, and database placement. A person who signs up for a site is only an administrator of that site.

Updates, diagnostics, and the server cache live on the installation's first site. A site created later does not show those pages, and its API calls for them are refused. Platform stays with the platform operator. Content, media, themes, plugins, users, and the site's own settings stay on every site.

## Hosts, DNS, and TLS

Store the hostname without a scheme or path (`www.example.com`, `my-site.example.com`). Point DNS at this installation. Terminate TLS at the reverse proxy or host. Justflows does not issue certificates.

A hostname only routes while its status is active. Hostnames an operator adds on a website page are active straight away. A custom domain a website connects itself is not served until it is verified (see below).

While the installation has exactly one site, `localhost` still opens that site so an existing install keeps working. After a second site exists, each host must be registered. Add `site-a.localhost` and `site-b.localhost` to your hosts file to try two sites locally.

Signup uses `slug.<base domain>`. Turn it on under Admin → Platform and set the base domain. Visitors do not enter a database connection. The same screen chooses the current database or one separate database for every new signup. The installation keeps the platform site and the routing; the password stays on the platform. The link after signup keeps the scheme and port of the signup page, so a local site opens at `http://my-site.localhost:3000`.

## Custom domains

A website can connect a domain it owns under **Settings → Domains**. A platform operator sets this up under **Platform → Custom domains**. It is off until turned on there.

**Two ways to connect.** The operator chooses which are offered.

- **DNS records.** The customer keeps their DNS host. They add a TXT record `_justflows.<domain>` with the value shown, and point the domain at the CNAME target. A bare domain (`example.com`) needs ALIAS, ANAME, or CNAME flattening at their DNS host, or the A and AAAA addresses the operator lists.
- **Nameservers** (Bunny DNS only). Justflows creates a DNS zone for the domain at Bunny, with records that serve the website, plus `www.` when that option is on. The customer adds the TXT record `_justflows.<domain>` with the exact verification value at the authoritative DNS provider and changes the nameservers at their registrar. The TXT check works before or after the nameservers switch; if they have already switched, an operator with independent access to Bunny must add the record there. Justflows does not publish this challenge automatically. A domain that already uses the platform's nameservers cannot be added this way, because the delegation alone does not show who owns it. DNS records can be managed once ownership is proven. The website can then add its own records (MX, TXT, A, AAAA, CNAME, CAA, SRV) under **DNS records**. The records that serve the website cannot be changed. Before switching, the customer should copy their email and other records, because the old DNS host stops answering.

**Verification.** A background job checks pending domains every few minutes. **Check now** runs the check at once. Once DNS is right, the hostname is attached to the provider, a certificate is issued, and the domain starts routing. A domain that is never verified is released after the number of days the operator sets, so a name cannot be held by someone who does not own it. A connected domain is checked again every 6 hours. After the operator's number of failures in a row, it stops being served. If it was the primary address, the platform subdomain becomes primary again.

**Primary address.** A connected domain can be made primary. That changes the site URL to `https://<domain>`. With **Send visitors to the custom primary domain** on, public pages on the site's other addresses redirect there with a 301. Admin, API, and upload paths stay on the address they were opened on, so the site can still be managed when its domain breaks.

**Providers.**

- **Bunny.net.** Put a Bunny pull zone in front of this installation and turn on *Forward Host Header*, so Justflows sees the customer's hostname. Enter the pull zone ID. The API key from Settings → CDN is used unless the page has its own. **Test connection** fills in the CNAME target from the pull zone's own hostname (`<zone>.b-cdn.net`). Bunny issues the certificates.
- **This server.** Customers point DNS straight at this installation, and the reverse proxy issues certificates. For Caddy, use on-demand TLS with `ask http://127.0.0.1:3000/api/domains/tls-allowed`. It answers `200` only for a hostname that is a verified domain on this installation.

**Your own nameservers.** By default customers see `kiki.bunny.net` and `coco.bunny.net`. To show your own (`ns1.example.com`, `ns2.example.com`), enter them on the platform page and create glue records for them at the registrar of that domain: the first at `91.200.176.1` / `2400:52e0:fff0::1`, the second at `109.104.147.1` / `2400:52e0:fff2::1`. New zones are created with those names. Zones created earlier keep the names they had.

**Selling it.** What each website may do is set with three limits, on each website page and under Defaults:

| Meter | Meaning |
| --- | --- |
| `feature.customDomains` | Off: Settings → Domains is hidden on that website and its domain API is refused. |
| `domains.custom` | How many domains the website may connect. A `www.` added with its domain does not count. |
| `feature.managedDns` | Off: the website cannot connect by nameservers or edit DNS records. |

Set **Upgrade link** to send a website to your pricing page when it reaches its domain limit, or when only nameservers are offered and DNS hosting is off. A subscription plugin lowers these per plan with the `quota.effectiveLimit` filter or `ctx.quotas.set`. It can also refuse a domain with the `domain.beforeAdd` gate and charge on `domain.activated`. Turning a meter off later does not disconnect domains that are already connected.

## Operations

Suspending a workspace suspends its sites and leaves every other workspace running.
Migrations on a separate database: Admin → Platform, or `POST /api/platform/databases/:id/migrate`. The installation database is migrated on boot as before.

Backup the installation database for routing and every separate database on its own:

```bash
pg_dump --host HOST --username USER --dbname DATABASE > workspace.sql
mysqldump --host HOST --user USER DATABASE > workspace.sql
```

Restore with `psql` or the `mysql` client into that same database, then run migrations. Deleting a workspace marks it deleted. Dropping its database is a separate confirmation and does not touch other databases. If the drop fails, the error is stored on that connection and other workspaces stay up.

## Files per site

Each site's files sit in a folder of their own, so one site can be backed up,
moved, or removed without touching another:

| What | Where |
| --- | --- |
| Media, responsive variants, trash | `uploads/<siteId>/` (or the `<siteId>/` prefix in the S3 bucket — see [Media](MEDIA.md#storage-and-cdn)) |
| Static export | the main site: `static-export/`; every other site: `static-export-sites/<hostname>/` |
| "Save as new theme" forks | `packages-installed/sites/<siteId>/themes/` |

`/uploads` only serves a site's own folder on its own host. A static export run
from a site crawls that site's hostname and publishes under it; the
`STATIC_EXPORT_*` settings in `.env` describe the main site and can only be
changed there. A customer site can turn static export off for itself under
Tools. That does not change the installation, and it leaves files already
exported until that site clears them. Auto-rebuild queues each site separately
and skips a site that turned export off.

Shared by every site: bundled themes and plugins, marketplace packages under
`packages-installed/themes/` and `packages-installed/plugins/`, the cache
folder, and `.env`. Deleting a workspace marks it deleted and leaves these
folders on disk.

## Adopting this on an existing install

Migration `0037_tenancy` creates a Primary workspace on the current database, attaches the existing site, registers the host from the site URL, and makes the earliest administrator a platform operator. Users stay isolated, which matches accounts that already belong to one site. Add another site from Admin → Platform when you are ready. Choose **Current database** or **Separate database** at that moment.

## Plugins

A plugin is installed on the main site. On Plugins, that site turns on **Allow on other sites** for each plugin it wants to share. Another site can then activate or deactivate it. Turning it off there removes its admin pages from that site's menu. The plugin can stay on for the main site. It is not turned on there by itself. It shows the version the main site installed, including after an update. Activating the plugin on the main site creates its tables in every site database. Starting the server with that plugin already active on the main site does the same. Another site uses those tables and cannot create or delete them. That site cannot install a plugin, open the Marketplace, or remove a plugin. Only the main site removes one.

Another site cannot uninstall a plugin. When it turns a plugin off, the host honours that site's `deleteDataOnUninstall` and `deleteContentOnUninstall` settings the same way a full remove would for that site alone: the plugin's `deleteData` hook runs, owned CMS types and entries can be deleted, and that site's rows are cleared. Tables stay so other sites keep their data. Turn those settings off before deactivating if this site's catalog and pages should remain.

A plugin reads the workspace for the current request with `ctx.tenancy.current()`. That object has the workspace id, site id, hostname, user mode, database mode, and whether this is the main site. It never includes a database password.

Creating, listing, suspending, reactivating, and deleting workspaces requires the `platform:tenancy` manifest permission. The same operations are on the management API at `/api/manage/v1/tenants` for an API key whose user is a platform operator.

Gates `workspace.beforeCreate`, `site.beforeCreate`, `workspace.beforeSuspend`, `workspace.beforeReactivate`, and `workspace.beforeDelete` run before the change. Cancel to refuse it. Actions `workspace.created`, `site.created`, `workspace.suspended`, `workspace.reactivated`, and `workspace.deleted` run after it succeeds. See [Hooks](HOOKS.md).

## Limits

A platform operator sets ceilings on the workspace page and on each website page. An empty field means no limit. Existing items stay when a limit is lowered; the next create is refused. The same pages also turn features off: comments, theme upload, design, custom roles, responsive images, security, PWA, redirects, and the other site admin sections. Off hides that menu and blocks the feature. On, or never set, leaves it available. **Defaults**, also under Platform, holds the numbers and switches copied onto a workspace or a website when it is created. Content types that already exist on any website, including ones a plugin created, appear there too, and a number saved for that type is copied onto each new website. Saving a new default does not change workspaces or websites that already exist.

| Where | Meter | What it counts |
| --- | --- | --- |
| Workspace | `sites` | Websites on that workspace, including the first one |
| Website | `users` | Accounts that can use that website. Shared users count a membership as well as a home account |
| Website | `content` | Content rows, any status |
| Website | `content.<type>` | Content rows of that type, for example `content.post` |
| Website | `content.types` | Custom content types. Built-in Post and Page are not counted |
| Website | `media.files` | Media files |
| Website | `plugins` | Installed plugins |
| Website | `roles` | Custom roles. Creating roles also requires the feature to be on |
| Website | `media.bytes` | Media library bytes. The environment library cap still applies, and the smaller ceiling wins |
| Website | `files.count` | Private files plugins store with `ctx.files`, such as downloads |
| Website | `files.bytes` | Bytes of those private files |
| Website | `feature.ownStorage` | Whether the website may save its own private-file storage. Off removes Settings → Storage from that website (menu and page) and it uses the root site's storage. The root site always keeps the page |

Plugins register their own meters with `ctx.quotas.register` and call `ctx.quotas.check` before they insert a row. The host does not count plugin tables, so the plugin passes `used`. `ctx.quotas.set` writes the same limits the operator edits and requires `platform:tenancy`. A subscription plugin uses that to apply a plan. The filter `quota.effectiveLimit` may lower a stored limit. It cannot raise one. The action `quota.updated` runs after a save. Both require `platform:tenancy` to listen. The same reads and writes are on `/api/manage/v1/tenants/:id/quotas` and `/api/manage/v1/sites/:id/quotas`.

## What Justflows does not operate

DNS for the platform's own domains, TLS certificates outside Bunny.net, subscriptions, and outbound email stay with the operator. A plugin can add paid plans. Justflows provisions the database you configure, and with Bunny.net it attaches custom domains, issues their certificates, and creates DNS zones for them.

## Storage accounting and caps

Root Diagnostics and Platform → Website show physical managed storage split
between local files and external S3-compatible storage (including OVH), and
between media, private files, and exports. Measurements include trash,
derivatives, local staging, immutable export objects, and retained private-file
copies. Logical media/private-file records are shown separately; they are not
physical storage bills. External totals cover managed site prefixes rather than
all unrelated objects in a provider account. Local totals cover the configured
uploads, private-file, and static-export folders, rather than database files,
application dependencies, or the whole server disk.

`GET /api/diagnostics/storage` is installation-root administrator only.
`GET /api/platform/sites/:id/storage` uses the platform operator guard. Both
return a background measurement state and its latest report, including
`generatedAt`, local/external byte and file totals, category rows, `totalBytes`,
and `logicalBytes`. Dashboard snapshots are refreshed after one minute or
storage writes and survive only for the current process. They are a foundation
for billing integration, not a persisted billing history or invoice ledger.
Unknown measurements remain null, never zero.

Set **Total storage (local + external)** in a site's Limits, or in Platform
Defaults for new sites (`storage.bytes`, bytes in the API and MB in the UI).
Blank is unlimited. The total physical cap applies alongside media and private
file caps. Admission uses fresh inventory under a control-database `storage_quota_locks` row
lock, shared by workers and by media/private/export writers, not the dashboard
cache. Writes that need more room are refused; if required usage cannot be read,
a finite cap refuses growth. Existing data is kept if the limit is lowered.
Temporary staging and retained copies consume space too, so migrations, image
regeneration, S3 trash/restore moves, and exports need room for their intermediate or retained files.
Files written directly to disk or a bucket outside Justflows cannot be prevented
by application quotas; inventories include them when they fall within a managed
site namespace. Provider credentials need ListObjectsV2 permission for accurate
external measurements and finite-cap admission.
