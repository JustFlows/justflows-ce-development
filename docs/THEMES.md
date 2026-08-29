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

## Files the host reads

| Path                    | Used for                                          |
| ----------------------- | ------------------------------------------------- |
| `styles/global.css`     | Concatenated into `/theme.css`                    |
| `styles/components.css` | Same                                              |
| `styles/blocks.css`     | Same                                              |
| `patterns/*.json`       | Page-builder patterns                             |
| `demo/home.json`        | Default home blocks when no home page is selected |
| `demo/blog.json`        | Default blocks used when creating a blog page     |

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

A pattern is `{ id, title, description?, category?, requiresBlockTypes?, blocks }`.
Set `requiresBlockTypes` to the plugin block types a pattern uses (e.g.
`["justflows.forms.form"]`); the Patterns panel shows an install notice
instead of importing silently when one isn't in the active block catalog.

Platform block-animation CSS is appended to `/theme.css`, so every theme gets
entrance, hover, and press effects from the page builder. Public pages also load
`/js/block-animations.js` for scroll-into-view playback and `/js/site-chrome.js`
for the light/dark and language widgets (no inline script).

## Stylesheet order

`/theme.css` is one stylesheet, so a later rule beats an earlier one of equal
specificity. `getEffectiveThemeCss` concatenates in this order:

1. **Theme styles** — `styles/*.css` from the theme package.
2. **Site tokens** — the Customizer palette, fonts, and sizes. These come after
   the theme so a colour picked in the admin overrides the theme's own `:root`.
3. **Block animations** — platform defaults.
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

The bundled toggle is `core.color-scheme` (page-builder block, `showSystem` prop)
or the header's **Light / dark toggle** switch.

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

## Template parts

`footer` is a block document stored per site (`template_part.footer`), edited
under Theme builder → Footer, and rendered into the layout. An empty part is not
an empty footer — it means the site never customised one, so the built-in menu
and credit line stay. Publishing writes the published copy and clears the draft,
so preview immediately reflects what was published. The page header remains
per-page in the page builder.

Presentation defaults (site title, tagline, colors) live in Customizer mods.
Behavior belongs in plugins via hooks.
