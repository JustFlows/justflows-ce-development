# Using the page builder

The page builder edits pages and posts, and the parts every page shares: the
header, the footer and templates. This guide explains what changes where,
how drafts and publishing work, and how to get work back.

## The screen

- **Top bar:** title, save state, Preview, Revisions, Save and Publish, and
  Back.
- **Toolbar:** undo and redo, Desktop, Tablet and Mobile widths (or any width
  from 320 to 1920 pixels), zoom, light or dark preview, Shortcuts, and
  buttons that hide the left or right column.
- **Left column:** Blocks (the library and patterns), Layers (the page as a
  tree), Site (the header, template and footer around this page), Styles
  (global styles and style presets) and Checks (accessibility).
- **Canvas:** the page as visitors will see it, with the header, template and
  footer shown around it.
- **Settings:** the selected block's settings, in the tabs Content, Style,
  Layout, Responsive, Interactions and Advanced.

Press `?` for every keyboard shortcut. Everything you can do with a mouse or
touch can be done with the keyboard (see [Builder accessibility](BUILDER-ACCESSIBILITY.md)).

## This page or every page?

| You change | It reaches | Where |
| --- | --- | --- |
| Blocks on the page | This page only | The canvas, Layers, Settings |
| A block's own style | That block only | Settings → Style |
| A style preset | Every block that uses it, on every page | Styles; Settings → Style chooses one, or moves a block's values into it |
| Global styles (colours, type, spacing) | The whole site | Styles |
| A linked reusable block | Every page that links it | "Edit the source" on the block |
| The header, footer or a template | Every page that uses it | Site, or click it on the canvas |

Parts that reach more than this page carry a "site-wide" label and say how
many places a change reaches before you publish it. Clicking the header,
template or footer on the canvas never changes it; it tells you where it
comes from and opens it in its own editor. Back returns you to the page with
the same block selected.

A **copy** of a pattern or reusable block belongs to this page. A **linked**
reusable block stays one block in one place: editing its source changes it
everywhere. "Detach" turns a linked block into a copy.

## Layout

Sections, containers, groups and columns can be laid out as Stack, Row,
Column or Grid in Settings → Layout, with alignment, gaps and columns. A
block inside a row can take a share of it. Drag the handles on the selected
block to change its top and bottom padding and minimum height. Blocks keep
their order for screen readers; when a grid shows them in another order, the
builder says so and can reorder them to match.

## Tablet and mobile

Every block starts with its desktop settings. In Settings → Responsive you
can set a different value for tablet (1024 pixels and narrower) or mobile
(600 pixels and narrower):

- Mobile inherits from tablet, and tablet from desktop, until you change a
  value.
- Each value shows where it comes from, and "Reset" removes only that
  override.
- Switch the toolbar to Tablet or Mobile to see the result; previewing never
  changes the page.

Existing pages keep their current behaviour until you set an override.

## Styles and where values come from

A block's style can come from several places. Settings → Style names the
source of each value, and Reset clears only that layer:

1. Set for tablet or mobile on this block
2. Set on this block
3. The template's starting style for this kind of block
4. The block's style preset
5. The theme

Global style and preset changes are a draft until you publish them from
Styles, together.

## Saving, drafts and publishing

- **Autosave** saves a draft a few seconds after you stop typing. It never
  publishes.
- **Publish** makes the draft live. Until then, visitors see the last
  published version.
- Edits to a published page stay in its draft until you publish again.
- Every edit is also kept in your browser until it reaches the server, so a
  closed tab, a crash or an expired session does not lose it: the builder
  offers to restore it.
- Undo and redo cover every change in this session; typing in one block is
  one step.

## When someone else is editing

If someone saves the same page, header, footer or template after you opened
it, the builder stops saving and says who did, where it knows. Your edits
stay on screen. Choose to load their version (your edits are kept as a copy
you can restore) or to save yours over it, after a confirmation.

## Revisions

Revisions in the top bar lists earlier versions with their date and author,
and shows what restoring one would add, remove, change or move. Restoring a
page version makes it the draft; the live page only changes when you publish.
The header, footer, widget areas and templates keep their last 30 versions.

## When a block cannot be shown

- **"Unavailable block":** its plugin or theme is switched off. The block and
  everything in it stay saved exactly as they were, and come back when the
  extension is switched on again. Its settings show what is stored and offer
  Try again, Copy data, Download data, Replace with… and Remove.
- **Deprecated:** the block still works, but is no longer offered for new
  content; its settings offer the replacement.
- **"Could not be shown in the builder":** drawing this one block failed.
  The rest of the builder keeps working; Try again draws it again.
- **"Preview" tag on hover:** the block shows something only the served page
  knows (menus, the site logo, content lists, search, sign-in). The published
  page shows the real thing.

Replace and Remove always ask first and say what would be lost.

## Accessibility checks

The Checks tab lists common problems in what you set: links or buttons
without text, empty or skipped headings, images without alt text, text with
too little contrast, content hidden on phones, and reading-order changes.
Selecting a problem takes you to the field that fixes it. The checks help,
but they cannot see everything a theme or plugin changes, so they do not
prove a page is accessible.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Not saved: newer version exists" | Someone else saved first. Load their version or save yours over it (see above). |
| A block shows "Unavailable block" | Switch its plugin or theme back on, then Try again in its settings. |
| A preview says it took too long | Try again. If it keeps happening, the block's plugin is slow; its content is safe. |
| The tablet or mobile view looks wrong | Check Settings → Responsive: an override for that width may be set. |
| A change shows on other pages too | It was made to a preset, global style, linked reusable block, header, footer or template. |
| "This change moves, removes, or edits a locked block" | Ask someone who can manage locks to unlock the block. |
