# Builder accessibility

The page builder can be used with a keyboard, a screen reader, touch, browser
zoom and high-contrast modes. It also checks pages for common accessibility
problems while they are edited. This page lists the keyboard paths, what the
checks do and don't do, and how the builder is tested.

## Keyboard

Everything that works with a mouse or touch also works with the keyboard.
Press `?` in the builder (or **Shortcuts** in the toolbar) for this list.
`Ctrl` is `⌘` on a Mac.

### Canvas

| Action | Keys |
| --- | --- |
| Select a block (Tab to its name) | `Tab` to the block's name, then `Enter` or `Space` |
| Open the block's actions menu | `Shift`+`F10`, or the context-menu key, or the "⋯" button |
| Duplicate | `Ctrl`+`D` |
| Group | `Ctrl`+`G` |
| Ungroup | `Ctrl`+`Shift`+`G` |
| Delete | `Delete` or `Backspace` |
| Copy, cut and paste | `Ctrl`+`C`, `Ctrl`+`X`, `Ctrl`+`V` |
| Keep only one block selected | `Escape` |

### Layers

| Action | Keys |
| --- | --- |
| Move up or down | `Alt`+`↑`, `Alt`+`↓` |
| Move into the block above, or out of its container | `Alt`+`→`, `Alt`+`←` (mirrored for right-to-left) |
| Add blocks to the selection | `Shift`+`↑`/`↓`, `Ctrl`+`Space` |
| Rename | `F2` |
| Move to another container | "Move to…" in Layers |

### Blocks, text and media

| Action | Keys |
| --- | --- |
| Add the focused block | `Enter` or `Space` on a block in the library |
| Finish or cancel editing text | `Enter` (single-line fields) finishes, `Escape` cancels |
| Replace a selected image or file | `Enter` on the selected block |

### Layout and general

| Action | Keys |
| --- | --- |
| Change spacing and height with a focused handle | Arrow keys; `Shift` for bigger steps |
| Place and size an item in a grid | Grid placement fields in the Layout tab |
| Undo and redo | `Ctrl`+`Z`, `Ctrl`+`Shift`+`Z` |
| Cancel a drag | `Escape` |
| Show this list | `?` |

**Exception: grid handles.** Dragging a grid item, or its edge handles, has no
shortcut. The Grid placement fields in the block's Layout tab (column, span,
row, row span) do the same thing with the keyboard, and give more precise
control.

The list lives in
`apps/server/admin-ui/src/components/builder/keyboard-paths.ts`. A test
checks that every entry is translated, has keys or a named control, and
appears on this page.

### Focus

- Menus and dialogs return focus to the control that opened them.
- `Escape` closes menus, dialogs, pickers and drags without changing anything.
- Dialogs keep focus inside while open.
- Tabs and the Layers tree use arrow keys, `Home` and `End`, as the WAI-ARIA
  patterns describe.
- Keyboard shortcuts are ignored while you type in a field or a text block.

## Accessibility checks

The **Checks** tab in the builder's left column lists problems in the
document being edited. A count on the tab shows how many need fixing. Each
item names the block. Selecting it selects the block, opens the settings tab
where it is fixed, and moves focus to the field to change.

| Check | Severity | Field |
| --- | --- | --- |
| Link or button without text (Button, Hero, Call to action, Link list) | Problem | Label |
| Empty heading | Problem | Text |
| Text contrast below 3:1 with colours set here | Problem | Text or background colour |
| Text contrast between 3:1 and 4.5:1 | To review | Text or background colour |
| Image without alt text (Image, Media & Text) | To review | Alt text |
| Button with text but no link | To review | Link |
| Skipped heading level, such as 2 to 4 | To review | Level |
| A Heading block at level 1 | To review | Level |
| Heading or button hidden on phones | To review | Responsive |
| Reading order differs from the order on screen (grid placement, breakpoint order) | To review | Layout or Responsive |
| Meaningful icon without a label | To review | Label |
| Table without a header row | To review | Header |
| Contrast with a colour from the theme | Not checked | — |
| Plugin and theme blocks, Custom HTML | Not checked | — |

### Limits

The checks help authors, but they never claim a page is accessible. They only
read the stored document, so they cannot see:

- colours, fonts and layout a theme applies
- what plugin and theme blocks render, or what Custom HTML contains
- what a visitor's settings change, such as zoom, contrast or text size
- the content of images and media

Where a check cannot decide, it says so ("Not checked") instead of guessing.
The checks are in `@justflows/blocks` (`checkAccessibility`), so the
management API and the assistant can use the same rules.

## Language and direction

- Public pages set `dir="rtl"` on `<html>` for languages written right to
  left (Arabic, Hebrew, Persian, Urdu and others, decided by script where the
  runtime knows it). The builder canvas uses the page's own language and
  direction, so right-to-left content reads and aligns as it will be
  published.
- The builder's interface stays in the admin language. Arrow-key shortcuts
  that move left or right follow the direction of the element they act on.
- Text fields follow the direction of what is typed. Typing with an input
  method editor (Chinese, Japanese, Korean) is not interrupted by `Enter`.
- Messages that include a number use the plural forms of each language.
  Polish, Russian and Ukrainian get their own forms for 1, 2–4 and 5 or more.
  The catalog test requires every language to have exactly the forms its
  plural rules use.

## Touch, zoom and contrast

- Canvas toolbar buttons are at least 24 by 24 pixels, and 44 by 44 on touch
  screens.
- The admin never disables browser zoom. The builder shell stacks its panels
  below 960 pixels, and the shortcuts dialog and panels reflow at 320 pixels.
- In Windows high contrast and other forced-colours modes, the selected block
  and focused controls get outlines in system colours, and panels keep their
  borders.
- Animations in the canvas preview and the builder respect "reduce motion".

## Testing

Automated tests cover the keyboard map, the checks, plural forms, text
direction, the public renderer's semantics (alt text, heading levels, real
links and buttons, named landmarks, native disclosure widgets, table headers)
and the builder flows above.

These need a person with real devices and assistive technology before a
release. Record the result and the versions used.

| Area | Check |
| --- | --- |
| Keyboard only | Build a page with a section, heading, image and button; move, nest, duplicate, delete and undo with the keyboard only; no focus is lost or trapped |
| Screen reader | NVDA with Firefox, VoiceOver with Safari: block names, selection, moves, the actions menu and the Checks tab are announced |
| Touch | Tablet and phone: select, add from the library, open the actions menu, change spacing |
| Zoom and reflow | 200% and 400% browser zoom, and a 320-pixel window: nothing is cut off or needs scrolling in two directions, except the canvas itself |
| High contrast | Windows contrast themes: selection, focus, drop zones and the Checks list stay visible |
| Reduced motion | With "reduce motion" on, the canvas does not animate |
| Right to left | A page in Arabic or Hebrew: canvas and published page read right to left; text editing and alignment behave |
| Languages | Polish, Russian and Ukrainian with 1, 2, 5 and 22 blocks selected: counts read correctly; long German and French labels do not overflow the toolbar or panels |
