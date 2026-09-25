# Plugin author guide

Start from [`plugins/hello-world`](../plugins/hello-world). That folder is the
supported example: copy it, change the id, and build.
The first-party Consent plugin lives in the separate plugin registry repository,
not in this checkout. It provides a fuller example: a stylesheet, sync and async
filters, HTTP routes, a bundled browser runtime, an admin page, and `plugin_data`
records with `deleteData` cleanup. Local example tests live in
`plugins/hello-world/tests/unit/`; see [local testing](TESTING-EXTENSIONS.md).

```bash
cp -R plugins/hello-world plugins/my-seo
# edit plugins/my-seo/package.json, justflows.json, and src/index.ts
pnpm --filter justflows.my-seo build
```

Every plugin id is **`justflows.<name>`** (lowercase, e.g. `justflows.seo`) —
first-party only. The `justflows.` namespace is what the admin URL
(`/admin/plugins/justflows.<name>`) and the asset mount
(`/ext/justflows.<name>/…`) are built from; the manifest validator rejects any
other id at install.

The loader looks for `dist/index.js` or `index.js`. TypeScript in `src/` is not
loaded at runtime.

Do not put plugins under `packages/` — that tree is platform code.

## Lifecycle

A plugin module exports a default `PluginModule`:

```ts
import type { PluginModule } from "@justflows/sdk";

const plugin: PluginModule = {
  manifest: {
    id: "justflows.seo",
    name: "SEO Toolkit",
    version: "1.0.0",
    license: "GPL-2.0-or-later",
    engines: { justflows: ">=0.1.8 <0.2.0" },
    permissions: [],
    main: "index.js",
  },
  activate(ctx) {
    ctx.hooks.action("content.published", (event) => {
      ctx.logger.info("published", { contentId: event.contentId });
    });
  },
  deactivate() {
    // optional — registered hooks are cleaned up for you
  },
  async deleteData(ctx) {
    // required — called when the plugin is deleted
    await ctx.data.clear();
  },
};

export default plugin;
```

The host exposes its versions as `ctx.runtime.justflows`, `ctx.runtime.sdk`, and
`ctx.runtime.sdkApi`. See [SDK-COMPATIBILITY.md](SDK-COMPATIBILITY.md) before
choosing a compatibility range or deprecating a public integration.

`activate` receives `PluginContext`: hooks, settings (`plugin_data`, not
`site_settings`), logger, cache, HTTP routes, plugin-scoped data, encrypted
`secrets`, short-lived `databases` probes, table `upsert`/`findOne`,
`content.ensureType` / `content.ensurePage` / `content.deleteType`,
`blocks.register`, `patterns.register`, and `cookies.declare` / `cookies.list`. See
[HOOKS.md](HOOKS.md) and [PERMISSIONS.md](PERMISSIONS.md).

## Register editor patterns

Plugins can contribute complete page designs or smaller sections to the block
editor with `ctx.patterns.register()`. Registration is synchronous, validated,
scoped to the plugin, and automatically removed when the plugin deactivates:

```ts
ctx.patterns.register({
  id: "feature-grid",
  title: "Product feature grid",
  description: "Three product benefits with an editable call to action.",
  category: "features",
  requiresBlockTypes: ["acme.cards.feature"],
  blocks: [
    {
      id: "features",
      type: "acme.cards.feature",
      version: 1,
      props: { heading: "Why customers choose us" },
    },
  ],
});
```

Pattern ids are local to the plugin; the host exposes the example above as
`acme.plugin:feature-grid`, so another plugin can safely use the same local id.
Every non-core block used anywhere in the tree must appear in
`requiresBlockTypes`. The shared SDK `BlockPatternSchema` validates the complete
tree, and the server sanitizes it before preview or insertion. Use category
`pages` only for a complete design that should replace the editor canvas after
confirmation; every other category appends to the current page.

The returned disposer removes that one registration early when needed. Plugins
can normally ignore it because deactivation removes all their patterns.

## Declare the cookies you set

Any plugin that writes a cookie that is **not strictly necessary** must declare
it so the site's consent banner can disclose it and expire it when its category
is withdrawn:

```ts
activate(ctx) {
  ctx.cookies.declare({
    name: "_ga_*",                 // exact name, or a prefix ending in "*"
    category: "analytics",         // necessary | preferences | analytics | marketing
    purpose: "Google Analytics session state",
    provider: "Google",
    duration: "13 months",
  });
}
```

Declarations are removed automatically on deactivate. `ctx.cookies.list()`
returns the whole site registry — the host's own cookies plus every active
plugin's — with the operator's category overrides applied
(`Admin → Extensions → Cookie Consent → Cookie declarations`, backed by
`GET`/`PUT /api/cookies`). Before setting a non-essential cookie from your own
client code, check `window.justflowsConsent?.allowed("<name>")`.

## Client-side assets

For a stylesheet folded into `/theme.css`, keep using the `theme.css` filter
(next section). For **JavaScript** — or a standalone stylesheet — that runs on
the public site, declare an `assets` block in the manifest and drop the files in
the package:

```jsonc
// justflows.json
"assets": {
  "dir": "public",              // default "public"; relative, may be "dist/public"
  "scripts": ["widget.js"],     // relative to dir; .js / .mjs
  "styles": ["widget.css"]      // relative to dir; .css
}
```

On activation the host:

- serves `<dir>/**` at `/ext/<pluginId>/**` (path-validated, correct
  `Content-Type`) for direct access, and
- **concatenates every active plugin's `scripts` / `styles` into one
  content-hashed bundle** and adds it to **every public page** right after the
  SEO head:
  `<link rel="stylesheet" href="/jf-plugins.<hash>.css">` +
  `<script src="/jf-plugins.<hash>.js" defer></script>`. One plugin script and
  one plugin stylesheet per page, whatever the plugin count; the hash changes
  when any plugin's files change (`Cache-Control: immutable`). Set
  `PLUGIN_ASSETS_BUNDLE=0` to emit a `<script>` per file instead (debugging).

No `ctx.http` route and no `html.head` filter. Deactivating the plugin drops
its route and rebuilds the bundle without it. The **static-site exporter
downloads the bundle automatically**, so a plugin's front-end works on a
static/CDN deployment with zero extra wiring — see
[STATIC-EXPORT.md](STATIC-EXPORT.md).

Each `scripts` entry is wrapped in its own IIFE before concatenation, so a
missing semicolon or a stray top-level `var` in one plugin can't break another;
write them as self-contained enhancement scripts (no `import`/`export` — a file
that needs modules must be pre-bundled).

Rules: paths are relative to `dir`, must be `.js`/`.mjs`/`.css`, and must not
contain `..`; at most 20 of each. Ship the `dir` inside your `.jfpkg`. Write
the scripts as progressive enhancement (the page is already server-rendered) and
load anything heavy on demand. A script that needs server data calls one of your
own `ctx.http` routes with `fetch()` — the same "client calls an API" pattern a
static host requires; server-side hook code (`content.published`, DB writes,
secrets) cannot run in a page and is never bundled.

Working example: `plugins/hello-world` (`public/hello-world.js` +
`assets` in `justflows.json`).

## Ship your own admin app

A plugin's admin screens are **its own app**, not React pages compiled into the
host bundle. Declare `adminApp` in the manifest, ship an HTML build in the
package, and the host mounts it in a same-origin `<iframe>` inside the admin
shell — the plugin owns the whole screen and its design; core carries no page,
route, or `if (pluginId === …)` for it.

```jsonc
// justflows.json — paths are relative to /admin/plugins/<your plugin id>;
// omit `path` for that namespace root.
"permissions": ["admin:extend"],
"adminMenu": [
  { "id": "forms", "label": "Forms", "icon": "✉", "domain": "extensions" }
],
"adminApp": {
  "dir": "admin",                       // default "admin"; relative, may be "dist/admin"
  "locales": {                          // required; paths are relative to dir
    "en": "locales/en.json",            // required fallback catalog
    "nl": "locales/nl.json"             // optional extra languages
  },
  "routes": [
    { "entry": "index.html", "title": "Forms" }   // no `path` → the namespace root
  ]
}
```

On activation the host:

- serves `<dir>/**` at `/ext/<pluginId>/admin/**` (path-validated, correct
  `Content-Type` for `.html/.js/.css/.json/.svg/.png/.woff2/…`). HTML is
  `no-store` and `frame-ancestors 'self'`; other build files get a short TTL.
  `admin/` is a **reserved sub-namespace** under `/ext/<pluginId>/` — a plugin
  that also ships `assets` cannot serve a literal `assets/admin/…` path.
- for every `adminMenu` item whose `path` matches an `adminApp` route, the
  sidebar entry loads `/ext/<pluginId>/admin/<entry>` in a frame instead of the
  generic plugin page. A route `title` overrides the menu label. A route path
  with no matching `adminMenu` item is not reachable — declare both.

**Host ⇄ frame bridge.** The two sides talk only over `postMessage` (use
`@justflows/admin-bridge`), never a shared React runtime:

| Direction     | Message                                           | Purpose                                                                         |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| plugin → host | `ready`                                           | frame mounted; host replies with `context`                                      |
| plugin → host | `resize { height }`                               | host sizes the iframe to fit                                                    |
| plugin → host | `navigate { path }`                               | host routes to another `/admin/…` page (or opens an `http(s)` URL in a new tab) |
| host → plugin | `context { locale, adminBase, routePath, theme, catalogs }` | sent on `ready` and on load. `catalogs` maps each `adminApp.locales` code to its `/ext/…/admin/…json` URL |
| host → plugin | `route { routePath }`                             | host URL changed under the plugin's path — follow it in the frame's own router  |

The frame is same-origin, so the plugin reads the CSRF cookie itself and calls
its **own** `ctx.http` routes for data — nothing is proxied through core. Server
work (DB, secrets, `content.published`) still lives in the plugin's `activate()`
module, exactly as for any plugin; only the screen moved into the frame.

Rules: `dir` and `entry` are relative, no `..`; `entry` must be `.html`; each
`path` is relative to `/admin/plugins/<your plugin id>` (omit it for the root);
at most 20 routes. Ship the `dir` inside your `.jfpkg`.

**Locales are part of the manifest.** An `adminApp` must declare `locales.en`.
That English file is the default catalog: the frame uses it whenever the admin
language has no catalog, and for any string missing from another language. Add
further codes (`nl`, `de`, `fr`, `es`, …) only when you ship those files. Paths
are relative to `dir`. Each file is a flat JSON object of string values, for
example `{ "save": "Save" }`. A minimal English catalog may contain only the
strings the screen shows. CI rejects a plugin manifest that ships `adminApp`
without `locales.en`, and rejects a declared path whose JSON file is missing.

## Ship your own stylesheet

Plugins own the CSS for the public components they render. Keep the source in
the plugin (for example `src/styles/plugin.css`), minify or copy it to
`dist/styles/plugin.css` during `pnpm build`, and append it through the async
`theme.css` filter during activation. Do not add plugin-specific rules to the
Default theme and do not inject a second `<link>` with `html.head`.

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@justflows/sdk";

const MARKER = "/* acme.catalog */";
let stylesheet: string | undefined;

async function registerStyles(ctx: PluginContext): Promise<void> {
  stylesheet ??= (
    await readFile(fileURLToPath(new URL("./styles/catalog.css", import.meta.url)), "utf8")
  ).trim();

  ctx.hooks.filter("theme.css", (current) =>
    current.includes(MARKER) ? current : `${current}\n${MARKER}\n${stylesheet}\n`,
  );
}
```

Call `await registerStyles(ctx)` from `activate()`. The filter runs once per
cached `/theme.css` build, not once per page request, and may be async. Reading
and caching the file before registering the filter keeps the filter itself
cheap. The assembled cascade is:

1. Theme styles.
2. Customizer tokens and platform block-animation CSS.
3. Active plugin styles.
4. The site owner's Additional CSS.

Additional CSS therefore remains the final override. Prefer the theme's public
custom properties (`--color-*`, `--space-*`, `--radius-*`, and related tokens)
so plugin UI follows the active design. Use plugin-namespaced classes and a
unique marker to avoid collisions and duplicate insertion.

Deactivation automatically disposes the filter; cache revalidation rebuilds
`/theme.css` without the plugin stylesheet. A plugin may contribute at most
512 KiB of CSS. Plugin CSS is trusted extension code and is not passed through
the editor's Custom CSS sanitizer, so never concatenate site or request data
into it. The stylesheet must be present below `dist/` when packaging a
`.jfpkg`. See the working implementations in `plugins/hello-world` and
the registry's
[`plugins/ecommerce`](https://github.com/JustFlows/plugin-registry-service/tree/main/plugins/ecommerce),
and the complete [`theme.css` hook contract](HOOKS.md#shipping-a-plugin-stylesheet).

Every plugin implements `deleteData`. The host calls it on Admin → Plugins →
Delete, before deactivation. Drop tables with `ctx.databases.dropSchema()` and
JSON rows with `ctx.data.clear()`. Remove CMS types the plugin created with
`ctx.content.deleteType()` (`content:delete`).

- **Silent:** always clean up inside `deleteData` (Hello World has nothing to drop).
- **Operator choice:** add boolean `deleteDataOnUninstall` and/or
  `deleteContentOnUninstall` fields to `settingsSchema` (SDK constants
  `PLUGIN_DELETE_DATA_SETTING` and `PLUGIN_DELETE_CONTENT_SETTING`) and honour
  them with `pluginShouldDeleteData(ctx)` / `pluginShouldDeleteContent(ctx)`.
  Shop does this — default is to drop `shop_*` tables and to delete Shop and
  Product pages and posts. Declare `contentTypes` on `justflows.json` so the
  host can delete those CMS types on uninstall even if the plugin hook fails.

## Admin pages

Declare `adminMenu` and request `admin:extend`. The sidebar reads
`GET /api/plugins/admin-menu` while the plugin is active — an installed-but-not-
yet-activated plugin (or a deactivated one) contributes nothing to the menu.

You can also append pages at activation time with the `admin.menu` filter
(same permission). That is the hook the host applies when it builds the sidebar:

```ts
ctx.hooks.filter("admin.menu", (items) => [
  ...items,
  { pluginId: ctx.pluginId, id: "reports", label: "Reports", path: "reports" },
]);
```

Paths that have no dedicated admin SPA page still open: if the plugin declares
an `adminApp` route for the path, the host frames the plugin's own screen (see
[Ship your own admin app](#ship-your-own-admin-app)); otherwise it renders a
generic plugin page for the menu item.

```json
{
  "permissions": ["admin:extend"],
  "adminMenu": [
    {
      "id": "reports",
      "label": "Reports",
      "path": "reports",
      "icon": "📊",
      "domain": "extensions"
    }
  ]
}
```

`domain` is a left-sidebar group: `content`, `commerce`, `appearance`,
`extensions` (default), `security`, or `system`. `commerce` stays hidden until
a plugin contributes a page to it.

**`path` is relative to your plugin's namespace `/admin/plugins/<your plugin
id>`.** Omit it (or `""`) for the namespace root; otherwise a lowercase leaf
like `"orders"` or `"orders/refunds"`. Never write a leading `/`, `admin`, your
plugin id, or a `.` — the host prepends `/admin/plugins/<id>/`, and an absolute
path is rejected at install. The id is dot-namespaced, so the resulting URL
always says whether a screen is core or plugin-owned. If the admin SPA has no
dedicated page for it, the host opens a generic plugin page for that menu item.
Several items in the same sidebar `domain` appear as the top tab bar (the same
pattern Content uses). Set `end: true` on the namespace-root item so a nested
page such as `orders` does not keep the parent tab selected.

The host loads `GET /ext/{pluginId}/setup` only on the plugin's `setupPath`.
Other `adminMenu` paths from that plugin get a landing page, not the wizard.
When more than one menu path could match the URL, the longest path wins.
Set `contentType` on a menu item to list that type on the page, one row per
translation group in the site's default language. Other languages are edited
on the content item. New entries open `/admin/content/new?type=…`; existing rows open
`/admin/content/{id}`. Give a second menu item the same `contentType`,
`listed: false`, and an `adminApp` route on that path, and the content editor
embeds that admin app while the row is open. The host passes `contentId` and
`translationGroupId` on the admin bridge and posts `save` when the editor
saves. The plugin can `reportSections` so the editor lists those entries in
its menu (Images, Pricing, Inventory, and the rest) and posts `section` when
the operator picks one. Without sections, the editor shows one item using the
menu label. The plugin reads and writes its own HTTP routes. Creating a content row
fires `content.created`. A plugin that needs a blank translation (empty title,
excerpt, and fields, shared commerce data) filters `content.translationSeed`.
A plugin that wants the page builder for its type filters `content.editor` and
appends the type slug on `content.patternTypes`. Merge-tag previews in the
builder come from `content.mergeTags`, which the editor loads at
`GET /api/content/{id}/merge-tags`.

### Revalidate after a config write

A plugin that persists its settings through its **own** `ctx.http` route (a
bespoke admin screen calling `PUT /ext/<id>/config`, say) bypasses the cache
revalidation that `PUT /api/plugins/<id>/settings` runs. If that config changes
what public pages render — anything injected via `html.head` / `analytics.head`
/ `content.render`, or a block's stored props — return `revalidate: true` from
the mutating handler:

```ts
ctx.http.put(`/ext/${ctx.pluginId}/config`, async (req) => {
  const next = await saveConfig(ctx, req.body);
  return { status: 200, body: next, revalidate: true };
});
```

The host then drops the page/site caches and, when static-export auto-rebuild
is on, regenerates the export — the same effect as a core settings change.
Ignored on `GET` and on a 4xx/5xx response. Leave it off for high-frequency
public routes (a form submission, a beacon) — it is for operator config writes.

A **public read** the runtime `fetch()`es from a statically-exported page runs
cross-origin when the export is served from its own host. Return `cors: true`
and the host adds `Access-Control-Allow-Origin` — but only for a vouched-for
origin (`APP_URL`, `STATIC_EXPORT_BASE_URL`, `STATIC_EXPORT_ALLOWED_ORIGINS`, or
`localhost` off production); plugins cannot set `Access-Control-*` themselves. A
plain `<img>` or `navigator.sendBeacon` GET is not CORS-checked and needs
nothing.

## First-run setup

A plugin that needs configuration before it is usable (database topology,
credentials, store identity) can declare `setupPath` — relative to the plugin
namespace like `adminMenu` paths. `""` is the namespace root; omit `setupPath`
entirely for "no setup wizard".

```json
{
  "permissions": ["admin:extend"],
  "setupPath": ""
}
```

Activating the plugin returns that path so Admin → Plugins can open it. The
generic plugin host then loads `GET /ext/{pluginId}/setup` **on that path
only**. If the JSON body is
`{ "kind": "setup", ... }`, the host renders a step guide from that payload
instead of the empty placeholder. Mutations go to `POST /ext/{pluginId}/setup`
with `{ "action": "next" | "back" | "probe" | "complete", "values": { ... } }`.
When `complete` is true, the host shows the plugin overview on `setupPath`;
plugin options stay on `/admin/plugins/{id}/settings`. Topology stays a
migration, not a later toggle.

Store passwords with `ctx.secrets` (encrypted, never returned on GET — use
`has()`). Probe the current Justflows database with `ctx.databases.probeShared()`,
or a separate database with `ctx.databases.probe(...)`. Remote hosts require
`network:outbound`. Create plugin-owned tables with `ctx.databases.ensureSchema()`;
names are prefixed with the plugin slug (`acme.forms` → `forms_entries`) so
an extension cannot create core tables. Drop them from `deleteData()` with
`ctx.databases.dropSchema()`. Changing topology after setup is a
migration, not a later settings toggle.

`site_settings` is only for the site (title, timezone, mail, and other core
options). Plugin key-value rows go in `plugin_data`. Activation is
`plugins.status`. Domain records (a store, a catalog sidecar) go in the
plugin's own tables. Use `ctx.databases.upsert()` / `findOne()` / `find()` /
`delete()` for those tables, and `ctx.settings` only for small plugin keys such
as setup progress. `find()` is site-scoped and capped; `delete()` requires a
column match so a plugin cannot empty a table in one call.

## Content types and pages

A plugin that needs CMS types or pages can create them from `activate()` with
`ctx.content`. When the type+slug already exists, `ensurePage` updates title
and excerpt. Pass `aliases` to rename a previous slug, and `create: false` to
repair without inserting a new page.

```ts
await ctx.content.ensureType({
  slug: "product",
  label: "Product",
  description: "Product detail pages",
});
await ctx.content.ensurePage({
  type: "shop",
  title: "Cart",
  slug: "cart",
  status: "published",
});
```

`ensureType` and `ensurePage` require `content:create`. Publishing a page
(`status: "published"`, the default is `draft`) also requires `content:publish`.
Built-in slugs `post` and `page` cannot be recreated.

`deleteType` requires `content:delete`. It removes every CMS entry of that type
(all locales) and then the type. Built-in slugs cannot be deleted. Shop exposes
**Delete shop pages and posts when this plugin is removed** so uninstall can
clear storefront pages and product posts as well as `shop_*` tables.

Admin → Plugins → Settings reads `settingsSchema` from the loaded module, then
`justflows.json`, then the stored row. `plugin.settings` / `plugin.settings.write`
overlay values on the plugin runtime. Saving returns the same schema and values
as loading, so the form does not go blank after Save.

## Two install paths

| Audience              | How                                                                      |
| --------------------- | ------------------------------------------------------------------------ |
| You, in this checkout | Folder under `plugins/`, build `dist/`, activate in Admin                |
| Site owners           | A `.jfpkg` dropped on Admin → Plugins — see [PACKAGING.md](PACKAGING.md) |

Marketplace listings must use a GPL-compatible license. See `LICENSING.md`.

Declare `registry` on `justflows.json` so the plugin registry can control the
listing without mixing it into site settings:

```json
{
  "registry": {
    "commercialMarketplace": false,
    "listed": true,
    "free": true,
    "comingSoon": false
  }
}
```

- `commercialMarketplace` — internal: this plugin is live on the commercial Justflows marketplace.
- `listed` — publisher visibility. Internal approval does not show the plugin in Admin → Marketplace unless this is also true.
- `comingSoon` — the listing is visible so administrators know it is coming, but Install is disabled and `POST /api/marketplace/install` returns 403.
- `free` — set `false` and add `price`: `{ "amount": 49, "currency": "EUR", "interval": "year" }` for a paid listing.

Paid, coming-soon, or unlisted catalogue rows cannot be installed from the in-app Marketplace; paid listings send the administrator to justflows.com.
