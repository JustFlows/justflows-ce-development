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

The stored document format, id and nesting rules, breakpoint overrides, and
block migrations are specified in [Builder document architecture](BUILDER-DOCUMENT.md).

## Props every block carries

Five props are handled by the platform, not by the block's own `render`, so a
plugin block gets them for free and must not define them itself:

| Prop            | Type   | Effect                                                                                                                                              |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `animation`     | object | Entrance, hover, and press effects                                                                                                                  |
| `className`     | string | Extra classes on the block's root element                                                                                                           |
| `css`           | string | CSS confined to this block instance                                                                                                                 |
| `gridPlacement` | object | Where the block sits when its parent is a grid                                                                                                      |
| `style`         | object | Spacing, size, alignment, corners, shadow, per-instance colours / opacity, and theme-variable overrides — see [Spacing and size](#spacing-and-size) |

`layout` is available for a block's own schema (the Post List block uses it).
Grid positioning used that name in an early build, which collided with a
block's own grid/masonry choice and caused the sanitizer to drop it on save. Platform positioning now lives exclusively in
`gridPlacement`, leaving `layout` to block definitions.

`withBlockChrome` in `@justflows/blocks` applies all five to the HTML a block
returns, on every render path. A block whose `render` emits a single root
element gets them on that element; a fragment is wrapped in a `<div>`. `core.html`
wraps its content in a `<div class="jf-html">` for this reason — custom HTML with
several top-level nodes would otherwise only style the first.

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

The visual builder edits pages and any content type a plugin marks with the
`content.editor` filter. A page always gets the full library, including theme
patterns and site-chrome widgets; it picks its header from the site header
library (built under Theme builder → Header) via a dropdown rather than editing
header chrome inline. A post gets the same block canvas and inspector but omits
those page-level tools, so its document stays focused on the article body.

Every block document (page, post, global header, footer, template) opens in the
same builder layout: a toolbar with the editing context, undo/redo, preview
width, zoom, and preview scheme; the block library; the canvas with breadcrumbs
for the selected block; and settings grouped into Content, Style, Layout,
Responsive, Interactions, and Advanced tabs. The global header, footer, and
templates are flagged as site-wide. Panel, width, zoom, and tab choices are
per-user browser preferences and are never stored in a document.

URL fields on `core.button`, `core.hero`, `core.cta`, and `core.link-list` accept
ordinary typed URLs and can also pick a published page or post by title. The
picker stores a root-relative path such as `/about`; it does not create a live
reference to the content item. `core.image` uses the Media Library picker and
continues to store the selected media URL in `props.src`.

`core.image` also renders responsive markup. When `props.src` points at an
uploaded file with generated derivatives, the public renderer injects a
`responsive` prop (server-built and re-sanitised in `packages/blocks`) and the
block emits `<picture>` with WebP/AVIF `<source>` sets, a fallback `srcset`,
intrinsic `width`/`height`, `loading="lazy"`, and `decoding="async"`. Set
`props.loading` to `eager` for an above-the-fold image (adds
`fetchpriority="high"`), and `props.sizes` to a CSS `sizes` value. The focal
point comes from the Media Library, not the block. See
[Media and responsive images](MEDIA.md); `renderResponsiveImage` from
`@justflows/blocks` is exported for theme and plugin blocks that build their own
image markup. A plugin or theme that emits a plain `<img src="/uploads/...">`,
or a hero `background-image`, is upgraded to the same derivatives on the public
page, so it does not have to call the helper to get WebP/AVIF.

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

## Comments

`justflows.comments.thread` is a platform block that renders a post's approved,
threaded comments and an accessible submission form. Drop it on a post (or a
page) where discussion should appear — nothing renders unless the block is
present.

| Prop    | Values / effect                                   |
| ------- | ------------------------------------------------- |
| `title` | Heading above the thread (default `Comments`)     |
| `order` | `oldest` (default) or `newest` for top-level sort |

Where the block is placed the thread is always shown. Whether the submission
form is open is resolved from **Settings → Discussion** (site switch,
hold-for-moderation, `closeAfterDays`, CAPTCHA provider, length and depth
limits) and the post's own **Discussion** control (`inherit` / `open` /
`closed`, stored in `content.fields.comments`); with the site switch off a
placed block shows the existing thread and a "comments are closed" notice.
Submissions post to `POST /justflows-comments/submit` (same-origin checked, IP
rate limited, honeypot plus optional Turnstile, hCaptcha, or Google reCAPTCHA
v2/v3); replies pass
`?reply=<id>`; extra pages use `?comment-page=N`. Approved comments never expose
the commenter's email address or IP. Moderators work the queue in
**Admin → Comments**.

### CAPTCHA providers

Choose a provider under **Settings → Discussion**, then enter the site key and
secret key created for the site's public hostname. Justflows supports Cloudflare
Turnstile, hCaptcha, the Google reCAPTCHA v2 checkbox, and score-based Google
reCAPTCHA v3. The site key is placed in the public integration; the secret is
encrypted at rest and is never returned by the settings API.

For reCAPTCHA v3, choose a minimum score from `0` to `1` (default `0.5`). Higher
values are stricter. Justflows obtains the token immediately before submission
with the action `justflows_comment_submit`; the server requires that exact
action and rejects scores below the configured threshold. Use separate v2 and
v3 keys—Google key types are not interchangeable.

Every token is verified with the selected provider from the server, including
the visitor IP when available. Verification has a five-second timeout and fails
closed: a missing token, missing secret, provider error, timeout, or rejected
token prevents the comment from being stored. Provider-side hostname settings
bind keys to approved domains, and the providers reject expired or reused tokens.
Disabling CAPTCHA keeps the existing same-origin check, honeypot, and IP rate
limit in place.

**Restyling** — the markup uses stable BEM-ish classes (`.jf-comments`,
`.jf-comments__form`, `.jf-comment`, `.jf-comment__meta`, `.jf-comment__text`,
`.jf-comments__list--replies`, …) built on the theme's design tokens, so the
Customizer palette and any theme stylesheet (or the `theme.css` plugin filter)
restyle it. **Replacing the markup** — the `comments.render` filter
([HOOKS.md](HOOKS.md#filters)) hands a plugin the rendered HTML plus the
threaded `PublicComment[]` and form/policy state; return your own HTML for full
control. The submission endpoint, table, and moderation API stay the same.

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

`style` gives every block the same presentation controls, on any block type:

| Key                                   | Values                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `padTop` / `padBottom` / `padX`       | `"0"`–`"8"`, a step on the theme's spacing scale                  |
| `marginTop` / `marginBottom`          | the same steps                                                    |
| `width`                               | `narrow`, `content`, `wide`, `full`                               |
| `minHeight`                           | 0–100, in `vh`                                                    |
| `maxWidth` / `maxHeight`              | 0–10000, in `px` (0 = unset)                                      |
| `alignSelf`                           | `start`, `center`, `end`, `stretch`                               |
| `textAlign`                           | `left`, `center`, `right`                                         |
| `radius`                              | `none`, `sm`, `md`, `lg`, `pill`                                  |
| `shadow`                              | `none`, `sm`, `md`                                                |
| `background` / `textColor` / `accent` | a validated CSS colour; `transparent` / `none` clear a background |
| `opacity`                             | `"0"`–`"100"` (percent string; `""` = unset)                      |
| `vars`                                | `{ "--custom-property": "<narrowly-validated value>" }`           |

Every value is an allowlisted keyword, a bounded number, or a validated colour —
never a raw length that could break out of the `style` attribute. Spacing is
emitted as `var(--space-N)` rather than a resolved length, which is what lets the
theme pull a whole page in at once on a phone by lowering one token.

`background` / `textColor` write the direct property **and** a `--jf-block-bg` /
`--jf-block-text` custom property onto the block's own root element (so an inline
value beats the theme's own `.jf-hero { background: … }`); `accent` writes
`--jf-block-accent`, which a theme opts a specific element into with
`var(--jf-block-accent, …)`. `vars` is the general form — set from the inspector's
**Theme styling** panel (driven by `manifest.blockControls` + `GET
/api/themes/style-tokens`), it lets one block override any theme variable the
theme exposes, e.g. `{ "--brand-gradient": "linear-gradient(…)" }`.

### Inspector visibility

The page and theme builders share the same block inspector. Every core type has
an explicit entry in `packages/blocks/src/inspector.ts`; adding a core block
without reviewing its generic controls fails the coverage test. Plugins retain
the defaults and can override them through their definition's `inspector`.

| Core blocks (without `core.`) | Sidebar treatment |
| --- | --- |
| paragraph, heading, site-title, site-tagline | Text controls; hide box decoration, viewport sizing and unused accent. |
| quote, link-list, html, group, column, cta, media-text, details, table-of-contents, content-query, search, account, auth-form | General box controls; hide unused accent. |
| columns, grid, features, buttons, accordion, callout, tabs, navigation, breadcrumbs, social-links | Child layout controls; hide ineffective text alignment and accent. |
| section, container, hero, cover, card | Hide generic fields duplicated by the block's own padding, width, alignment, height or decoration controls. |
| image | Hide media-inapplicable fields; caption alignment and colour appear when there is a caption. |
| video, audio, file | Keep figure/caption styling; hide misleading player sizing/decorations and unused accent. |
| button, icon | Hide ineffective text alignment and viewport sizing; Icon uses its own size and colour. |
| code, embed | Hide ineffective text alignment; Embed also hides inherited text colour. |
| list, list-item | Numbered-list fields depend on list style; checkbox state depends on the list parent. Checklist accent belongs on the list. |
| table, tab | Table uses its own cell alignment; Tab uses its parent's sizing and motion. |
| site-logo | Logo width belongs to the image; hide text colour and viewport height controls on its wrapper. |
| color-scheme, language-switcher, auth-links | Hide duplicate alignment and irrelevant height/accent; toggle variants and link visibility determine which labels/icons apply. |
| divider, spacer, reusable | Minimal controls: Divider hides text/vertical-content styling, Spacer keeps Advanced, and Reusable has no generic presentation controls. |

Theme controls show only variables curated for that block by the theme and
existing overrides. A stored generic value remains editable even when its field
would normally be hidden. Clearing it restores the clean panel. A saved theme
variable does not reveal the entire token catalog. Conditional block fields use
schema `showWhen` hints (for example, Cover playback controls require video).
Switching a controlling choice never deletes the hidden values. Blocks whose
schema owns `style` as a scalar value (such as the appearance widget variants)
do not offer generic style or theme-variable controls: those would overwrite
the variant. Their animation and Advanced controls remain available; existing
object-shaped style overrides can still be cleared.

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

## Block patterns

The builder's **Browse patterns** dialog combines the active theme's registered
patterns with site-owned patterns and, on request, the hosted directory. A
pattern previews at the real 900px editor width with the active theme stylesheet.
Section patterns (hero, features, pricing, testimonial, CTA, FAQ, and site
patterns) append to the existing canvas with fresh block ids, so adding one
never discards the page being edited. Only patterns in the `pages` category are
treated as complete designs; inserting one asks for confirmation before it
replaces the canvas. A site pattern saved as **synced** inserts one
`core.reusable` reference instead, so updating the saved pattern updates every
inserted copy.

**Save selection as pattern** captures the selected block subtree, or the full
canvas when no block is selected. Site patterns can be
exported as a versioned `{ "schemaVersion": 1, "patterns": [...] }` JSON set and
imported into another site. Imports, theme files, and directory responses share
the SDK `PatternSetSchema` / `BlockPatternSchema` validation and authoritative
block sanitation. Locale-specific variants and the dialog's logical CSS keep
translated and right-to-left compositions usable without executable markup or
inline scripts.

## Merge tags

Heading, paragraph, HTML, and plugin blocks may include tags such as
`{{title}}` and `{{excerpt}}`. The page builder stores the tags. A plugin fills
its own keys through the `content.mergeTags` filter (editor preview) and
`content.blocks` / `content.render` (public render). The editor loads preview
values from `GET /api/content/{id}/merge-tags`.

## Plugin blocks and patterns

Plugins register blocks and patterns on activate. A pattern whose id matches a
content type seeds that type when the theme has no pattern of the same name and
the plugin has appended the type on `content.patternTypes`. The Patterns panel
hides a pattern until its `requiresBlockTypes` are installed.

## Built-in Search block

`core.search` is a first-party GET search form with `label`, `contentType`,
`taxonomy`, `term`, `showFilters`, and `limit` props. It appears in the Site
category and works in pages and site chrome. See [Search](SEARCH.md) for
visibility, pagination, query behavior, and locale-aware rendering.

### Video, Audio, and File

The Media category includes `core.video`, `core.audio`, and `core.file`. Paste a
site-relative or HTTPS media URL into the inspector and optionally add a caption.
Video and Audio support controls (on by default), autoplay, muted playback, loop,
and preload (`none`, `metadata`, or `auto`; default `metadata`). Browsers normally
require muted playback for autoplay. Builder previews show controls and disable
autoplay so media remains easy to inspect.

Video also supports a poster image (with the image-library picker), inline
playback, width and height (0 means automatic), and contain/cover/fill sizing.
File supports a link label and a download toggle; when no label is supplied the
filename is used. Browsers may open external files instead of downloading them.
Unsafe media URLs are rejected during document sanitation and rendering.

## Functional content and layout blocks

These blocks have inspector controls and use the shared per-block spacing, size,
colour, corners, shadow, custom CSS, and animation controls where supported by the
platform. Container blocks hold ordinary editable child blocks.

| Block | Configuration |
| --- | --- |
| `core.list` / `core.list-item` | Bullets, numbering, start number, reversed order, marker, gap, rich-text items, initial checklist state, nested lists. Checklist changes are local to the visitor and are not saved as submissions. |
| `core.table` | Cell editor with row/column additions and removal, row ordering, caption, header/footer rows, stripes, borders, padding, alignment, equal column widths. Up to 100 rows and 20 columns. |
| `core.details` | Summary, initial open state, marker, and child blocks. |
| `core.accordion` | Details children, gap, and single-open or multiple-open behaviour. |
| `core.cover` | Image/video URL, image alternative text, poster picker, focal point, minimum height, overlay colour/opacity, content position/alignment, video looping, play/pause labels, and child blocks. Videos have a pause control and pause for reduced motion. |
| `core.media-text` | Image/video URL, alternative text, poster, media side/width, fit, gap, vertical alignment, mobile stacking, and child blocks. |
| `core.buttons` | Button children, horizontal/vertical layout, alignment, gap, and wrapping. |
| `core.card` | Child blocks, padding, gap, border, corners, shadow, and alignment. |
| `core.icon` | Built-in icon, accessible label/decorative mode, size, colour, and stroke width. Arbitrary SVG is not accepted. |
| `core.callout` | Notice type, title, icon, dismissal, dismissal label, and child blocks. Dismissal is local to the current page visit. |
| `core.tabs` / `core.tab` | Editable panel titles/content, horizontal/vertical tabs, initial tab, accessible group label, and automatic/manual keyboard activation. |

In the builder, Details and tab panels remain visible for editing. The public
page applies the configured initial state. Without JavaScript, Details still
work and tab content remains readable. Public interactions are shipped in
`/js/block-interactions.js`; no external frontend library is required.

## Site-building blocks

- `core.site-logo`, `core.site-title`, `core.site-tagline`: live site identity,
  with logo width/alternative text, title heading level, and optional home links.
- `core.navigation`: existing header/footer menu or a custom menu slug, nested
  menu visibility, gap, accessible label, mobile collapse/breakpoint,
  activation, layout, and mobile menu style. Reuses the standard menu renderer
  and its mega-menu, keyboard, and device-visibility behaviour. Uses
  the request's existing menu visibility checks and locale.
- `core.breadcrumbs`: localized home link and current page, editable labels and
  separator. It does not invent parent links from URL segments.
- `core.social-links`: profile row editor with labels, URLs, icons, ordering,
  direction, gap, optional visible labels, and safe new-tab links.
- `core.table-of-contents`: page-heading links, configurable heading-level range,
  numbering, title, and empty-state visibility. Preserves existing unique
  heading IDs and opens enclosing Details or tab panels when following a link.
- `core.content-query`: published content by type, taxonomy/term, sort field and
  direction, item limit/offset, grid/list layout, columns, title level, image,
  excerpt and date visibility, empty text, and pagination labels. Its pagination
  parameter must end in `-page` (default `content-page`); use different keys for
  independent queries. Only publicly discoverable, published, non-trashed,
  non-future content in the current site and exact locale is returned.

Site identity, menus and query results resolve on the public server; the builder
identifies these live-data blocks and exposes their settings. Query item layouts
currently use configurable grid/list cards rather than arbitrary nested item
templates. Query data, permalink resolution and date settings are batched or
reused within a render. Paginated requests bypass shared HTML caching.
