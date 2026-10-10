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

## Register blocks

`ctx.blocks.register()` adds a block to the page builder. Its `schema` builds
the inspector: each key is one prop, and the field entry
(`PluginBlockField`) controls how it is edited.

| Field | Effect in the inspector |
| --- | --- |
| `type` | `string`, `textarea`, `number`, `boolean`, or `select` |
| `label`, `help` | Field label (defaults to the prop key) and one line of help |
| `default` | Shown while the prop is unset. Blocks start with empty props, so `validateProps` must apply the same default |
| `options`, `optionLabels` | Fixed choices and the text shown for each value |
| `optionsUrl` | Same-origin path the editor GETs for choices. It must answer `{ options: [{ value, label }] }` |
| `multiple` | Pick several choices as a searchable checklist. The prop is saved as a string array, in the order they were ticked |
| `showWhen` | `{ field, equals }`: show the field only while another prop equals that value or one of an array of values |

```ts
ctx.blocks.register({
  type: "acme.featured",
  version: 1,
  title: "Featured items",
  schema: {
    source: { type: "select", label: "Show", options: ["all", "picked"], optionLabels: { all: "Everything", picked: "Pick items" }, default: "all" },
    items: {
      type: "select",
      label: "Items",
      multiple: true,
      optionsUrl: "/ext/acme.featured/blocks/options/items",
      showWhen: { field: "source", equals: "picked" },
    },
  },
  validateProps: (raw) => ({ /* coerce and default every prop */ }),
  render: (props) => "…",
});
```

The options route is an ordinary plugin HTTP route; check the session and a
capability before answering. `render` is synchronous, so load live data in a
`content.blocks` filter and write it into the block props before render (Shop's
product list does this).

### Links and languages

Link to site pages with plain root paths such as `/shop` or
`/product/${slug}`. Do not add a locale prefix yourself. On a page rendered
in a non-default language (`/nl-NL/...`), the host prefixes internal
`<a href>` and `<form action>` targets in the rendered HTML. It also loads a
small script that does the same for links your client code adds later. The
host leaves alone paths that already have a locale, app routes (`/api`,
`/ext`, `/login`, the admin path), your registered HTTP routes, files (a dot
in the last segment), and `hreflang` links. If a page has no translation in
that language, `/nl-NL/<path>` shows the default-language entry with Dutch
site chrome. Its canonical URL points at the original.

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

## Placeholder images

When an image slot is empty, show the site's placeholder. Don't ship your own
fallback. `ctx.media` is synchronous, so a block's `render()` can call it, and
it needs no permission:

```ts
render(props) {
  const img = props.imageSrc
    ? `<img src="${esc(props.imageSrc)}" alt="${esc(props.alt)}">`
    : ctx.media.placeholderHtml("thumbnail", { className: "acme-card__img" });
  return `<div class="acme-card">${img}</div>`;
}
```

`placeholder(kind)` returns `{ kind, src, width, height, source }`, or `null`
when the site owner switched placeholders off. `placeholderHtml()` returns a
decorative, sized `<img class="jf-placeholder jf-placeholder--<kind>">`, or `""`
when placeholders are off.

A plain `<img src="/uploads/...">` in that markup is upgraded on the public
page to `<picture>` / `srcset` (WebP, and AVIF when it is enabled) whenever
the file has responsive variants. The block does not have to call
`renderMediaImage()` for that. Call it when the image needs a `sizes` value
other than `100vw`. See [Media and responsive images](MEDIA.md).

The core kinds are `generic` (4:3), `featured` (16:9), `thumbnail` (1:1),
`avatar`, and `og` (1200×630 PNG). An unknown kind gets `generic`.

To ship a default for a kind of your own, register it under your plugin id. It
appears in Admin → Settings → Placeholders, where the site owner can replace
it. It is removed on deactivate:

```ts
ctx.media.registerPlaceholder("acme.shop.product", {
  src: "/ext/acme.shop/product-placeholder.svg", // from manifest.assets.dir
  width: 800,
  height: 800,
  label: "Product image",
});
```

For each kind, the first match wins:

1. the site owner's image;
2. the `media.placeholder` filter;
3. your registered image;
4. the shipped default.

The filter is synchronous. Return another image, or `null` to leave the slot
empty:

```ts
ctx.hooks.filter("media.placeholder", (image, { kind }) =>
  kind === "avatar" ? { ...image!, src: "/ext/acme.avatars/face.svg" } : image,
);
```

`src` must be a site-root path or an `https:` URL; the host ignores anything
else. `/ext/<pluginId>/` serves images (`.svg`, `.png`, `.jpg`, `.webp`,
`.avif`, `.gif`) from your `manifest.assets.dir` as well as scripts and
stylesheets. SVGs are served with a sandboxing Content-Security-Policy.

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

## Page templates

A plugin that owns content types ships their page templates itself, so themes
stay plugin-agnostic. Declare a `templates` block and put block documents (the
same shape as a theme's `templates/*.json`) in that folder:

```jsonc
// justflows.json
"templates": { "dir": "templates" }   // default "templates"; relative, no ".."
```

```text
plugins/ecommerce/templates/
  single-product.json
  single-shop-cart.json
  single-shop-checkout.json
```

While the plugin is active, the host checks each template-hierarchy slug in this
order: the site's own override, then the active theme's file, then the plugin's
file. A theme can still restyle a plugin page by shipping the same slug, and a
plugin template beats the generic `single` / `singular` fallbacks. Deactivating
the plugin drops its templates. Ship the folder inside your `.jfpkg`.

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
[STATIC-EXPORT.md](STATIC-EXPORT.md). Pages that must stay live go through
[`staticExport.exclude`](#keep-a-page-out-of-the-static-export).

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

### Keep a page out of the static export

A page that differs per visitor (a cart, a checkout, an account page) or must
always show live data should not be frozen into a static export. List it with
the `staticExport.exclude` filter:

```ts
ctx.hooks.filter("staticExport.exclude", (exclusions) => [
  ...exclusions,
  { path: "/shop/checkout" }, // this page and everything below it
  { path: "/account", match: "exact" }, // only this page
]);
```

The exporter never crawls an excluded path, even when a page links to it. It
removes copies from earlier runs, and the generated `.htaccess` / `_nginx.conf`
route the path to the app. With `STATIC_EXPORT_ORIGIN_URL` set, links to it
point at that origin. Paths are literal, so add each locale's copy
(`/nl-NL/shop/checkout`) from `ctx.i18n.locales()`. See
[STATIC-EXPORT.md](STATIC-EXPORT.md#pages-a-plugin-keeps-live) for the path
rules.

### Host policy on a route

Plugin routes are not under `/api`, so the host CSRF middleware does not see
them. The dispatcher requires a session CSRF token on every non-GET route
unless that route opts out. A route is not rate-limited unless it asks. Pass
the policy as the third argument of `ctx.http.get` / `post` / `put` / `patch`
/ `delete`:

```ts
ctx.http.post("payments/hooks/:gateway/:token", handler, {
  csrf: false,
  rawBody: true,
  rateLimit: { limit: 60, windowMs: 60_000, key: "payment-hook" },
});
```

- `csrf: false` skips the session token. Use it only when the handler
  authenticates the call another way (a signed webhook, a public form with
  its own check). GET never requires CSRF.
- `rateLimit` is a per-IP ceiling the host enforces before the handler runs.
  `limit` is 1–10_000 requests per `windowMs` (1_000–3_600_000). `key` shares
  one counter across several routes of this plugin. Deactivating the plugin
  drops the ceiling with the route.
- `rawBody: true` puts the exact request bytes on `req.rawBody` for a
  signature check. The host does not forward those bytes to any other route.

The host does not special-case a plugin's URLs. A plugin that needs a public
mutation, a ceiling, or the raw body declares it here.

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
`ctx.databases.dropSchema()`. On a site other than the main site that call
deletes only that site's rows. `ctx.databases.clear()` does the same on
purpose. Changing topology after setup is a
migration, not a later settings toggle.

Set `"allowMultisite": true` in `justflows.json` when every row is stored with
`site_id` and another site can run the plugin without touching anyone else's
data. The plugin is still installed on the main site. That site turns on
**Allow on other sites** for each plugin. Another site can then activate or
deactivate it. It is not turned on there until that site does so. It shows the
version the main site installed, including after an update. It cannot
upload the package or remove the plugin.

`site_settings` is only for the site (title, timezone, mail, and other core
options). Plugin key-value rows go in `plugin_data`. Activation is
`plugins.status`. Domain records (a store, a catalog sidecar) go in the
plugin's own tables. Use `ctx.databases.upsert()` / `findOne()` / `find()` /
`delete()` for those tables, and `ctx.settings` only for small plugin keys such
as setup progress. `find()` is site-scoped and capped; `delete()` requires a
column match so a plugin cannot empty a table in one call. A `null` filter
value matches `IS NULL`, and an invalid column name is an error rather than
being ignored.

For work that must not race or half-finish (stock, orders, balances), use the
row primitives and `transaction()`. They run on PostgreSQL, MySQL, and MariaDB,
on the shared database or the plugin's separate one:

- `insert()` returns `false` instead of writing when a unique key already holds
  the value. Use it to claim an idempotency key or a provider event once.
- `update(table, where, values)` returns the number of matched rows, so a status
  in `where` works as compare-and-set.
- `increment(table, where, deltas, { min, set })` adds integer deltas in one
  statement and skips a row that would fall below `min`.
- `find()` / `findOne()` accept `orderBy` and `lock` (`SELECT … FOR UPDATE`).

```ts
await ctx.databases.transaction(async (tx) => {
  await tx.findOne("inventory", { id }, { lock: true });
  const moved = await tx.increment("inventory", { id }, { available: -qty }, { min: { available: 0 } });
  if (moved !== 1) throw new Error("Not enough stock");
  await tx.insert("stock_movements", { id: newId(), inventory_id: id, delta: -qty });
});
```

The transaction commits when the callback resolves and rolls back when it
throws. Any `ctx.databases` row call made while it runs joins it, including a
nested `transaction()`. A deadlock is retried up to three times, so keep
network calls and other side effects out of the callback.

`find()` reads at most 500 rows. To read a date range, or more rows than
that, add `range` and page with `after`: pass the `orderBy` values of the last
row you got, and every page starts after it. Order by a unique column last
(`id`) so no row is skipped or read twice.

```ts
let after;
for (;;) {
  const page = await ctx.databases.find("orders", {}, {
    range: { created_at: { gte: "2026-10-01 00:00:00", lt: "2026-11-01 00:00:00" } },
    orderBy: [{ column: "created_at" }, { column: "id" }],
    limit: 500,
    ...(after ? { after } : {}),
  });
  handle(page);
  if (page.length < 500) break;
  const last = page[page.length - 1];
  after = { created_at: last.created_at, id: last.id };
}
```

A range bound or an `after` value cannot be `null`, and `after` needs
`orderBy`. Older hosts ignore both options, so check rows yourself when your
plugin may run on one.

## Background jobs

With the `jobs:register` permission, `ctx.jobs.register()` runs a handler on a
five-part cron schedule (minute precision), and `ctx.jobs.enqueue()` runs a
registered job once, optionally after `delayMs`.

```ts
ctx.jobs.register({
  name: "reconcile",
  schedule: "*/5 * * * *",
  perSite: true,
  handler: async () => {
    await repairOpenWork(ctx);
    return { success: true };
  },
});
```

A plugin module is activated once per process, not once per site, so a job
without `perSite` runs once with no site context. With `perSite: true` the
host runs the handler once for each site where the plugin is active, inside
that site's context: `ctx.databases`, `ctx.settings`, `ctx.secrets`, and
`ctx.content` act on that site, on its own database when it has one. One
site's failure does not stop the others; `handler` receives the site in
`siteId`.

The scheduler runs in the server process and does not persist its queue. A
restart loses enqueued runs and in-flight attempts, so keep the work state in
your tables and make each run look at what is still open, rather than relying
on a job payload.

## Private files

With the `files:private` permission, `ctx.files` keeps files for the current
site that are never public, such as products sold as downloads. Keys are
relative paths (`downloads/<productId>/manual.pdf`); every file lives in the
site's and the plugin's own folder.

```ts
await ctx.files.put(`downloads/${productId}/manual.pdf`, buffer, { contentType: "application/pdf" });
const info = await ctx.files.get(`downloads/${productId}/manual.pdf`); // size, type, sha256, or null
await ctx.files.delete(`downloads/${productId}/manual.pdf`);
const all = await ctx.files.list("downloads/");
```

To send a file, answer a route with `file` after your own checks. The host
streams it from storage, honours `Range` (resumable downloads), and never
reveals where it is stored. A route can only send its own plugin's files on
the current site.

```ts
ctx.http.get("downloads/:token", async (req) => {
  const grant = await findGrant(req.params.token);
  if (!grant) return { status: 404, body: { error: "Not found" } };
  return { file: { key: grant.fileKey, filename: grant.name } };
});
```

To accept an upload, register the route with `binaryBody`: the request body
arrives as a `Buffer` (up to `maxBytes`, at most 1 GiB) instead of JSON, with
CSRF and rate limits as usual.

```ts
ctx.http.post("products/:id/files", async (req) => {
  const data = req.body as Buffer;
  await ctx.files.put(`downloads/${req.params.id}/${newId()}`, data, { contentType: req.headers["content-type"] });
  return { body: { ok: true } };
}, { binaryBody: { maxBytes: 512 * 1024 * 1024 } });
```

`put` checks the site's `files.count` and `files.bytes` limits and throws a
409 quota error when a file would pass them. Where the bytes go is the
operator's choice (Settings → Storage): the site's own S3-compatible
connection when its plan has `feature.ownStorage`, otherwise the root site's,
then the installation's `STORAGE_DRIVER=s3` bucket under `.private/` (unless
`STORAGE_S3_PUBLIC_URL` makes it public), then `PRIVATE_STORAGE_PATH` on the
server's disk. When the storage changes, a background job copies existing
files; until then they are read from where they were. `ctx.files` is optional
on the SDK type: older hosts do not have it.

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

`getPublished({ type, slug, locale })` returns one published entry with its
blocks, or `null` when none is published (or it is scheduled or expired). Look
it up by the default-locale slug; with `locale`, the published translation in
that language is returned when there is one. It requires `content:read`, and
older hosts do not have it, so call it as `ctx.content.getPublished?.(…)`. Shop
uses it to render every product in the shared layout kept on its Product detail
page:

```ts
const page = await ctx.content.getPublished?.({ type: "shop", slug: "product", locale: context.locale });
const blocks = page?.blocks ?? [];
```

`deleteCreatedBy(userId)` also requires `content:delete`. It permanently
deletes content that user authored, media they uploaded, and comments they
wrote, and it drops their unpublished working revisions on other entries. It
does not delete the user. It refuses when that user is an administrator, and
it does not remove anyone else's rows.

Admin → Plugins → Settings reads `settingsSchema` from the loaded module, then
`justflows.json`, then the stored row. `plugin.settings` / `plugin.settings.write`
overlay values on the plugin runtime. Saving returns the same schema and values
as loading, so the form does not go blank after Save.

Field `type` is `string`, `text`, `number`, `boolean`, or `select`. A `select`
lists `options` (`{ value, label }`) and/or names an `optionsSource` the host
fills in from the same lists core uses, so a plugin never ships its own copy:

| `optionsSource` | Choices | Stored value |
| --------------- | ------- | ------------ |
| `timezones` | Every IANA time zone, as Settings → General | `Europe/Amsterdam` |
| `countries` | Every ISO 3166-1 country, named in the site's language | `NL` |

Fixed `options` come first, which suits a blank "use the site's setting"
choice. Saving refuses a value that is not one of the choices.

```json
"timeZone": {
  "type": "select",
  "label": "Store time zone",
  "default": "",
  "options": [{ "value": "", "label": "Same as the site" }],
  "optionsSource": "timezones"
}
```

Plugin code reads the same data through `ctx.i18n`: `timeZone()` returns the
site's time zone (`UTC` when unset) and `countries(locale?)` the country list
with names, both for the site of the current request.

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
    "comingSoon": false,
    "beta": false
  }
}
```

- `commercialMarketplace` — internal: this plugin is live on the commercial Justflows marketplace.
- `listed` — publisher visibility. Internal approval does not show the plugin in Admin → Marketplace unless this is also true.
- `comingSoon` — the listing is visible so administrators know it is coming, but Install is disabled and `POST /api/marketplace/install` returns 403.
- `beta` — a pre-release build. The listing shows a Beta badge. Install stays disabled, and `POST /api/marketplace/install` returns 403 (`code: "beta_disabled"`), until an administrator turns on **Settings → Marketplace → Allow installing beta plugins and themes**. With that on, each install asks for confirmation with a warning first.
- `free` — set `false` and add `price`: `{ "amount": 49, "currency": "EUR", "interval": "year" }` for a paid listing.

Paid, coming-soon, or unlisted catalogue rows cannot be installed from the in-app Marketplace, and neither can beta rows unless the site allows them; paid listings send the administrator to justflows.com.


## Neutral API namespaces

Declare `apiNamespace` in both the exported plugin manifest and `justflows.json`
to expose relative HTTP routes without `/ext/<plugin-id>/` in frontend API URLs:

```ts
manifest: {
  id: "justflows.shop",
  apiNamespace: "shop",
  // ...the other manifest fields
}

// In activate(ctx):
ctx.http.get("checkout", async (request) => {
  // Apply your usual session/ownership checks here.
  return { body: await ownCheckout(request.session) };
});
const checkoutUrl = ctx.http.url("checkout"); // /api/shop/checkout
```

Browser bundles can import `pluginApiUrl("shop", "checkout")` from the SDK.
A plain browser script may use the same stable `/api/shop` base. Paths passed to
the helper are relative; query strings are preserved and traversal is refused.
The namespace is a lowercase slug of at most 40 characters. Core API namespaces
are reserved, and two plugins cannot claim the same namespace. Keep it stable
across upgrades; it is part of your plugin's public URL contract.

The host maps the neutral URL directly to the registered handler. It does not
redirect to `/ext/…` or make a second HTTP request. Legacy `/ext/<id>/…` routes
remain aliases, and a plugin without `apiNamespace` keeps its previous behavior.
Absolute well-known routes and plugin static assets keep their existing routing.
Frontend code must use the neutral URL; adding a manifest field alone cannot
change a URL hardcoded in an already installed browser script.

Both aliases preserve plugin activation/site allowlists, handler authorization,
CSRF policy, rate-limit counters, raw signed webhook bytes, and binary upload
limits. Ordinary mutations remain CSRF protected; registered `csrf: false`
webhooks keep their explicit exemption. Neutral plugin account routes at
`/api/<namespace>/account` and below also receive the host's mandatory private,
no-store policy. Sensitive handlers must still validate ownership on every call.

Shop demonstrates the migration in `plugins/ecommerce`; Hello World's `status`
route is available at `/api/hello-world/status`. Updating source requires building
and installing the updated plugin package before an installed site uses its
new manifest and browser assets.
