# Themes

Themes are **not** EJS template trees. Public pages use the core layout plus
rendered blocks. A theme supplies CSS, block patterns, and optional demo home
and blog layouts.

## Resolution order

`resolveThemeDir` in `apps/server/src/lib/theme-files.ts`:

1. The theme's stored `installedPath` (uploaded `.jfpkg`)
2. `packages-installed/themes/<id>/` (latest version folder)
3. Bundled `themes/<slug>/` (id `justflows.default` → `themes/default`)

A directory is a theme if it contains `justflows-theme.json` or
`justflows.json`.

## Compatibility manifest

Themes follow the same compatibility policy as plugins and CSS providers.
Declare the supported host range in the theme metadata:

```json
{
  "engines": {
    "justflows": ">=0.1.8 <0.2.0"
  }
}
```

For a packaged `.jfpkg`, the install contract is the archive-root
`justflows.json` with `type: "theme"`; the installer checks its range before the
theme leaves staging. `justflows-theme.json` is the runtime theme metadata and
should carry the same range so a source checkout or bundled theme states its
contract too. When both files ship, keep their ranges identical. See
[Manifest](MANIFEST.md), [Packaging](PACKAGING.md), and
[SDK compatibility](SDK-COMPATIBILITY.md).

## Files the host reads

| Path                    | Used for                                                 |
| ----------------------- | -------------------------------------------------------- |
| `styles/global.css`     | Concatenated into `/theme.css`                           |
| `styles/components.css` | Same                                                     |
| `styles/blocks.css`     | Same                                                     |
| `templates/*.json`      | Template hierarchy — page structure per request (below)  |
| `parts/*.json`          | Template parts (`header`, `footer`) shared by templates  |
| `patterns/*.json`       | Page-builder patterns                                    |
| `patterns/<type>.json`  | Starting canvas for a new `product` / `post` content row |
| `demo/home.json`        | Default home blocks when no home page is selected        |
| `demo/blog.json`        | Default blocks used when creating a blog page            |
| `demo/header.json`      | Site header chrome when no header-library default is set |
| `demo/footer.json`      | Site footer blocks when the site never customised one    |

The bundled Default theme includes a **Product detail** pattern (`patterns/product.json`)
plus **Product mosaic**, **Product story**, **Product list**, and **Ecommerce storefront**. Creating a `product` content row
(or opening one whose canvas is still empty) loads Product detail so the page
builder starts with a Shop gallery, buy box, specs accordion, reviews, and
related products instead of a blank canvas. Commerce values are tags (`{{title}}`,
`{{price}}`, `{{sku}}`, `{{stock}}`, `{{attributes}}`, …) filled from the Product
card and content fields when the page renders. Those patterns set
`requiresBlockTypes` for the Shop blocks they use. **Product list** is a catalog
grid (`justflows.shop.product-list`) for shop and category pages. **Ecommerce storefront**
is a homepage (`patterns/ecommerce-storefront.json`) with a hero image-tile collage,
category mosaic, story banner, favorites, and sale strip.

A pattern is a portable, versioned JSON document:

```json
{
  "schemaVersion": 1,
  "id": "hero",
  "title": "Hero",
  "category": "hero",
  "version": "1.0.0",
  "requiresBlockTypes": [],
  "blocks": [
    {
      "id": "hero-1",
      "type": "core.hero",
      "version": 1,
      "props": { "heading": "Hello", "subheading": "", "buttonLabel": "" }
    }
  ]
}
```

Register each file in `justflows-theme.json` as `"hero":
"./patterns/hero.json"`. Packaged themes are checked with the public
`BlockPatternSchema` and `ThemePatternRegistrationSchema` exports from
`@justflows/sdk`; unregistered, malformed, path-traversing, or mismatched-id
files are not exposed. Older themes without a `patterns` manifest key retain
directory discovery for compatibility.

Set `requiresBlockTypes` to the plugin block types a pattern uses (e.g.
`["justflows.forms.form"]`); the Patterns panel shows an install notice
instead of importing silently when one isn't in the active block catalog. The
schema also verifies that every non-core block used anywhere in the tree is
declared. Optional `locales` entries can override `title`, `description`, and
`blocks` for a BCP-47 locale; exact locale matches fall back to their base
language and then the default content.

Pattern JSON is data, never executable markup. Every source is schema-checked
and its blocks pass through the platform block sanitizer before preview or
insertion. The optional hosted directory is loaded only when an author asks for
it and is size- and time-bounded.

Plugins can also register runtime patterns with `ctx.patterns.register()`; see
[Plugins](PLUGINS.md#register-editor-patterns). Plugin registrations use the
same schema, localization, required-block checks, sanitation, categories, and
insertion behavior as theme patterns, and disappear automatically when their
plugin deactivates.

Platform block-animation CSS and the per-element device-visibility rules
(`data-jf-devices`, used by the builder's "Show on devices" control and the menu
designer) are appended to `/theme.css`, so every theme gets entrance / hover /
press effects and device targeting without shipping its own. Public pages also
load `/js/block-animations.js` for scroll-into-view playback, `/js/site-chrome.js`
for the light/dark and language widgets, and `/js/site-nav.js` for the menu
designer's flyouts, mobile drawer, and keyboard navigation (no inline script).

The menu designer renders its `.jf-nav` markup (`partials/nav-menu.ejs`) into the
theme's header and footer nav slots; the **theme** styles it. `themes/default`'s
`global.css` is the reference implementation — copy its `.jf-nav*` rules into a
custom theme, or restyle them, so every layout (`horizontal` … `drawer`) and the
mobile collapse patterns render.

## Template hierarchy

Modelled on
[WordPress](https://developer.wordpress.org/themes/templates/template-hierarchy/),
but the template body is a Justflows block document (`{ "blocks": [...] }`), not
PHP. A theme puts one JSON file per slot under `templates/`, and shared chrome
under `parts/`:

```
themes/<slug>/
  templates/
    index.json          # required fallback — every request lands here eventually
    front-page.json      # the site root "/"
    home.json            # the blog-posts index
    single.json          # any non-page content row
    single-<type>.json   # e.g. single-product.json
    single-<type>-<slug>.json
    page.json
    page-<slug>.json     # e.g. page-about.json
    singular.json        # shared fallback for single + page
    archive.json / archive-<type>.json
    search.json
    404.json
  parts/
    header.json
    footer.json
```

`templateCandidates()` in `apps/server/src/lib/template-hierarchy.ts` turns a
request into an ordered, most-specific-first list of slugs; `resolveThemeTemplate`
in `apps/server/src/lib/theme-files.ts` returns the first slug the theme actually
ships a file for. A `page` content type resolves through `page` → `singular`;
every other type through `single` → `singular`; both end at `index`.

Slugs are sanitised (`[a-z0-9-]`, lowercased) before they touch a filename.

### Context blocks

A template is a normal block document, but six blocks resolve the _current
request's_ content when they render inside one (`template-blocks.ts`):

| Block                 | Renders                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `core.post-content`   | the content row's own blocks. `wrap` prop: `none` (default), `post` → `<div class="block-content">`, `page` → adds `block-content--page` |
| `core.post-title`     | `<hN class="post-title">` — `level` prop, default 1                                                                                      |
| `core.post-meta`      | `<p class="post-meta">` with the formatted publish date                                                                                  |
| `core.post-excerpt`   | `<p class="post-excerpt">`                                                                                                               |
| `core.featured-image` | `<figure class="post-featured-image">` from `fields.seoImage`                                                                            |
| `core.template-part`  | embeds `parts/<slug>.json` — `slug` prop, `header` or `footer`                                                                           |

Dropped on an ordinary page (no template context) they degrade to an HTML
comment. They render through the `template` view, which supplies the `<main>`
(class from the content type: `site-main` / `site-main--page`).

### Editing templates (per-site overrides)

Theme builder → **Templates** lists every slot the theme ships plus any the site
has overridden. Editing one stores the block document in the `theme_templates`
table (`GET/PUT/DELETE /api/templates/:slug`, draft + publish, `THEME_CUSTOMIZE`
role) — the theme's file is left untouched and "Reset to theme" drops the row.
Resolution per request (`resolveEffectiveTemplate`): for each candidate slug, a
site override (its draft in preview) beats the theme's file; the first candidate
with either wins — so a theme's `single-post.json` still outranks a site's
customised `single`. `validateTemplateBlocks` flags block types no registered
block provides (usually an uninstalled plugin) — advisory, never blocking.

### Back-compat

Themes that predate `templates/` keep working: the `front-page` slot falls back
to `demo/home.json`, `home` to `demo/blog.json`, and the `footer` part to
`demo/footer.json`. Header chrome stays config-shaped (`demo/header.json`, see
below), not a block part. A theme that ships no template for a slot falls all
the way through to the built-in `single.ejs` / `home.ejs` / `404.ejs`.

## Stylesheet order

`/theme.css` is one stylesheet, so a later rule beats an earlier one of equal
specificity. `getEffectiveThemeCss` concatenates in this order:

1. **Theme styles** — `styles/*.css` from the theme package.
2. **Site tokens** — the Customizer palette, fonts, and sizes. These come after
   the theme so a colour picked in the admin overrides the theme's own `:root`.
3. **Block animations and device visibility** — platform defaults.
4. **Additional CSS** — what the editor typed, last, so it wins.

A theme should therefore treat its own `:root` as defaults, not as final values.

## Light and dark

The Customizer has two palettes: **Colors** and **Colors (dark mode)**. Dark
values are emitted twice, both after the theme's own rules:

```css
@media (prefers-color-scheme: dark) { html:not([data-theme]) { … } }
html[data-theme="dark"] { … }
```

The media query serves visitors who have not chosen and visitors without
JavaScript; the attribute serves an explicit choice. Only colours are
re-declared — fonts, sizes, and widths stay inherited from `:root`.

`/js/site-chrome.js` owns the switching. It reads `jf-color-scheme` from
`localStorage` (`light`, `dark`, or absent meaning follow the OS), then stamps
`data-theme` (the resolved theme) and `data-theme-preference` (the choice) on
`<html>`, and keeps following the OS live while nothing is stored.

The only contract for a switch is `data-jf-theme="light" | "dark" | "system"` on
any clickable element — the listener is delegated from `document`, so a theme or
plugin can render its own markup and needs no JavaScript of its own. Clicking
`system` clears the stored value. `aria-pressed` marks the _preference_ when a
`system` control exists anywhere on the page, and the resolved theme otherwise,
so a two-button widget still shows which way it is set.

For a single control, use `data-jf-theme="toggle"`: each click flips to the
opposite of the currently resolved theme, and the listener reflects state back
as `aria-pressed` (or `aria-checked` when the element has `role="switch"`) and
mirrors the resolved theme onto `data-jf-resolved="light" | "dark"`. The bundled
theme swaps the toggle glyph from `html[data-theme]`, which is stamped before
first paint, so the icon is correct with no flash. A compact
`<select data-jf-color-scheme-select>` whose option values are `light` / `dark`
/ `system` is driven by the same delegated `change` listener.

The bundled toggle is `core.color-scheme` (page-builder block). Its `style` prop
offers `buttons`, `icons`, `segmented`, `toggle`, `switch`, `select`, `labels`,
and `tooltip-icons`; `showSystem` adds the Auto option and `animate` (default
on, disabled under `prefers-reduced-motion`) transitions the icon. `size`
(`sm` / `md` / `lg`) and `radius` (`pill` / `rounded` / `square`) tune the
control, and `lightIcon` / `darkIcon` / `autoIcon` plus `lightLabel` /
`darkLabel` / `autoLabel` override the glyphs and text (blank keeps the
defaults; author values are HTML-escaped). The header's **Light / dark toggle**
switch is the other bundled entry point.

The default theme styles every colour, radius, and spacing the widget uses
through `--jf-color-scheme-*` custom properties with theme-token fallbacks, so a
theme or the Theme Customizer can restyle the hover, active, and focus states
without overriding rules:

```css
.jf-color-scheme {
  --jf-color-scheme-bg / -fg / -border;                /* resting */
  --jf-color-scheme-hover-bg / -hover-fg / -hover-border;
  --jf-color-scheme-active-bg / -active-fg / -active-border;
  --jf-color-scheme-focus;
  --jf-color-scheme-radius / -font-size / -gap;
  --jf-color-scheme-padding-y / -padding-x;
}
```

`--jf-color-scheme-hover-bg` and `-hover-fg` default to the resting background
and text, so hover only shows the border highlight until a theme (or the block's
Theme-styling panel) sets a fill. The builder surfaces the five colour hooks
(`active-bg`, `active-fg`, `hover-bg`, `hover-fg`, `hover-border`) in the
`core.color-scheme` block's **Theme styling → All theme variables** list, where
each writes an inline `--jf-color-scheme-*` onto the block, so an author can
recolour one instance without writing CSS. Theme-wide, set them in the theme's
`global.css` or Theme builder → Styles.

The `--size-*` and `--radius-*` modifier classes on the wrapper simply reassign
the same variables; target them (or a more specific selector) if a theme needs
to win over the author's size/radius choice.

The public home URL (`/`) renders a selected **page** when one is set as the
home page (Theme builder → Home page, or Content → Set as home page). Header
chrome (logo, title, menu) is per-page, with the theme Navigation settings as
the site default. Editors can also drop any page-builder block into a page
header.

## Blog layout

`demo/blog.json` has the same `{ blocks }` shape as `demo/home.json`. It is a
starting composition, not a permanent theme route: Theme builder → Blog can
promote it to an ordinary published page, after which the editor owns that
page's blocks and URL. A theme's default should include a
`justflows.blog.postList` block to render the current locale's published posts.

Any existing page can be selected instead. The blog-page setting marks the
canonical index for admin badges and links, but does not reserve `/blog` or
change routing; the page keeps its own slug. Pagination is relative to that
slug (`/news/page/2`, including locale prefixes).

## Theme header and footer

`demo/header.json` and `demo/footer.json` let a theme ship default site chrome,
resolved live at render the same way `demo/home.json` is — nothing is written to
the database on activation, and an admin edit always wins.

- **Footer** — `{ "blocks": [...] }`, same shape as `demo/blog.json`. Used only
  when the site has no saved footer template part. Theme builder → Footer seeds
  its canvas from this file (`GET /api/template-parts/footer` returns it with
  `fromThemeDefault: true`); publishing there promotes it to a real part. A
  non-empty footer replaces the built-in menu + credit line, so include your own
  credit if you want one.
- **Header** — a sparse `PageHeaderConfig` object (`layout`, `sticky`,
  `showLogo`, `showTitle`, `menuMode`, `showLanguageSwitcher`,
  `languageSwitcherStyle`, `showColorScheme`, `showColorSchemeSystem`,
  `showAuthLinks`, …). Merged over `DEFAULT_PAGE_HEADER` and used only when the
  header library (Theme builder → Header) has no default entry. Every value is
  re-validated by `parsePageHeader`, so an unsafe `background` is dropped. A page
  that picks its own header, or `__none__`, still overrides this.

## New-content patterns

`patterns/product.json` and `patterns/post.json` double as the starting canvas
for a new content row of that type whose editor is opened empty (see
`defaultBlocksForContentType`). The match is by an explicit type allowlist
(`product`, `post`) — a custom content type named after some other pattern does
not inherit it.

## Design tokens

The Customizer is schema-driven: `modsToCssVariables` walks
`THEME_CUSTOMIZE_SCHEMA` and emits every control whose key is a CSS custom
property, so adding a control adds a token without touching the emitter.

| Section                     | Tokens                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| Colors / Colors (dark mode) | `--color-*`                                                                                           |
| Typography                  | `--font-sans`, `--font-mono`, base size                                                               |
| Headings                    | `--font-heading`, `--heading-weight`, `--heading-line`, `--heading-tracking`, `--h1-size`…`--h3-size` |
| Spacing                     | `--space-unit-base`, `--block-gap`                                                                    |
| Corners                     | `--radius-sm`, `--radius-md`, `--radius-lg`                                                           |
| Shadows                     | `--shadow-sm`, `--shadow-md`                                                                          |
| Layout                      | `--max-width`, `--max-width-wide`                                                                     |

Each control type carries its own validation: `color` against a colour grammar,
`font` against a font-stack grammar, `range` clamped to the control's bounds and
suffixed with its unit, and `select` against the control's own option list. A
`select` is how a value such as a box-shadow — full of commas and parentheses —
can be offered at all: the allowlist is the check, so no general value grammar
has to admit those characters.

One number drives spacing. The theme defines `--space-1` … `--space-8` as
multiples of `--space-unit`, and the mobile breakpoint lowers the unit, so every
spacing decision on the site tightens at once.

Headings stay fluid: the Customizer's size is the _ceiling_ of a `clamp()`, not
a fixed size, so a heading chosen on a desktop still scales down.

## Theme-contributed controls

A theme package adds its own Customizer sections through a `customize` block in
`justflows-theme.json`. `schemaWithThemeControls` merges them onto
`THEME_CUSTOMIZE_SCHEMA` for the active theme, and because the whole mods
pipeline (`defaultModsFromSchema`, `mergeMods`, `modsToCssVariables`) is
schema-driven, the values flow straight to `:root` — no emitter change.

```json
"customize": {
  "brand": {
    "label": "Brand",
    "controls": {
      "--brand-accent":  { "label": "Accent",       "type": "color",  "default": "#00b0ff" },
      "--brand-shadow":  { "label": "Shadow offset", "type": "range",  "default": 8, "min": 0, "max": 16, "unit": "px" },
      "--brand-border":  { "label": "Borders",       "type": "select", "default": "solid",
        "options": [{ "label": "Solid", "value": "solid" }, { "label": "Dashed", "value": "dashed" }] }
    }
  }
}
```

Rules: the section key must be a fresh camel/lower name (it may not shadow a
built-in section); every control **key** must be a `--custom-property`; and the
control **type** must be `color`, `range`, `select`, or `font` — the value-token
types `modsToCssVariables` already validates. A rejected value is simply not
emitted, so the theme's own `:root` default in `styles/global.css` stands. Write
that stylesheet against the tokens (`var(--brand-shadow)`, …) and the sliders in
the "Brand" panel repaint the site live.

## Per-block colours

`BlockStyle` (the Layout panel, stored as a block's `style` prop) carries
`background`, `textColor`, `accent`, and `opacity` alongside spacing and sizing.
Each colour is validated and written onto the block's own root element as both
the direct property and a `--jf-block-*` custom property (`background` /
`textColor` also accept `transparent` / `none` to clear a themed background). A
theme opts a specific nested element into the override with
`var(--jf-block-bg, …)` / `var(--jf-block-accent, …)`.

## Discovering a theme's variables

`GET /api/themes/style-tokens` returns every `--…` the active theme exposes —
built-in tokens plus its own `customize` sections plus the platform
`--jf-block-*` hooks — each with its label, current value, range bounds, and
(for `select` controls) the list of valid preset strings. The page builder's
per-block **Custom CSS** panel renders this list under the textarea: clicking a
variable inserts `& { --name: value; }` so an editor never has to guess a name
or a gradient string.

## First-class per-block controls

A `blockControls` map in the manifest names, per block type, the `customize`
control keys that should appear as **proper inspector fields** on that block —
no CSS at all:

```json
"blockControls": {
  "core.hero": ["--brand-gradient", "--brand-shadow"],
  "core.cta":  ["--brand-gradient"]
}
```

The builder's **Theme styling** panel renders each as a dropdown / slider /
colour picker (from the control's own type + options + bounds), defaulting to
"Theme default". `blockControls` is only a _curation_ hint: the panel also has
an **All theme variables** section listing every remaining `--…` the theme
declares, so any block can override any theme token without CSS — no
exceptions. A chosen value is stored in `style.vars` and written onto the
block's root element (by `withBlockChrome` on the server, and merged onto the
same element in the builder preview), so a `var(--brand-gradient)` in
`styles/global.css` resolves to the block's choice — the same
custom-property-cascade the `--jf-block-*` hooks use. `style.vars` keys must be
`--custom-properties` and values are narrowly validated (`;{}<>@`, comments and
`url(` are rejected) before they reach the `style` attribute.

The Layout panel's **Background** / **Text colour** likewise write a real
`background:` / `color:` onto the block's own root — an inline shorthand there
beats the theme's `.jf-hero { background: … }`, so a hero's striped background
(and any block's themed background) can be replaced or set to `transparent`
from the builder.

## Builder preview

`/theme.css?scope=.jf-theme-surface` returns the active theme's stylesheet with
every selector confined to one wrapper class (`:root` / `html` / `body` become
the wrapper; `@keyframes` stay global). The page builder links it and tags each
top-level block preview with `.jf-theme-surface`, so previews render with real
theme styling without the sheet repainting the admin chrome. `scopeThemeCss`
does this as a brace/string/comment-aware pass, not a regex.

## Template parts

Site-wide chrome edited as a document lives in the **`template_parts`** table —
one row per site per part, with a published `doc` and an optional `draft_doc`.
It is a design artifact, not a preference, so it has its own table rather than a
`site_settings` row. `template-parts-db.ts` is the storage layer; a one-time
boot backfill moves any pre-existing `site_settings` rows (`template_part.*`,
`template_part_draft.*`) into the table.

`footer` is a plain block document (`template-parts.ts`), edited under Theme
builder → Footer and rendered into the layout. An empty part is not an empty
footer — it means the site never customised one, so the built-in menu and credit
line stay. Publishing writes the published copy and clears the draft, so preview
immediately reflects what was published.

The `header` part is a **library** of named headers (`site-header.ts`), edited
under Theme builder → Header. One entry is the site default, rendered on every
page that has not chosen otherwise. Each page picks its header from a dropdown in
the page builder — the site default, a named entry, or _None_ — stored as
`fields.jfHeaderRef` (an unset ref follows the site default) and persisted
immediately via `PUT /api/content/:id/header-ref`, independent of the page's
Save. Each entry carries a base `PageHeaderConfig` plus sparse per-locale
overrides: a locale key present in `overrides` is merged over the base for that
locale only; everything else inherits. Draft/publish works exactly like the
footer. Older per-page headers (`fields.jfHeader`) are converted into library
entries once, on first boot.

Plugins and themes contribute their own header designs in code through the
`header.templates` hook — they appear in the same page dropdown (grouped _From
plugins_) and are `build()`-rendered at request time. `header.resolve` lets a
plugin own a page's header per request; `header.config` lets one adjust the
resolved header before render. See [HOOKS.md](HOOKS.md#contributing-a-header-design).

Presentation defaults (site title, tagline, colors) live in Customizer mods.
Behavior belongs in plugins via hooks.

### Search results

`/search` and locale-prefixed search URLs resolve the `search` template slot.
Place `core.post-content` in `templates/search.json` for the live form, filters,
results, and pagination. `themes/default/templates/search.json` is the minimal
example. [Search](SEARCH.md) documents CSS classes and the headless contract.
