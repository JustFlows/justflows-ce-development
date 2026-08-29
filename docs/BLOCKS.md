# Blocks
Plugins register blocks on `activate`:

```ts
ctx.blocks.register({
  type: "acme.cta",
  version: 1,
  title: "Call to action",
  category: "content",
  schema: {
    heading: { type: "string", required: true },
    href: { type: "string" },
  },
  render(props) {
    const heading = String(props.heading ?? "");
    const href = String(props.href ?? "#");
    return `<a class="acme-cta" href="${href}">${heading}</a>`;
  },
  validateProps(raw) {
    const props = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      heading: String(props.heading ?? ""),
      href: String(props.href ?? "#"),
    };
  },
});
```

`type` should be namespaced (`acme.cta`). Output goes through the platform
sanitizer — do not emit raw script tags. The editor catalog lists registered
blocks; public HTML is produced by the public renderer, not by the admin application.

## Props every block carries

Five props are handled by the platform, not by the block's own `render`, so a
plugin block gets them for free and must not define them itself:

| Prop            | Type   | Effect                                         |
| --------------- | ------ | ---------------------------------------------- |
| `animation`     | object | Entrance, hover, and press effects             |
| `className`     | string | Extra classes on the block's root element      |
| `css`           | string | CSS confined to this block instance            |
| `gridPlacement` | object | Where the block sits when its parent is a grid |
| `style`         | object | Spacing, size, alignment, corners and shadow   |

`layout` is available for a block's own schema (the bundled Gallery and Post
List blocks both use it). Grid positioning used that name in an early build,
which collided with Gallery's grid/masonry choice and caused the sanitizer to
drop it on save. Platform positioning now lives exclusively in
`gridPlacement`, leaving `layout` to block definitions.

`withBlockChrome` in `@justflows/blocks` applies all five to the HTML a block
returns, on every render path. A block whose `render` emits a single root
element gets them on that element; a fragment is wrapped in a `<div>`.

## Per-block CSS

The page-builder inspector has a **Custom CSS** panel per block. What an editor
types is rewritten so it can only reach that block:

```css
padding: 3rem 1rem; /* bare declarations apply to the block */
& h2 {
  font-size: 2.5rem;
} /* & is the block itself */
&:hover {
  background: var(--color-surface);
}
@media (max-width: 600px) {
  & {
    padding: 1rem;
  }
}
```

becomes, for a block with id `abc`:

```css
.jf-b-abc {
  padding: 3rem 1rem;
}
.jf-b-abc h2 {
  font-size: 2.5rem;
}
.jf-b-abc:hover {
  background: var(--color-surface);
}
@media (max-width: 600px) {
  .jf-b-abc {
    padding: 1rem;
  }
}
```

Rules are scoped by `scopeBlockCss`:

- A selector containing `&` has it replaced by the block's class.
- A selector without `&` is scoped as a descendant, so `html { display: none }`
  becomes `.jf-b-abc html { … }` and matches nothing.
- `@media`, `@supports`, `@container`, and `@layer` are recursed into.
- `@keyframes` and `@font-face` pass through — they are named, not scoped.
- Any other at-rule is dropped.

`sanitizeBlockCss` runs first, on save and again on render: `@import`,
`url(javascript:…)`, `expression()`, `behavior:`, `-moz-binding`, and anything
that could close the `<style>` element are rejected, after CSS escapes and
comments are resolved. A block over 8 KB of CSS is rejected whole. Rejected CSS
is dropped, not thrown — one bad block must not fail the save of a page.

The CSS ships as a `<style>` element immediately before the block's markup,
which needs `style-src` to permit inline styles. The shipped
Content-Security-Policy default does; a site that tightens it loses per-block
CSS along with every other inline style on the page.

`className` accepts letters, digits, hyphens, and underscores only — at most 12
classes. Use it to hook blocks up to theme-wide Additional CSS.

## Editing a block as JSON

The inspector's **Block JSON** panel edits the selected block directly — type,
version, props, and children. The block keeps its own `id` whatever the JSON
says, because the canvas selection, the undo history, and the block's scoped CSS
all point at it. Children without an `id` are given one.

This is the fastest way to set a prop no inspector field exposes, and the only
way to change a block's `type` in place.

With **nothing** selected the inspector shows the whole page instead — every
block, plus the page's header chrome when the builder is editing one:

```json
{
  "version": 1,
  "header": { "visible": true, "showColorScheme": true, "blocks": [] },
  "blocks": [ … ]
}
```

The draft mirrors the canvas until you type into it, then holds still, so
dragging a block around keeps the JSON current but a half-written edit is never
overwritten. When the canvas has moved on under a draft, the panel says so and
**Discard** loads the canvas version.

Applying preserves the `id` of every block that has one — this edits the page in
place rather than importing it, so scoped CSS and undo history stay pointed at
the same blocks. Only a block pasted in without an `id` gets a fresh one. A bare
array of blocks is accepted as well as a full document.

## Page and post builders

The visual builder edits both pages and post-like content. A page gets the full
library, including theme patterns, site-chrome widgets, and its per-page header.
Shop `product` and `shop` entries use the same page library so merchants can
import the Product detail pattern. A post gets the same block canvas and inspector
but omits those page-level tools, so its document stays focused on the article body.

URL fields on `core.button`, `core.hero`, `core.cta`, and `core.link-list` accept
ordinary typed URLs and can also pick a published page or post by title. The
picker stores a root-relative path such as `/about`; it does not create a live
reference to the content item. `core.image` uses the Media Library picker and
continues to store the selected media URL in `props.src`.

## Blog post lists

`justflows.blog.postList` is a platform block that turns any page into a blog
index. It queries published `post` content in the current locale, newest first.

| Prop                | Values / effect                                                |
| ------------------- | -------------------------------------------------------------- |
| `layout`            | `grid` or `list`                                               |
| `columns`           | 1–4 columns for the grid layout                                |
| `showFeaturedImage` | Uses the post's `seoImage` field when present                  |
| `showDate`          | Shows the localized publication date                           |
| `showExcerpt`       | Shows the post excerpt                                         |
| `postsPerPage`      | 1–100; `0` or omitted uses the site's `posts_per_page` setting |

Pagination is attached to the containing page rather than to a fixed `/blog`
route: a block on `/news` uses `/news/page/2`, and a localized `/nl/nieuws` page
uses `/nl/nieuws/page/2`. Requests for `/page/1` redirect to the canonical base
page. Theme authors can provide a ready-made index in `demo/blog.json`; see
[THEMES.md](THEMES.md).

`core.link-list` is the related general-purpose navigation block. Its `heading`
is optional and `items` is an ordered array of `{ label, url }`. URLs are
sanitized on save like other link-bearing core blocks.

## The grid

`core.grid` is a CSS Grid container. Placement lives on the **children**, not on
the grid, because a grid item is positioned by its own `grid-column` and
`grid-row`. That means any block type can be placed — there is no cell wrapper
to insert, and a plugin block gets it for free.

```json
{
  "type": "core.heading",
  "props": { "text": "Hi", "gridPlacement": { "col": 1, "span": 8, "row": 1 } }
}
```

| Key       | Meaning                                          | Range                 |
| --------- | ------------------------------------------------ | --------------------- |
| `col`     | 1-based start column                             | 1 … columns           |
| `span`    | width in columns                                 | 1 … columns − col + 1 |
| `row`     | 1-based row, `0` to flow into the next free cell | 0 … 200               |
| `rowSpan` | height in rows                                   | 1 … 20                |

`parseBlockPlacement` clamps `span` so a block can never spill past the last
column — a spill would add an implicit column and silently narrow every other
row. A placement that is just "full width" is not stored at all, so an ordinary
stacked block carries no extra props and no extra attributes.

`withBlockChrome` emits the placement as custom properties on the block's own
root element, which the theme reads:

```css
.jf-grid {
  grid-template-columns: repeat(var(--jf-grid-cols, 12), minmax(0, 1fr));
}
.jf-grid > * {
  grid-column: var(--jf-col, auto) / span var(--jf-span, 12);
}
```

### Responsive behaviour

Placement is one set of numbers, not one per breakpoint. Two fixed rules apply
instead:

- **≤ 900px** — explicit columns are dropped and blocks flow, but nothing goes
  below half width (`--jf-span-t`). Rows flow rather than staying pinned to a
  track that no longer matches the new spans.
- **≤ 640px** — every block is full width, in source order.

This is why placement is deliberately _not_ per-breakpoint: a two-column layout
authored at desktop width turns into unreadable slivers on a phone, and asking
an editor to maintain three sets of numbers to avoid that trades one problem for
a worse one.

### In the builder

Drag a block's badge to move it on the grid; drag either vertical edge to
resize. The inspector's **Position on the grid** panel takes exact numbers,
which is faster when two blocks need to line up precisely. Column guides appear
while dragging or while the grid is selected.

## Spacing and size

`style` gives every block the same spacing controls, on any block type:

| Key                             | Values                                           |
| ------------------------------- | ------------------------------------------------ |
| `padTop` / `padBottom` / `padX` | `"0"`–`"8"`, a step on the theme's spacing scale |
| `marginTop` / `marginBottom`    | the same steps                                   |
| `width`                         | `narrow`, `content`, `wide`, `full`              |
| `minHeight`                     | 0–100, in `vh`                                   |
| `alignSelf`                     | `start`, `center`, `end`, `stretch`              |
| `textAlign`                     | `left`, `center`, `right`                        |
| `radius`                        | `none`, `sm`, `md`, `lg`, `pill`                 |
| `shadow`                        | `none`, `sm`, `md`                               |

Every value is an allowlisted keyword, never a raw length or colour — these land
in a `style` attribute, so the allowlist _is_ the defence. Spacing is emitted as
`var(--space-N)` rather than a resolved length, which is what lets the theme pull
a whole page in at once on a phone by lowering one token.

A width also sets `margin-left/right: auto`, because a max-width says nothing
about where the slack goes.

## Reusable blocks

`core.reusable` is a reference, resolved on the server before rendering
(`resolveReusableBlocks`), not copied at insert time — that is the only reason to
have them: editing the saved block updates every page using it. Resolution is
depth-bounded, so a saved block that references itself is dropped rather than
spinning.

Saved blocks live in the `reusable_blocks` site setting and are stored already
sanitized. `PUT /api/reusable-blocks` revalidates the content cache, since every
page using the block now renders differently.

## Product tags

On Shop product pages, heading, paragraph, HTML, and Shop storefront blocks may
include tags such as `{{title}}`, `{{excerpt}}`, `{{price}}`, `{{comparePrice}}`,
`{{sku}}`, `{{stock}}`, `{{attributes}}`, and `{{dimensions}}`. The page builder
stores the tags; Shop replaces them from the Product card (and the content
title/excerpt) when the public page renders. Cost is never exposed.

## Shop storefront blocks

Shop registers `justflows.shop.*` blocks on activate (gallery, buy box,
breadcrumbs, highlights, accordion, policies, reviews, related products,
product list, and detail shots). The Default theme **Product detail** pattern
uses them; **Product mosaic**, **Product story**, **Product list**, and
**Ecommerce storefront** are extra layouts in the same library. Gallery `layout` is
`thumbs` (radio thumbnails, no JavaScript), `featured`, `mosaic`, or `single`. Product list `layout` is
`inline`, `cta`, `swatches`, `tall`, `overlay`, `simple`, `favorites`, `border`,
`supporting`, `hover`, or `cards` (catalog grids — CSS only, no React or
Heroicons). `lightbox` (on by default) opens a photo in the same CSS lightbox as
the media Gallery block — no script. Sample product photos are placeholders —
replace them from Media.
Add to cart is a link to `/cart` until checkout exists. These blocks are not
core; the Patterns panel asks you to install Shop when they are missing.
