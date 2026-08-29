# Plugin author guide

Start from [`plugins/hello-world`](../plugins/hello-world). That folder is the
supported example: copy it, change the id, and build.

```bash
cp -R plugins/hello-world plugins/acme-seo
# edit plugins/acme-seo/package.json, justflows.json, and src/index.ts
pnpm --filter acme.seo build
```

The loader looks for `dist/index.js` or `index.js`. TypeScript in `src/` is not
loaded at runtime.

Do not put plugins under `packages/` — that tree is platform code.

## Lifecycle

A plugin module exports a default `PluginModule`:

```ts
import type { PluginModule } from "@justflows/sdk";

const plugin: PluginModule = {
  manifest: {
    id: "acme.seo",
    name: "Acme SEO",
    version: "1.0.0",
    license: "GPL-2.0-or-later",
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

`activate` receives `PluginContext`: hooks, settings (`plugin_data`, not
`site_settings`), logger, cache, HTTP routes, plugin-scoped data, encrypted
`secrets`, short-lived `databases` probes, table `upsert`/`findOne`,
`content.ensureType` / `content.ensurePage` / `content.deleteType`, and `blocks.register`. See
[HOOKS.md](HOOKS.md) and [PERMISSIONS.md](PERMISSIONS.md).

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
    await readFile(
      fileURLToPath(new URL("./styles/catalog.css", import.meta.url)),
      "utf8",
    )
  ).trim();

  ctx.hooks.filter("theme.css", (current) =>
    current.includes(MARKER)
      ? current
      : `${current}\n${MARKER}\n${stylesheet}\n`,
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
  { pluginId: ctx.pluginId, id: "reports", label: "Reports", path: "/admin/reports" },
]);
```

Paths that have no dedicated admin SPA page still open: the host renders a
generic plugin page for any `/admin/…` item on the live menu. Dedicated pages
(Analytics, Forms) keep their own routes.

```json
{
  "permissions": ["admin:extend"],
  "adminMenu": [
    {
      "id": "reports",
      "label": "Reports",
      "path": "/admin/reports",
      "icon": "📊",
      "domain": "extensions"
    }
  ]
}
```

`domain` is a left-sidebar group: `content`, `commerce`, `appearance`,
`extensions` (default), `security`, or `system`. `commerce` stays hidden until
a plugin contributes a page to it.

The path must be under `/admin/`. If the admin SPA has no dedicated page for it,
the host still opens a generic plugin page for that menu item. Several items in
the same sidebar `domain` appear as the top tab bar (the same pattern Content
uses). Set `end: true` on a parent path such as `/admin/shop` so
`/admin/shop/products` does not keep the parent tab selected.

The host loads `GET /ext/{pluginId}/setup` only on the plugin's `setupPath`.
Other `adminMenu` paths from that plugin get a landing page, not the wizard.
When more than one menu path could match the URL, the longest path wins.
Set `contentType` on a menu item to list every CMS entry of that type on the
page (Shop Products uses `product`). New entries open
`/admin/content/new?type=…`; existing rows open `/admin/content/{id}`. Shop
serves product commerce data from `GET`/`PUT /ext/justflows.shop/catalog/{contentId}`
(`?group=` is the translation group) and the content editor (create and edit)
shows those fields on type `product`. Creating a `product` content row also
inserts `shop_products` via `content.created`, keyed by `translationGroupId` so
every locale shares SKU, prices, and stock. Translating a product empties
title, excerpt, and SEO fields, copies the tagged layout, and does not insert a
second commerce row. The Default theme Product detail page-builder layout uses
`{{price}}`, `{{sku}}`, `{{title}}`, `{{excerpt}}`, `{{attributes}}`, and related
tags; Shop fills them on `content.blocks` (before HTML render) and
`content.render`. Shop also registers storefront blocks (`justflows.shop.gallery`,
buy box, product list, reviews, and the rest) used by the Default theme product
patterns and the **Ecommerce storefront** homepage pattern.
The layout is seeded only on the original locale when the
canvas is empty.

## First-run setup

A plugin that needs configuration before it is usable (database topology,
credentials, store identity) can declare `setupPath`:

```json
{
  "permissions": ["admin:extend"],
  "setupPath": "/admin/shop"
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
names are prefixed with the plugin slug (`justflows.shop` → `shop_products`) so
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
