# Builder performance

The page builder stays responsive on long pages and when previews, plugins or
the network are slow. This page lists the budgets, how they are kept, and
what is measured where.

## Representative documents

| Size | Blocks | Shape |
| --- | --- | --- |
| Small | 20 | 4 sections, each with a heading, two paragraphs and a button |
| Medium | 200 | 40 such sections |
| Large | 1,000 | 200 such sections |

The plugin case adds three plugin blocks to each section of the medium page,
which makes 120 plugin blocks. The reusable case adds one linked reusable
block to each of 50 sections.

## Budgets

These are counts, so they are the same on every machine.
`apps/server/admin-ui/tests/components/builder/builder-performance.test.tsx`
fails when one is exceeded.

| What | Budget, at every size |
| --- | --- |
| Previews redrawn when one block changes (typing, a setting, undo) | 2: the block and its section |
| Previews redrawn when the selection moves to another block | 4: the old and new block and their sections |
| Canvas rows redrawn while the drop target moves during a drag | 0 |
| Preview requests for 120 plugin blocks | 3, at most 50 previews each |
| Preview requests after one plugin block changes | 1, for that block only |
| Requests for the reusable block library, however many references | 1 |

The same test checks loosely that one edit on the large page takes less than
250 ms in the test environment, to catch large regressions.

### Measured in the test environment (jsdom)

| Large page (1,000 blocks) | Before | After |
| --- | --- | --- |
| Previews redrawn for one edit | 1,000 | 2 |
| Time for one edit | 121 ms | 10 ms |
| Previews redrawn for a selection change | 1,000 | 2–4 |
| Time for a selection change | 119 ms | 13 ms |

The test environment has no layout or painting, so a real browser takes
longer for both. The ratio is what carries over.

## How

- **Edits redraw only what changed.** Canvas rows edit the document through
  a stable handle, and a row redraws only when its block, its position, or the
  selection inside it changes. Edits keep every untouched block as the same
  object, so whole branches are skipped.
- **Selection and drag state are split.** Rows and previews read the
  selection actions and the drag payload from contexts that change only when
  a selection or a drag starts or ends, not while the pointer moves.
- **Long canvases skip off-screen work.** Top-level sections use
  `content-visibility: auto`, so the browser does not lay out or paint
  sections far outside the view. They stay in the page, so find in page,
  selection, focus and drop targets keep working. The selected section, a
  section with focus inside, and one with an open menu or picker are always
  drawn.
- **The Layers panel only draws the rows in view** on long pages.
- **Plugin previews are batched and cached.** Previews needed at the same
  moment go to `POST /api/blocks/preview/batch` together (up to 50 per
  request), identical ones share one answer, and successful answers are kept
  until the block catalog reloads. Each preview still times out after 8
  seconds on its own, and a failed or cancelled one never blocks the others.
- **Heavy parts load when used.** The animation library loads only when a
  block on the canvas has an active animation and reduced motion is off. The
  keyboard shortcuts and "Save as" dialogs load when first opened.
- **A block that fails to draw only breaks itself** (see
  [Builder preview and recovery](BUILDER-PREVIEW.md)).

## Caches and privacy

- Builder preview answers are cached in the browser tab only, per block type,
  version and props, and dropped when the block catalog reloads. They contain
  only the block's own render of the props that were sent.
- The shared public cache never holds drafts: a preview render skips it, and
  every key names the site, so one site's data cannot reach another.
- The batched preview endpoint renders from the request alone and reads
  nothing from the database, so its cost does not grow with what the page
  links to.

## Diagnostics

Each preview batch is recorded with `performance.measure` as
`jf-builder:preview <block types> (<count>)`, so slow plugin previews show up
by name in the browser's Performance panel.

## Not automated

These need a real browser and are part of the release checklist in
[Builder accessibility](BUILDER-ACCESSIBILITY.md#testing):

- Time to open the large page, and to scroll it, in Chrome, Firefox and Safari.
- Typing in a paragraph on the large page stays without visible lag.
- Dragging a section on the large page follows the pointer smoothly.
