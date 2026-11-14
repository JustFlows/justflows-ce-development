# Block editor contract

A plugin block tells the page builder how to insert, find, preview, edit,
upgrade and lay it out. It does this through optional fields on
`PluginBlockDefinition` in `@justflows/sdk`. A block that uses none of them
works exactly as before. This page lists the fields, what the host does with
each one, and the rules for changing a block over time.

The contract is version 1 (`BLOCK_API_VERSION` in `@justflows/sdk` and
`@justflows/blocks`).

## A complete example

```ts
import { BLOCK_API_VERSION, escapeHtml, type PluginBlockDefinition } from "@justflows/sdk";

/** Version 2 renamed `heading` to `title`. */
export const pricing: PluginBlockDefinition = {
  apiVersion: BLOCK_API_VERSION,
  type: "acme.pricing",
  version: 2,
  title: "Pricing card",
  description: "A plan with a price",
  icon: "€",
  category: "content",
  keywords: ["plan", "price", "subscription"],
  parents: ["$root", "core.section", "acme.grid"],
  schema: {
    title: { type: "text", default: "Plan" },
    price: { type: "text" },
    featured: { type: "boolean" },
  },
  defaults: { title: "Starter", price: "€9" },
  inline: { title: { mode: "plain", maxLength: 80 } },
  actions: [{ id: "feature", label: "Mark as featured", props: { featured: true }, toolbar: true }],
  preview: { sampleProps: { title: "Sample plan", price: "€0" }, minHeight: 120 },
  migrations: [{ from: 1, to: 2, migrate: (props) => ({ title: props.heading, price: props.price }) }],
  validateProps(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      title: typeof r.title === "string" ? r.title.slice(0, 80) : "Plan",
      price: typeof r.price === "string" ? r.price.slice(0, 20) : "",
      featured: r.featured === true,
    };
  },
  render: (props) =>
    `<article class="acme-pricing${props.featured ? " acme-pricing--featured" : ""}">` +
    `<h3 data-jf-inline="title">${escapeHtml(String(props.title))}</h3>` +
    `<p>${escapeHtml(String(props.price))}</p></article>`,
};

/** A container whose children the author can lay out as a row, column or grid. */
export const grid: PluginBlockDefinition = {
  type: "acme.grid",
  version: 1,
  title: "Acme grid",
  schema: {},
  supportsChildren: true,
  supports: { containerLayout: { target: "acme-grid__items" } },
  validateProps: () => ({}),
  render: (_props, children = "") => `<div class="acme-grid"><div class="acme-grid__items">${children}</div></div>`,
};
```

Register them in `activate` with `ctx.blocks.register(pricing)`. A block type
must start with the plugin's id, as before.

## Fields

| Field | What the host does |
| --- | --- |
| `apiVersion` | The contract version the block was written for. Omitted means 1. A host that does not support it refuses the block when the plugin activates, with a message naming both versions. |
| `keywords` | Extra words the block library search matches, besides the title, type and description. Lower-cased, at most 12 of up to 40 characters each. |
| `parents` | Block types this block may be placed in. `"$root"` means the top level of a page, header, footer or template. Omitted or empty means anywhere its parent accepts it. Drag-and-drop, the Layers panel and paste all use this rule. |
| `defaults` | Props a newly inserted block starts with, on top of the schema defaults. They are passed through `validateProps` before the builder sees them, so a default the block would reject never reaches a page. |
| `deprecated` | `true` or `{ since, replacedBy?, message? }`. The block is no longer offered in the library. Blocks already on pages keep rendering and can still be edited. |
| `actions` | Up to 8 one-click changes, each `{ id, label, props, toolbar? }`. Running one merges `props` into the selected block's props as one undo step. Actions with `toolbar: true` also get a button on the block's canvas toolbar (at most three are shown). The ids are lower-case letters, digits and dashes. |
| `preview.mode` | `"server"` (default) shows the block's own `render` output on the canvas. `"placeholder"` shows the title, icon and description instead and never calls `render` in the builder; use it for blocks that need the visitor's request or live data. |
| `preview.sampleProps` | Props used in the builder preview where the block's own are unset or empty, so a fresh block looks real. They are never saved. |
| `preview.minHeight` | Space in pixels the canvas reserves for the preview while it loads (at most 2000). |
| `supports.containerLayout` | For a block with `supportsChildren`, lets the author make it a row, column or grid in the Layout tab. `true` applies the layout to the block's root element. `{ target: "class-name" }` applies it to the first element with that class, which should be the one holding `children`. An invalid class name falls back to the root. |
| `migrations` | Steps that upgrade stored props from an older `version`. See below. |

Each value is limited in size, and anything malformed is dropped when the block
registers. Only a wrong `apiVersion` or a broken migration chain makes
registration fail, because both would leave the block unusable.

## What stays with the host

None of these fields changes how the host stores, sanitizes or authorizes a
document.

- Every prop change, whether from an action, `defaults`, inline editing or the
  settings panel, is checked by the block's own `validateProps` when the page is
  saved and when it renders.
- `render` must keep escaping every prop. A value from an action or from
  `defaults` is author input like any other.
- The builder sanitizes preview HTML before showing it. Scripts and event
  handlers in it never run.
- Locked blocks refuse actions the same way they refuse other edits.
- Plugin inline fields are plain text, whatever mode is declared.

## Previews in the builder

The canvas asks `POST /api/blocks/preview` for the block's HTML with its props
and stored `version`. The preview is shown in its own box, and every outcome is
visible: a loading box at `minHeight`, the rendered block, "shows nothing with
its current settings" for empty output, a failure or timeout (after 8 seconds)
with a Try again button, and "Unavailable block" when the plugin is switched off.
In that last case the block's content is kept and shows again once the plugin
is back. A `render` that throws only breaks its own preview.

## Changing a block over time

`version` is the version of the block's props, not of the plugin. Raise it only
when stored props need to change shape.

1. Raise `version` by one.
2. Add a migration from the previous version. Keep every earlier migration, so
   the steps cover every version from 1 to the current one (`1→2`, `2→3`, …).
   Registration fails when a step is missing or a step does not go from N to
   N + 1.
3. Keep `migrate` pure: return new props and never change the input. If a step
   throws, the block renders with its stored props as before.

Stored documents are not rewritten in bulk. Old blocks are upgraded each time
they render on the site or preview in the builder, before `validateProps` runs.
When the builder opens a page, header, footer, template, widget area, menu,
reusable block or revision, its old blocks arrive already upgraded, so the
author edits the current props and the next save stores them at the current
version. Opening a document does not mark it as changed. New blocks are
inserted at the current version.

To retire a block, mark it `deprecated` with `replacedBy` and keep registering
it, so existing pages keep working. Unregistering a type turns its blocks into
"Unavailable block" placeholders in the builder.

## Contract stability

`scripts/check-sdk-api.mjs` records the members of `PluginBlockDefinition`,
`PluginBlockField` and `BlockPattern` in `packages/sdk/api-contracts.json`. CI
fails when a member is removed or an optional member becomes required, so these
fields only change in a major release (see
[SDK compatibility](SDK-COMPATIBILITY.md)). A new contract version will raise
`BLOCK_API_VERSION`; hosts list the versions they accept in
`SUPPORTED_BLOCK_API_VERSIONS` from `@justflows/blocks`.
