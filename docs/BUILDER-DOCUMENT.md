# Builder document architecture

Status: accepted. Applies to Visual Site Builder 2.0
([#292](https://github.com/JustFlows/justflows-ce/issues/292)); defined in
[#293](https://github.com/JustFlows/justflows-ce/issues/293).

Every Builder 2.0 change that persists data follows this document. It fixes one
canonical block document for every builder surface, says where new values live,
separates stored data from editor state, and defines how documents migrate and
recover. The code is in `packages/blocks`:

| Module | Contents |
| --- | --- |
| `document-contract.ts` | Node shape, id rules, editor metadata, nesting rules, validation |
| `builder-values.ts` | Container layout, style references, breakpoint overrides, value sources |
| `block-migrations.ts` | `BlockMigrator`: versioned, non-destructive block migrations |
| `sanitize-document.ts` | `sanitizeBlockDocument`: the storage boundary every surface calls |

## Decision

1. There is one document format: `{ version: 1, blocks: BlockNode[] }`. No
   surface gets an editor-only or parallel format.
2. New persisted values are additive, optional, namespaced, and allowlisted. A
   document without them renders exactly as before.
3. Only contract keys are stored. Transient editor state is dropped at the
   storage boundary.
4. Schema changes ship as explicit migrations that never mutate their input.
   Failure keeps the original data.
5. Sanitation happens when a document is stored and again when it is rendered.
   The editor is never trusted.

## Inventory

Every surface stores the same block list and passes it through
`sanitizeBlockDocument` on write and on read.

| Surface | Stored in | Shape around the blocks |
| --- | --- | --- |
| Pages, posts, custom types | `content.blocks` | The document itself |
| Revisions and scheduled changes | `revisions.blocks`, scheduling snapshots | The document itself |
| Header library | `template_parts` part `header` (`doc`, `draft_doc`) | Named `PageHeaderConfig` entries, each with `blocks` (max 40) |
| Per-page header chrome (legacy) | `content.fields` header field | `PageHeaderConfig.blocks` |
| Footer | `template_parts` part `footer` (`doc`, `draft_doc`) | `{ version: 1, blocks }` |
| Theme templates | Theme `templates/*.json`; site overrides in `theme_templates` | `{ version: 1, blocks }` |
| Reusable blocks | `reusable_blocks` site setting | `{ id, name, blocks, updatedAt }` |
| Patterns | `block_patterns` site setting; theme/plugin pattern files | `BlockPatternSchema` (SDK), `blocks` per pattern and locale |
| Widget areas | `template_parts` parts `widgets:<area>` | Block list per area |
| Mega-menu regions | Menu items | Region `blocks`, filtered to the mega-menu safe set |

Values that already live in a node's `props` on every block type:

| Prop | Meaning | Module |
| --- | --- | --- |
| `style` (object) | Spacing, size, alignment, colours, theme variable overrides | `block-style.ts` |
| `gridPlacement` | Column, span, row, row span inside `core.grid` (legacy key `layout`, migrated on sanitize) | `layout.ts` |
| `animation` | Entrance, hover, tap effects | `animation.ts` |
| `devices` | Show on desktop/tablet/mobile | `visibility.ts` |
| `className`, `css` | Scoped custom classes and CSS | `safe-css.ts` |
| `responsive` | Server-injected image derivatives (images and plugin media fields) | `core/index.ts` |

A block schema may own a prop with one of these names when the value has a
different shape. For example, `style` can be a select value on some blocks. Shared
values are recognised by shape, and that is why every new key below is namespaced.

## The node contract

```ts
interface CanonicalBlockNode {
  id: string;            // 1–128 chars, no whitespace or markup characters
  type: string;          // namespaced: core.*, or a plugin's own prefix
  version: number;       // the block type's props version
  props: Record<string, unknown>;
  children?: CanonicalBlockNode[];
  editor?: { label?: string; lock?: { move?: true; remove?: true; edit?: true } };
}
```

- `BLOCK_NODE_KEYS` lists the only keys stored. `sanitizeBlockDocument` drops
  anything else on a node: selection, hover, drag, collapsed state, or
  injected markup.
- `editor` holds persisted editor-only metadata. It sits beside `props`, never
  inside them, so a block's `render` and `validateProps` never see it and it
  cannot reach public HTML. The label is plain text, capped at 80 characters. Lock
  flags are stored only when `true`. Locks are enforced on save; see
  [Locks](#locks).
- Per-user editor preferences (panel layout, zoom, preview scheme, recent
  blocks) belong in per-user storage. They never go in a document.

### Ids

- An existing id is never regenerated. Saving, moving, reparenting, and
  migrating keep every id. Scoped CSS (`blockScopeClass`) and references
  depend on ids.
- Copy, duplicate, paste, and pattern insertion give every node in the copied
  subtree a new id (`reassignBlockIds`).
- Data imported from outside the editor can have missing, invalid, or duplicate
  ids. `repairBlockIds` fills or replaces only those ids. The first valid
  occurrence keeps its id.

### Locks

`editor.lock` flags limit what an author may do to a block. The editor
disables locked actions and says why. The server checks the same rules on every
content write (`PATCH /api/content/:id`, the management API that MCP uses, and
revision restore). It compares the incoming blocks with the last saved
draft using `blockLockViolations` from `@justflows/blocks`. A write that breaks
a lock is refused with 403 and `code: "block_locked"`, listing each `id` and
`rule`.

| Flag | The server refuses |
| --- | --- |
| `move` | A new parent, or a new order among the move-locked siblings. Unlocked neighbours may still be added, removed or reordered. A diff can't tell that apart from moving the locked block, so the editor also refuses dragging or moving it directly. |
| `remove` | Removing it, including by removing a block that contains it. |
| `edit` | Any change to its `type` or `props`. Its children are separate blocks with their own locks. |
| (any) | Adding, changing or removing the flags of a block that already exists (`rule: "lock"`). New blocks may arrive with locks, for example from a pattern. |

People with the `content:locks:manage` capability can lock and unlock blocks,
and their writes skip the check. Administrators and editors have it by
default. Copies made by duplicate, copy and paste never keep the original's
locks.

### Clipboard

Copied blocks are JSON tagged `"format": "justflows/blocks"` (MIME type
`application/x-justflows-blocks`, with the same text as `text/plain`).
`parseBlockClipboard` treats clipboard text as untrusted:

- It runs `sanitizeBlockDocument` on the blocks.
- It caps the size at 1,000,000 characters and 1,000 blocks, and the depth at
  `BLOCK_MAX_DEPTH`.
- It gives every pasted block a new id and drops its lock flags.
- It keeps references to shared items, such as a `core.reusable` `ref`.

Text that isn't builder data is pasted as paragraphs, with HTML characters
escaped (`plainTextToBlocks`).

### Nesting

`canNestBlock(parentType, childType, lookup)` is the single nesting rule.
`parentType` is `null` for a region root, such as the document body, header
slot, footer, or template:

- `core.column` sits only in `core.columns`, and `core.columns` holds only
  columns.
- A declared `allowedChildTypes` list is authoritative.
- A block without `supportsChildren`, or an unknown parent type, accepts no
  children.
- `core.columns` cannot be placed directly inside `core.column`.

The admin drag-and-drop check (`canDropBlockType`) delegates to it, so moves,
pastes, and imports apply the same rules.

### Validation and safe behaviour

`validateBlockDocument(blocks, { lookup?, rootParentType?, maxDepth? })` reports
issues in document order and never changes the input:

| Issue | What happens |
| --- | --- |
| `invalid-node` | The editor shows a recoverable placeholder; the renderer emits a missing-block comment |
| `missing-id`, `invalid-id`, `duplicate-id` | The editor or import repairs it with `repairBlockIds` before the next save |
| `unknown-type` | Data is kept as stored; the editor shows an unavailable-block placeholder; the renderer emits a comment |
| `invalid-parent` | The editor refuses the move or paste; stored data that already violates it keeps rendering |
| `cycle` | Only possible in memory; the operation that produced it is refused |
| `max-depth` (32) | The operation is refused; deeper stored data is kept |

## Additive Builder 2.0 values

These keys live in `props` and are sanitized on every block type. An invalid
value is dropped rather than stored. `containerLayout` is rendered and
editable. The renderer and editor controls for the others arrive with the
tickets named below.

### `containerLayout` (#299)

`{ display?: "flex" | "grid", direction?: "row" | "column", wrap?, justify?, align?, gap?: SpaceStep, columns?: 1–12, element?, stack?: "mobile" | "never" }`

Every field is an allowlisted keyword, a spacing scale step, or a bounded
integer. Arbitrary CSS and absolute positioning are not representable.

- **Containers.** Sections, containers, groups and columns accept a layout
  (`CONTAINER_LAYOUT_TARGETS`). A section lays out its `jf-section__inner`
  wrapper; the others use their root element. On any other type the value is
  stored but ignored. Without `display`, a container renders exactly as before.
  No migration is needed.
- **Rendering.** `withBlockChrome` calls `applyContainerLayout` on every render
  path. It adds `jf-cl` classes and a few declarations: gap, justify, align and
  wrap, plus `--jf-cl-cols` and `--jf-cl-gap`. `CONTAINER_LAYOUT_CSS` is part of
  `/theme.css`, so it works on every theme and in the builder's scoped preview.
  The canvas calls the same `containerLayoutAttrs`.
- **Phones.** Rows and grids stack into one column at or below 600px unless
  `stack` is `"never"`. Stacking keeps source order.
- **Reading order.** There is no reverse direction and no `order`, so visual
  order is source order. Explicit placement in `core.grid` can still differ;
  the builder then says so and offers to reorder the blocks to match.
- **Elements.** `element` swaps the root `div` of a group or container for
  `section`, `article`, `aside`, `header`, `footer` or `nav`. `main` is not
  offered. The editor refuses a `header` or `footer` inside another one
  (`containerElementAllowed`).

A block inside a row uses three `style` fields:

- `grow` (`"1"` fills the free space).
- `basis` (`25`, `33`, `50`, `66`, `75` or `100` percent of the row, minus its
  share of the gaps, so equal shares fill one line).
- `overflow` (`hidden` or `auto`).

`grow` and `basis` are written as `--jf-grow` and `--jf-basis`, which only a
row reads, and a stacked row drops the basis on phones. `overflow` is written
directly as `overflow` and applies to any block.

### `styleRef` (#301)

The id of a named style preset (`^[a-z][a-z0-9-]{0,63}$`). A preset is a site- or
theme-level set of token values. The block stores only the reference, never a
copy of the values.

### `breakpoints` (#300)

```ts
{
  tablet?: { style?, containerLayout?, gridPlacement?, order? },
  mobile?: { style?, containerLayout?, gridPlacement?, order? },
}
```

- Desktop is the base: the block's ordinary props. Tablet inherits from
  desktop and mobile inherits from tablet. A missing field means "inherit".
  There is no stored "unset", so removing the field is the reset.
- Breakpoints match `DEVICE_BUCKETS` and the fixed widths in `visibility.ts`
  (mobile ≤ 600px, tablet ≤ 1024px). Themes cannot add breakpoints or media
  queries.
- Overridable fields are allowlisted: `BREAKPOINT_STYLE_FIELDS` (spacing,
  width, max width, min height, alignment, text alignment, text size),
  `BREAKPOINT_LAYOUT_FIELDS`, grid placement, and a bounded `order` (−20 to
  20). Colours and effects are not responsive.
- Hiding per breakpoint keeps using `devices`.
- **Rendering.** `withBlockChrome` calls `breakpointCss` and writes the result
  in the block's `<style>` under its scope class (`.jf-b-<id>`), next to its
  custom CSS. Output is deterministic: tablet then mobile, fields in a fixed
  order. Rules use `!important` because the base values are inline styles.
  Layout overrides act only on a block that already has a `containerLayout`,
  and target its children wrapper; `alignSelf`, grid placement and `order`
  target the element that is the item in its parent's layout.
- **Builder canvas.** The canvas emits the same rules through the same
  function, as `@container jf-canvas` queries on the preview elements, and
  `/theme.css?scope=…&widths=canvas` rewrites the theme's width-only media
  queries to the same container (`widthMediaToContainer`). So the Tablet and
  Mobile previews and a custom width show the theme's real responsive rules
  without resizing the admin window. Media queries that test anything other
  than width (print, colour scheme, hover) stay media queries.
- **Editing.** Previewing at a width and writing an override are separate: the
  toolbar only changes the canvas; the Responsive tab writes `breakpoints`.
  `resolveResponsiveValue` gives the value in effect at a breakpoint and the
  breakpoint that set it; `setBreakpointValue` sets or clears one field and
  prunes empty objects, so a reset removes only that override.
- `BREAKPOINTS_SCHEMA_VERSION` is 1. A change to this shape ships a migration.
- A document without `breakpoints` keeps today's behaviour. That includes the
  automatic tablet widening of narrow grid items (`placementStyleVars`) and
  full-width grid items on phones. An explicit override replaces that automatic
  behaviour only for the field and breakpoint it sets.
- The key is `breakpoints`, not `responsive`, because `responsive` already
  carries image derivatives.

### Value cascade

`VALUE_SOURCES` orders where a computed value comes from, widest first:

1. `theme-default` — the active theme's stylesheet and token defaults.
2. `global-token` — site-wide design token overrides (customizer).
3. `style-preset` — the named preset in `styleRef`.
4. `template-default` — a value a template sets on its own block.
5. `local` — the block's own props (`style`, `containerLayout`, `gridPlacement`).
6. `breakpoint-override` — the block's `breakpoints` entry for the active width.

A later layer wins. Resetting a layer removes only that layer's value and
reveals the one beneath it. The inspector shows which layer supplied each
value.

## Migrations and deprecation

A block type's `version` describes its props. When props change in a way old
data cannot satisfy, the block ships a migration step instead of guessing at
render time:

```ts
migrator.register({ type: "acme.slider", from: 1, to: 2, migrate: (props) => ({ ...newProps }) });
const { document, changed, failures } = migrator.migrateDocument(stored);
```

- Each step goes from N to N+1 and must be pure. Registration rejects
  duplicates and gaps when the extension loads.
- The input is never mutated. The pre-migration document is the rollback copy:
  callers write a revision of it before saving the migrated result.
- Failures are lossless. If a step throws or returns a non-object, or the chain
  has a gap, the node keeps its stored props and version and the failure is
  reported (`BlockMigrationFailure`). A node newer than any known step, for
  example after a plugin downgrade, is left alone. Unknown types are untouched.
- Document `version` is `1`. A future document version ships with its own
  document-level migration. Today the migrator reports any other version as
  `unsupported-document-version` and returns the document unchanged.
- A deprecated block type stays registered so stored content keeps rendering.
  It is hidden from the library and can migrate to its replacement.

Exposing migrations and deprecation to plugins through `@justflows/sdk` is part
of the extension contract work (#305). Wiring migration into the read path ships
with the first block that needs a migration. Until then no migration runs and
no stored document changes.

## Boundaries

| Boundary | Responsibility |
| --- | --- |
| Editor | Builds documents and validates operations for feedback. Not trusted. |
| Storage (`sanitizeBlockDocument`) | Keeps contract keys only, sanitizes rich text, HTML, URLs, CSS, classes, style, placement, animation, devices, Builder 2.0 values, and editor metadata. Runs on every write path and on read. |
| Render (`BlockRegistry.renderNode`) | Re-validates props per block (`validateProps`), re-checks CSS and URLs, and renders unknown types as a comment so data is never lost. |
| Preview | Uses the same renderer and sanitizer as the public page; draft content and request data stay scoped to the authorized site, locale, and user. |

Serialization is plain JSON. Key order is not significant. The sanitizer is
idempotent: sanitizing a stored document again returns an equal document with
the same ids. The tests in `packages/blocks/tests/unit/document-contract.test.ts`
cover this for pages, headers, footers, templates, reusable blocks, patterns,
plugin blocks, and every shipped default-theme template.
