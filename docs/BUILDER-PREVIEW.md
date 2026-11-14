# Builder preview and recovery

The page builder canvas aims to show a page as the public site renders it.
This page says how that is checked, where the canvas deliberately shows
something else, and what happens to a block the builder cannot show or edit.

## How the canvas matches the page

- **Plugin and theme blocks** are rendered by the server with the block's own
  `render` and shown as returned, after a builder-only sanitizer removes
  anything that could run code, load something or cover the builder (see
  [Plugin block previews](#plugin-block-previews)).
- **Core blocks** are drawn by the builder itself, so that text, images and
  links can be edited in place. Before drawing, the builder runs the block's
  own `validateProps` from `@justflows/blocks`, so a missing or invalid setting
  gets the same default as on the page.
- **Styles, presets and responsive values** come from the same functions in
  `@justflows/blocks` on both sides: block style declarations, preset classes
  (`jf-sp-*`) and breakpoint rules. On the canvas, breakpoint rules use a
  container query on the canvas width instead of a media query on the window,
  so the Tablet and Mobile previews work without resizing the browser.
- **Theme styles** load from the same `/theme.css` the page uses, scoped to the
  canvas, in the light or dark scheme picked in the toolbar.

`apps/server/admin-ui/tests/components/builder/preview-parity.test.tsx` renders
every core block with both renderers and compares the elements and classes.
It also compares style declarations, preset classes and breakpoint rules, and
checks that plugin markup keeps its structure. A change to one renderer that
the other does not follow fails this test.

Rendering every core block on the canvas with the server renderer, so there is
only one, is tracked in [#311](https://github.com/JustFlows/justflows-ce/issues/311).

## Where the canvas deliberately differs

| What | On the canvas | Why |
| --- | --- | --- |
| Links and buttons | Shown, but not followed | Clicking in the builder selects; use Preview to follow links. |
| Forms inside blocks | Not submitted | Same reason. |
| Empty blocks | A short hint in place of the missing text, image or media | So an empty block can still be found and selected. |
| Site logo, title, tagline, navigation, breadcrumbs | A labelled stand-in | They show site data that the page fills in when it is served. |
| Content query, table of contents | A labelled stand-in | They list content or headings found when the page is served. |
| Search, account, login and register forms, login links, language switcher, colour scheme | A labelled stand-in or neutral state | They depend on the visitor. |
| Embeds | A labelled stand-in | Third-party content is not run in the builder. |
| Grid | The page's grid element, with the grid editor's own tracks and placement handles inside it | So items can be placed and resized. |
| Linked reusable blocks, header, template and footer | Shown read-only with a label | They are edited in their own editor (see [Themes](THEMES.md)). |

A labelled stand-in shows a "Preview" tag on hover or when selected. Its
tooltip says why the block looks different. The list lives in
`apps/server/admin-ui/src/components/builder/preview-substitutions.ts`, and the
parity test fails if a block on it is not labelled.

## Blocks the builder cannot show or edit

A stored block is never changed unless the author changes it. That holds for
each case below, for saves while the block cannot be shown, and for the
public page.

| Situation | Canvas | Block settings | Public page |
| --- | --- | --- | --- |
| Its plugin or theme is switched off | "Unavailable block" with its type | Type, provider, version, id, number of settings and nested blocks; Try again, Copy data, Download data, Manage extensions, Replace with…, Remove block | Left out, with an HTML comment naming the type |
| Deprecated | Its normal preview, with a note naming the replacement | A notice with Replace with… (the replacement is preselected), above its usual settings | Unchanged |
| Its stored version could not be upgraded | Its preview from the stored settings, with a note | Usual settings | Rendered from the stored settings |
| Drawing it on the canvas throws | "could not be shown in the builder", with Try again | Usual settings | Unchanged; a block whose `render` throws is left out on its own |
| Its preview fails, is empty or takes over 8 seconds | Failure, empty or timeout notice, with Try again | Usual settings | Unchanged |

- **Saving keeps everything.** A block whose extension is off keeps its type,
  id, version, settings and nested blocks through every save, and shows again
  unchanged once the extension is active.
- **Try again** loads the list of blocks again, so a block comes back without
  reloading the builder after its extension is switched on.
- **Replace with…** keeps the block's id and editor label, carries over every
  setting the new block also declares, and keeps nested blocks when the new
  block accepts them. It always asks first, and says how many settings and
  nested blocks would be lost.
- **Remove block** always asks first, and says how many nested blocks go with
  it.
- **Copy data** and **Download data** give the stored block as JSON, for
  support or for restoring it later through the JSON panel.

## Plugin block previews

`sanitizePluginPreviewHtml` in `@justflows/blocks` prepares a plugin block's
HTML for the canvas. It keeps:

- structural and text elements, tables, `details`, and simple inline SVG icons
- `class`, `id`, ARIA, `role` and `data-*` attributes
- inline styles for colour, spacing, size, borders, typography and flex or
  grid layout

It removes scripts, frames, embeds, forms and inputs, event handlers, SVG
`use` and `foreignObject`, `javascript:` and protocol-relative links, CSS that
loads anything (`url()`, `image-set()`), and positioning. It is used only for
the builder preview, never for stored or public HTML.
