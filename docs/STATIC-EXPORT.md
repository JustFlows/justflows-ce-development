# Static / edge export

Write every published public page and its assets to a folder you can serve from
a filesystem, object storage, or an edge CDN — no Node origin required for those
pages. Use it for marketing sites, documentation, and campaign pages that get
far more reads than writes.

Roadmap: [`justflows-ce#24`](https://github.com/JustFlows/justflows-ce/issues/24).

## What it does

The exporter **crawls the site's own running server** (over loopback, or its real
domain on a proxied host — see [Configuration](#configuration)), so the
output is byte-for-byte what a visitor receives — the active theme, the template
hierarchy, blocks, localized routes, the SEO `<head>`, favicon, and the
`/theme.css` build all come out unchanged.

A run produces:

| Output                                                                     | Source                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.html`, `<slug>/index.html`                                          | every published page/post, default locale                                                                                                  |
| `<locale>/…/index.html`                                                    | each non-default active locale (from `localePath()`)                                                                                       |
| `sitemap.xml`, `robots.txt`                                                | fetched from the origin verbatim (always exported)                                                                                         |
| `feed.xml`, `feed.atom`, `feed.json`, `<locale>/feed.*`                    | syndication feeds — seeded by the SEO Toolkit plugin's `staticExport.routes` filter, one set per active locale, when feeds are enabled     |
| `favicon.ico`                                                              | the configured favicon, redirect followed (only if one is set)                                                                             |
| `404.html`                                                                 | the themed not-found page                                                                                                                  |
| `theme.css`, `/js/*`, `/uploads/*`, `/assets/*`, `/css-providers/*`, fonts | every same-origin sub-resource referenced by an exported page                                                                              |
| redirect stubs                                                             | a `<meta refresh>` page wherever the origin answered a 3xx                                                                                 |
| `_static-export.json`                                                      | the manifest (see below)                                                                                                                   |
| `_headers`                                                                 | `X-Powered-By: Justflows` + browser-cache rules for Cloudflare Pages / Netlify                                                             |
| `.htaccess`, `_nginx.conf`                                                 | ready-to-use Apache / nginx config — serving, hardening, and a commented hand-off to the app (see [Web-server config](#web-server-config)) |

Link discovery is breadth-first from the sitemap + published entries, so menu
targets and `/slug/page/N` pagination are picked up automatically. `STATIC_EXPORT_MAX_PAGES`
(default 2000) caps a runaway crawl.

## Running an export

- **Admin → System → Tools → “Static site export”** — Run full export / Run
  incremental, with a live log. Administrator only.
- **`pnpm export:static`** (`node scripts/export-static.js [--incremental]
[--base-url http://127.0.0.1:3000]`) — for CI/cron. Needs a compiled server
  (`pnpm --filter @justflows/server build:server`) and a running site.
- **`justflows export static [--incremental]`** — posts to the admin API
  (`ADMIN_URL`, same auth rules as `justflows cache clear`).

The admin card and the CLI go through `POST /api/static-export/run`;
`pnpm export:static` calls `runStaticExport()` in
`apps/server/src/lib/static-export/` directly.

### Try it locally

The exporter always crawls a **running** site over loopback, so start one first,
then run the export against it.

```bash
# terminal 1 — a local site for the crawler to read (dev or prod build both work)
pnpm --filter @justflows/server dev            # http://localhost:3000

# terminal 2 — build the compiled bundle the CLI needs, then export
pnpm --filter @justflows/server build:server   # writes apps/server/dist/**
pnpm export:static                             # crawls :3000, writes ./static-export
```

`pnpm export:static -- --incremental` does a delta run; `-- --base-url
http://127.0.0.1:PORT` points it at a non-default port.

No CLI: `pnpm --filter @justflows/server build && pnpm --filter @justflows/server
start`, then **Admin → System → Tools → “Static site export” → Run full export**.

Preview the result the way a static host serves it — directory `index.html`,
no Node origin:

```bash
npx serve static-export -l 5000                # http://localhost:5000
```

Outside production, any `localhost` port is CORS-allowed, so form submits and the
analytics beacon still reach `http://localhost:3000` from the previewed pages
(or set `STATIC_EXPORT_ORIGIN_URL` — see [Dynamic features](#dynamic-features)).

## Configuration

| Variable                        | Default              | Purpose                                                                                                                                                                                                                           |
| ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STATIC_EXPORT_ENABLED`         | `1`                  | master switch; `0` refuses the Run actions and auto-rebuild (existing files are left on disk — see [Turning it off](#turning-it-off))                                                                                             |
| `STATIC_EXPORT_DIR`             | `./static-export`    | output directory (relative to the install root)                                                                                                                                                                                   |
| `STATIC_EXPORT_BASE_URL`        | `APP_URL`            | public origin recorded in the manifest and used to recognise same-origin links while crawling — see the SEO note below                                                                                                            |
| `STATIC_EXPORT_CRAWL_URL`       | loopback / `APP_URL` | origin the crawler fetches pages from; blank reads this server directly (loopback in dev, `APP_URL` on production). Set it to your public domain when the app runs behind Passenger / Plesk, where a loopback port is unreachable |
| `STATIC_EXPORT_ORIGIN_URL`      | _(empty)_            | origin that still serves form/comment POST; when set, `<form action>` in the output is rewritten to absolute URLs against it (see [Dynamic features](#dynamic-features))                                                          |
| `STATIC_EXPORT_ALLOWED_ORIGINS` | _(empty)_            | extra origins allowed to cross-origin `fetch()` the submit endpoints (CORS), comma-separated; `APP_URL` / `STATIC_EXPORT_BASE_URL` and (off production) `localhost` are always allowed                                            |
| `STATIC_EXPORT_MAX_PAGES`       | `2000`               | crawl ceiling                                                                                                                                                                                                                     |
| `STATIC_EXPORT_CONCURRENCY`     | `4`                  | parallel fetches                                                                                                                                                                                                                  |
| `STATIC_EXPORT_AUTO`            | `0`                  | rebuild after content/menu/theme/settings changes                                                                                                                                                                                 |
| `STATIC_EXPORT_DEBOUNCE_MS`     | `5000`               | quiet period that coalesces a burst of changes                                                                                                                                                                                    |

All of these can be edited from **Admin → System → Tools → “Static site export” →
Configuration** — the admin writes them to `.env` and applies them in place, no
restart (the auto-rebuild listener is re-armed on save). They can also be set
directly in `.env`.

Where the crawl fetches bytes from, in precedence order:

1. an explicit `--base-url` (CLI) or request-body `baseUrl` (admin API);
2. off production, the loopback port the admin request arrived on;
3. `STATIC_EXPORT_CRAWL_URL`, if set;
4. on production, `APP_URL` (then `STATIC_EXPORT_BASE_URL`);
5. `http://127.0.0.1:$PORT`.

So a plain Node deployment still crawls itself over loopback, while a proxied
host (Passenger, Plesk — no reachable loopback port) is crawled by its real
domain. If the resolved origin does not answer as this site, the exporter retries
once against `APP_URL` before giving up. `STATIC_EXPORT_BASE_URL` on its own only
affects the manifest and same-origin link detection, not the fetch origin.

### Turning it off

The export is an **artifact you generate**, not a running service — there is
nothing serving it from JustFlows. "Off" means, in order of how complete you
want it:

1. **Stop auto-rebuilds** — untick _Rebuild automatically_ (or `STATIC_EXPORT_AUTO=0`).
   Existing files stay; nothing regenerates.
2. **Disable the feature** — untick _Static export enabled_ (or
   `STATIC_EXPORT_ENABLED=0`). The Run actions and auto-rebuild are refused; the
   folder is untouched.
3. **Delete the files** — **Clear export** in the Tools card, or
   `pnpm export:static -- --clear` (`--force` to skip the "is this really an
   export folder?" check). This `rm -rf`s `STATIC_EXPORT_DIR`.
4. **Stop serving it** — point your web server / CDN away from the folder. That
   is entirely outside JustFlows.

Disabling never touches the live dynamic site, which keeps serving every page as
normal.

### SEO note: `APP_URL` vs `STATIC_EXPORT_BASE_URL`

Absolute URLs **inside the exported HTML/XML** — `<link rel="canonical">`,
Open Graph `og:url`, and every `<loc>` in `sitemap.xml` — are rendered by the
origin from **`APP_URL`**. The exporter does not rewrite them. So for a
production export, set `APP_URL` to the public origin the files will be served
from; then leave `STATIC_EXPORT_BASE_URL` unset (it inherits `APP_URL`).

Set `STATIC_EXPORT_BASE_URL` only when it must differ from `APP_URL` (e.g. a
staging crawl of a site whose `APP_URL` is production): it fixes the manifest
`publicUrl` and same-origin link detection, but the emitted canonical/sitemap
URLs still carry `APP_URL`.

## Rebuild & invalidation

Set `STATIC_EXPORT_AUTO=1` (needs `CACHE_REVALIDATE_ENABLED=1` — that is what
fires the trigger). After any change the exporter waits `STATIC_EXPORT_DEBOUNCE_MS`,
then runs an **incremental** export:

| Change                                                    | What rebuilds                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| publish / unpublish / update a page or post               | that page's routes (per the manifest `deps`), its translation siblings, every route with a dynamic list (blog/archive/home), `sitemap.xml`, and the syndication feeds |
| delete / unpublish so a URL now 404s                      | that page's files are **removed** and `sitemap.xml` + feeds are rewritten                                                                              |
| menu, theme, Customizer, CSS provider, or settings change | **every** route, plus `theme.css` and other assets                                                                                                     |
| newly published page                                      | picked up by the incremental run that publish triggers — discovery re-reads the live sitemap and published list and seeds any path not in the manifest |

A **full** export always prunes: any file under `STATIC_EXPORT_DIR` not produced
by the run is deleted (and emptied directories are cleaned up), so a full export
is the way to recover from a divergent tree.

Manual runs and incremental auto-runs both fire the `staticExport.completed` and
`staticExport.deploy` hooks — see below.

## Deploying the output

### Filesystem

Point a static web server (nginx, Caddy, Apache) at `STATIC_EXPORT_DIR`. Enable
“try `$uri/index.html`” so `/about` serves `about/index.html` — or just use the
generated config below.

### Web-server config

Every export writes two managed server-config files next to the pages, the
counterparts to `_headers` for Cloudflare Pages / Netlify (WordPress ships the
same pair):

| File          | For    | Use it                                                                     |
| ------------- | ------ | -------------------------------------------------------------------------- |
| `.htaccess`   | Apache | read automatically when the vhost's `AllowOverride` permits it             |
| `_nginx.conf` | nginx  | `include /abs/path/static-export/_nginx.conf;` inside a `server { }` block |

Both carry the same three things:

- **Serving** — directory index, a rewrite so extensionless routes such as
  `/contact` resolve to `contact/index.html`, and `ErrorDocument`/`error_page`
  pointing at the themed `404.html`.
- **Hardening** — no directory listing, dotfiles (`.git`, `.env`) and the
  export's own metadata (`_static-export.json`, `_headers`, …) denied, no
  script execution under `/uploads/` or anywhere else, and the security response
  headers `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Cross-Origin-Opener-Policy`, plus `X-Powered-By: Justflows`. HSTS is present
  but commented — uncomment it once every hostname is HTTPS.
- **The dynamic hand-off**, left for you to wire because it is host-specific:
  `_nginx.conf` routes the reserved prefixes (`/api`, the configured admin path,
  `/justflows-forms`, …) to `@fallback`, which you define in the vhost —
  `proxy_pass` to a Node process, Passenger, a unix socket, whatever this host
  uses. `.htaccess` ships that rule commented (a module like Passenger that
  already serves non-file requests needs no rule; a reverse proxy needs
  `mod_proxy` and one `RewriteRule`).

The first line of each file is a sentinel; while it is intact the next export
**regenerates the file**. Change or remove that line, or delete the file, and
the exporter leaves your version alone (the run logs `· .htaccess is
hand-edited — left as-is`). A full-export prune keeps both files either way.

They are inert on object storage / a CDN — those hosts use `_headers` (and the
proxy/cache rules you add there) instead.

> **Two different `.htaccess` files.** The one described here lives **inside
> `STATIC_EXPORT_DIR`** and serves the exported pages. Separately, Justflows
> writes and maintains a **site-root `.htaccess`** (at the install root, next to
> `server.js`) on install and refreshes it on each boot — it blocks direct HTTP
> access to the app's own files (`.env`, `data/`, `apps/`, …) for the common
> case where the vhost `DocumentRoot` is the install directory. Same sentinel
> rule: a hand-edited one (first line changed) is left alone. Neither file
> configures how requests reach the Node app — that stays in the vhost.

### Object storage / CDN

The exporter does **not** upload anything itself — no cloud SDK is bundled. Sync
the directory with whatever tool you already run, using the manifest for
`Cache-Control` and CDN invalidation:

```bash
# S3 + CloudFront
aws s3 sync ./static-export s3://my-bucket --delete
aws cloudfront create-invalidation --distribution-id XXXX --paths '/*'

# rclone (S3, GCS, R2, B2, …)
rclone sync ./static-export remote:my-bucket --checksum

# plain rsync to an edge box
rsync -a --delete ./static-export/ deploy@edge:/var/www/site/
```

`_static-export.json` lists, per file: `path`, `file`, `bytes`, `sha256`, and a
suggested `cacheControl`. These values follow **Tools → Performance suite →
Browser cache**: HTML uses its page TTL and stale-while-revalidate window,
assets use its static TTL, and disabling browser caching emits `no-store`.
The same values are written to `_headers`, which Cloudflare Pages and Netlify
apply automatically — along with a global `X-Powered-By: Justflows` rule so the
exported site sends the same identifying header as the dynamic origin. Other
hosts (nginx, S3+CloudFront, …) don't read `_headers`; add the equivalent
`add_header` / response-headers-policy there if you want the same headers.
Diff two manifests by `sha256` to build a precise CDN invalidation list instead
of purging everything.

### Automating the push

Register a `staticExport.deploy` action in a plugin. It receives
`{ outDir, publicUrl, manifest, summary }` after every successful run:

```js
ctx.hooks.action("staticExport.deploy", async ({ outDir }) => {
  await runSync(outDir); // your aws/rclone/rsync call
});
```

## Dynamic features

### What already works offline

The exported pages are complete server-rendered HTML plus the site's
client-side JavaScript. **Every same-origin sub-resource a page references is
downloaded into the export** — `/theme.css`, `/js/*`, uploads, and **plugin /
custom-theme scripts and assets** served from their own paths
(`/ext/<plugin>/…`, `/themes/<theme>/…`, and so on). The scanner reads
`<script src>`, `<link rel="stylesheet|preload|icon|…">`, `<img>`/`srcset`, and
CSS `url()` / `@import`; only the dynamic API surfaces (`/admin`, `/api`, the
auth and submit endpoints) are skipped. A plugin that loads something the
scanner cannot see — a dynamically-imported chunk, a Web Worker, a JSON config
fetched at runtime — adds it through the `staticExport.assets` filter.

A plugin's front-end needs **no export-specific work**: declare
`assets: { scripts: […] }` in its manifest (see
[PLUGINS.md](PLUGINS.md#client-side-assets)) and the host serves the files at
`/ext/<pluginId>/…` and injects the `<script>` tag on every page — which the
scanner then downloads like any other asset.

So menus, animations, the language switcher, and block/plugin/theme client code
all run on the static host with **no origin**. This is the same deal as a
Next.js `output: export`: the client bundle ships; anything that needs a server
calls it over the network (it is **not** "compiled into" the export — server
code always needs a server, see below).

### Forms submit in place

The Forms plugin ships `jf-forms.js` as a package asset (`manifest.assets`), so
it lands in the shared `/jf-plugins.<hash>.js` bundle the exporter already
downloads. It hydrates each `justflows.forms.form` block and, instead of a
native `<form method="post">` navigation, submits by `fetch()` and swaps the
form for the confirmation **without leaving the page**. The plugin's endpoint
(`/justflows-forms/submit`, one of its own `ctx.http` routes) still has to be
reachable — via the hybrid proxy or `STATIC_EXPORT_ORIGIN_URL` below. If
`fetch` fails it falls back to the native POST. Comment posting still does a
native round-trip.

### Pageview analytics keep counting

When the first-party **Analytics plugin is active at export time**, its
`jf-analytics.js` beacon rides the shared `/jf-plugins.<hash>.js` bundle into
the export (via `manifest.assets`, like the Forms script). On load it POSTs
`{ path }` to `/justflows-analytics/collect` — the same trick Plausible / GA use
— so the counters still fill even though no server render happens (hybrid:
same-origin; split-origin: to the origin URL, dropped into the page as
`window.__JF_ORIGIN__`). The beacon self-suppresses on the live dynamic site
(no `window.__JF_ORIGIN__` there), which counts server-side.

### Cookie consent keeps working

The **Cookie Consent plugin**'s runtime also ships in the shared bundle. The
config island, gated snippets, and gated embeds are all baked into the HTML at
export time, so the banner, preference center, and script/embed gating work with
no origin at all. Its two network calls — the consent-record beacon
(`/ext/justflows.consent/record`, a fire-and-forget image GET) and the
cookie-disclosure fetch (`/ext/justflows.consent/cookies`) — resolve against
`window.__JF_ORIGIN__`, so a split-origin export still reaches them. The
disclosure route returns `cors: true`, so the host answers it with
`Access-Control-Allow-Origin` for a vouched-for export origin (`APP_URL`,
`STATIC_EXPORT_BASE_URL`, `STATIC_EXPORT_ALLOWED_ORIGINS`, or any `localhost`
port off production) — otherwise the table just stays hidden.

Because the banner is baked in, saving new consent settings has to re-crawl
every page. Its admin route returns `revalidate: true`, so with auto-rebuild on
the export regenerates on save — no manual **Run full export** needed. (This is
the generic `PluginHttpResponse.revalidate` path; any plugin with a bespoke
config route can use it — see [PLUGINS.md](PLUGINS.md#revalidate-after-a-config-write).)

### What needs a reachable origin

| Feature                                               | On a static host                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Preview** (`?preview=1`)                            | never crawled or exported                                                                                       |
| **Form submission** (`justflows.forms.form`)          | in-place via `fetch()` to `/justflows-forms/submit` — needs the endpoint reachable (hybrid or origin URL)       |
| **Comment submission** (`justflows.comments.thread`)  | native POST to `/justflows-comments/submit`; existing threads render at export time and are read-only otherwise |
| **Pageview analytics**                                | beacon to `/justflows-analytics/collect` — needs the endpoint reachable (hybrid or origin URL)                  |
| **Cookie consent records + disclosure**               | `/ext/justflows.consent/*` — banner/gating work offline; record log + cookie table need the endpoint reachable  |
| **Login / register / password reset / language POST** | origin only — never route these to the static host                                                              |
| **Search**                                            | needs the origin, or a client-side / third-party index                                                          |

Two ways to make the submit endpoint reachable:

**1. Hybrid (recommended).** The web server serves the static folder, and the
dynamic paths fall through to the app — same origin, so the `fetch()` needs no
CORS and nothing is configured in the exporter.

> The generated **`.htaccess` / `_nginx.conf`** (see
> [Web-server config](#web-server-config)) already implement everything in this
> section — serving, the dynamic-prefix carve-out, and hardening. The examples
> below are the same thing spelled out, for when you want to write the vhost by
> hand or understand what the generated files do. Either way you still define
> the app hand-off (`@fallback` / the proxy rule) yourself.

Point the location's `root` at the export directory and test the directory index
before the literal path. This serves extensionless routes such as `/contact` and
`/nl-NL` from `contact/index.html` and `nl-NL/index.html` without requiring a
trailing slash.

Give **only the published site** to the static folder. A bare `location /`
rooted at the export makes that folder the handler for the whole domain, so
every dynamic route — `/admin`, `/api/*`, login — reaches the app only by
falling through `try_files … @fallback`, and breaks the moment `@fallback` is
not an exact, working origin target. Carve the dynamic surface into its own
`location` blocks so those requests never touch the static layer. The dynamic
prefixes are fixed and reserved by Justflows (`isCrawlablePath` in
`crawl.ts`, `DENY_PREFIXES` in `assets.ts`) — except the admin path, which is
configurable (see the note after the Passenger example).

Example nginx in front of a standalone Node origin listening on port 3000:

```nginx
# --- dynamic app: never served from the static export ---
location ^~ /admin              { proxy_pass http://127.0.0.1:3000; }
location ^~ /api/               { proxy_pass http://127.0.0.1:3000; }
location ^~ /login              { proxy_pass http://127.0.0.1:3000; }
location ^~ /register           { proxy_pass http://127.0.0.1:3000; }
location ^~ /install            { proxy_pass http://127.0.0.1:3000; }
location ^~ /forgot-password    { proxy_pass http://127.0.0.1:3000; }
location ^~ /reset-password     { proxy_pass http://127.0.0.1:3000; }
location ^~ /set-locale         { proxy_pass http://127.0.0.1:3000; }
location ^~ /justflows-forms/       { proxy_pass http://127.0.0.1:3000; }
location ^~ /justflows-comments/    { proxy_pass http://127.0.0.1:3000; }
location ^~ /justflows-analytics/   { proxy_pass http://127.0.0.1:3000; }

# plugin assets are exported, but e.g. consent record/cookies are dynamic:
# serve the file if it exists, else hand off to the origin
location ^~ /ext/ {
  root /var/www/site/static-export;
  try_files $uri @origin;
}

# --- published site: static export, origin as fallback ---
location / {
  root /var/www/site/static-export;
  try_files $uri/index.html $uri @origin;
}
location @origin { proxy_pass http://127.0.0.1:3000; }
```

On Plesk with Phusion Passenger, do not proxy to port 3000: Passenger does not
normally expose the application on that port. Send the dynamic prefixes to a
named `@fallback` location that carries this vhost's **exact** `passenger_*`
directives (copy them from the generated config —
`grep -rn passenger /var/www/vhosts/system/<domain>/conf/`); replace the export
path with the absolute path shown for `STATIC_EXPORT_DIR` in
**Admin → System → Tools**. `try_files /_pass @fallback` uses a deliberately
missing path so the request always hands off to `@fallback`:

```nginx
# --- dynamic app: never served from the static export ---
location ^~ /admin              { try_files /_pass @fallback; }
location ^~ /api/               { try_files /_pass @fallback; }
location ^~ /login              { try_files /_pass @fallback; }
location ^~ /register           { try_files /_pass @fallback; }
location ^~ /install            { try_files /_pass @fallback; }
location ^~ /forgot-password    { try_files /_pass @fallback; }
location ^~ /reset-password     { try_files /_pass @fallback; }
location ^~ /set-locale         { try_files /_pass @fallback; }
location ^~ /justflows-forms/       { try_files /_pass @fallback; }
location ^~ /justflows-comments/    { try_files /_pass @fallback; }
location ^~ /justflows-analytics/   { try_files /_pass @fallback; }

# plugin assets are exported, but consent record/cookies are dynamic:
# serve the file if it exists, else hand off to the app
location ^~ /ext/ {
  root /var/www/vhosts/noobbase.com/justflows.noobbase.com/static-export;
  try_files $uri @fallback;
}

# --- published site: static export, app as fallback ---
location / {
  root /var/www/vhosts/noobbase.com/justflows.noobbase.com/static-export;
  try_files $uri/index.html $uri @fallback;
}

location @fallback {
  # EXACT passenger_* lines from this vhost's generated config
  passenger_enabled       on;
  passenger_app_root      /var/www/vhosts/noobbase.com/justflows.noobbase.com;
  passenger_app_type      node;
  passenger_startup_file  server.js;
  passenger_app_env       production;
  passenger_base_uri      /;
}
```

The `root` already points at `static-export`, so do not prefix the `try_files`
arguments with `/static-export`; doing both can create an internal redirect
cycle and an nginx 500 response. Before keeping the configuration, verify a
static route (`/`, `/contact`) **and** dynamic routes — the admin and
`/api/healthz`. A 500 on the dynamic routes means `@fallback` is not that
vhost's Passenger target.

**On Apache** the approach is identical — publish the site from the export
directory, send the dynamic prefixes to the app — only the syntax differs:
Apache has no `try_files`, so use `mod_rewrite` + `DirectoryIndex`.

**Apache + `mod_passenger` (Plesk).** Passenger already applies "serve the static
file if it exists, else hand to the app", so you spell out less than in nginx:
point the document root at the export, add the extensionless-route rewrite, and
let Passenger catch the rest.

```apache
DocumentRoot /var/www/vhosts/noobbase.com/justflows.noobbase.com/static-export

PassengerEnabled      on
PassengerAppRoot      /var/www/vhosts/noobbase.com/justflows.noobbase.com
PassengerAppType      node
PassengerStartupFile  server.js
PassengerAppEnv       production
PassengerBaseURI      /

<Directory /var/www/vhosts/noobbase.com/justflows.noobbase.com/static-export>
    Require all granted
    AllowOverride None
    DirectoryIndex index.html

    RewriteEngine On
    # dynamic surface: hand straight to Passenger, skip the static lookups
    RewriteRule ^(admin|api|login|register|install|forgot-password|reset-password|set-locale|justflows-forms|justflows-comments|justflows-analytics)(/|$) - [L]
    # extensionless published route -> its index.html when that file exists
    RewriteCond %{DOCUMENT_ROOT}/$1/index.html -f
    RewriteRule ^(.+?)/?$ /$1/index.html [L]
    # anything with no matching file falls through to Passenger automatically
</Directory>
```

`/ext/*` needs no special rule: the exported asset file is served if present,
otherwise Passenger answers the dynamic consent route.

**Apache reverse-proxying a standalone Node process.** Here you carve out the
dynamic prefixes explicitly, same as the nginx standalone example:

```apache
DocumentRoot /var/www/site/static-export
DirectoryIndex index.html
ProxyPreserveHost On

ProxyPass  /admin              http://127.0.0.1:3000/admin
ProxyPass  /api/               http://127.0.0.1:3000/api/
ProxyPass  /login              http://127.0.0.1:3000/login
ProxyPass  /register           http://127.0.0.1:3000/register
ProxyPass  /install            http://127.0.0.1:3000/install
ProxyPass  /forgot-password    http://127.0.0.1:3000/forgot-password
ProxyPass  /reset-password     http://127.0.0.1:3000/reset-password
ProxyPass  /set-locale         http://127.0.0.1:3000/set-locale
ProxyPass  /justflows-forms/       http://127.0.0.1:3000/justflows-forms/
ProxyPass  /justflows-comments/    http://127.0.0.1:3000/justflows-comments/
ProxyPass  /justflows-analytics/   http://127.0.0.1:3000/justflows-analytics/

<Directory /var/www/site/static-export>
    Require all granted
    RewriteEngine On
    # extensionless published route -> its index.html when that file exists
    RewriteCond %{DOCUMENT_ROOT}/$1/index.html -f
    RewriteRule ^(.+?)/?$ /$1/index.html [L]
    # no matching static file (incl. dynamic /ext/* routes) -> the origin
    RewriteCond %{DOCUMENT_ROOT}%{REQUEST_URI} !-f
    RewriteRule ^ http://127.0.0.1:3000%{REQUEST_URI} [P,L]
</Directory>
```

Same verification as nginx: check `/` and `/contact` (static) **and** the admin
and `/api/healthz` (dynamic).

**Renamed admin path.** The admin path is a site setting (`security.admin_path`,
default `/admin` — [`admin-path.ts`](../apps/server/src/lib/admin-path.ts)), so
it lives in the database, not anywhere nginx can read. If an admin renames it,
edit the `location ^~ /admin` line to match — or drop that line entirely: an
unknown admin slug is not a file in the export, so `location /` still falls
through to `@fallback` and the app answers it. Pin the slug in a file you
control with `JF_ADMIN_PATH_RECOVERY=/your-slug` in the app env if you want
nginx and the app to agree explicitly. Every other dynamic prefix is reserved
and never moves.

Cloudflare / CloudFront: add proxy / cache-bypass behaviours for the same
dynamic prefixes — `/admin*`, `/api/*`, `/login*`, `/register*`, `/install*`,
`/forgot-password*`, `/reset-password*`, `/set-locale*`, `/justflows-forms/*`,
`/justflows-comments/*`, `/justflows-analytics/*`, `/ext/*` — pointing at the
origin. Netlify `netlify.toml` / Vercel `vercel.json`: a `200`-status rewrite
for the same paths.

**2. Pure static + `STATIC_EXPORT_ORIGIN_URL`.** If the static host cannot proxy
anything, set `STATIC_EXPORT_ORIGIN_URL` to a still-running Node origin (or a
serverless function / third-party form endpoint via the `staticExport.formAction`
filter). The exporter rewrites `action="/justflows-forms/submit"` →
`action="<origin>/justflows-forms/submit"`, and `jf-forms.js` `fetch()`es it
cross-origin. The origin returns JSON + CORS headers **only for allowed
origins**: `APP_URL`, `STATIC_EXPORT_BASE_URL`, anything in
`STATIC_EXPORT_ALLOWED_ORIGINS`, and — outside production — any `localhost` port
(so `npx serve` works while testing). In the Tools card, **Use this site** fills
the origin field with this install's `APP_URL`.

> A same-origin hybrid setup needs no CORS and no allow-list — prefer it unless
> the host genuinely cannot proxy.

## Hooks

| Hook                      | Kind              | Use                                                                                                                |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `staticExport.routes`     | filter `string[]` | add/remove seed paths before the crawl                                                                             |
| `staticExport.assets`     | filter `string[]` | add same-origin asset URLs the scanner cannot discover (dynamic imports, workers, runtime-fetched JSON)            |
| `staticExport.formAction` | filter `string`   | override the `<form action>` written for a dynamic endpoint (`{ endpoint: "forms" \| "comments", defaultAction }`) |
| `staticExport.completed`  | action            | observe a finished run (`{ ok, mode, pages, assets, bytes, pruned, errors, … }`)                                   |
| `staticExport.deploy`     | action            | push the directory to object storage / a CDN                                                                       |

## Limitations

- Query-string URLs are not crawled (pagination is path-based).
- Assets on other hosts (an external CDN) are left as-is in the markup.
- One export runs at a time per process.
- The crawl needs the site installed and reachable — over loopback, or at
  `STATIC_EXPORT_CRAWL_URL` / `APP_URL` on a proxied host.

## See also

- [Cache](CACHE.md) — the `cache.revalidated` trigger the auto-rebuild listens on
- [Hooks](HOOKS.md) — full hook reference
- [Architecture](ARCHITECTURE.md) — public SEO rendering
