# Builder security

How the page builder's documents are protected: who may read and change
what, how input is cleaned, what previews may do, which limits apply, and
which changes are recorded. See [Access control](ACCESS-CONTROL.md) and
[Threat model](THREAT-MODEL.md) for the platform as a whole.

## Who may do what

Pages, posts and their revisions use capabilities (`content:update`,
`content:publish`, `content:revisions:restore`, `content:locks:manage` and
others), scoped by site, content type, locale and owner. Site-wide design
documents use roles:

| Document | Read | Change, publish, delete |
| --- | --- | --- |
| Templates, template parts (footer), header library | Administrator, editor, author, contributor | Administrator, editor |
| Widget areas and layout | Administrator, editor, author, contributor | Administrator, editor |
| Menus | Administrator, editor, author, contributor | Administrator, editor |
| Patterns | Administrator, editor, author, contributor | Administrator, editor (export too) |
| Reusable blocks | Administrator, editor, author, contributor | Administrator, editor |
| Style presets and global styles | Administrator, editor, author, contributor | Administrator, editor |
| Version history of design documents | Administrator, editor | — |
| Block catalog and block previews | Administrator, editor, author, contributor | — |

Authors and contributors can read design documents, including unpublished
drafts of the header, footer and templates, because the builder shows a page
inside them. Subscribers and custom roles cannot use these routes; there is
no capability for site design yet.

`apps/server/tests/integration/security/builder-authorization.test.ts` calls
every design write route, and the history reads, as each role, and checks
that refused requests never reach storage.

Every route checks that the session belongs to the site the request is for,
and every query is limited to that site. Revisions are looked up by revision,
content and site together. Shared caches name the site in every key, and
draft previews never use them (see [Builder performance](BUILDER-PERFORMANCE.md#caches-and-privacy)).

## Requests

- **CSRF:** every core `/api` write needs the `x-csrf-token` header derived
  from the session, including `/api/blocks/preview/batch`. Bearer-token
  requests to the management API carry no cookie and are exempt.
- **Size:** JSON bodies are limited to 2 MB. A block document may be at most
  64 levels deep and hold 20,000 blocks. Writes over that get
  `413 document_too_large` before any route stores them, on every document
  route, the management API and the assistant's tools.
- **Rate limits:** block previews (240 requests a minute, up to 50 previews
  per batch request), pattern imports and saves, document history, and the
  management API have their own limits.
- **Errors:** validation problems are named; unexpected failures are logged
  and answered with a generic message, so database or stack details do not
  reach the browser.

## Content

- Stored documents pass through `sanitizeBlockDocument`, which keeps only the
  contract keys, cleans every core block's props, URLs, styles, presets and
  breakpoints, and cuts off anything past the depth and size limits instead
  of failing. The renderers stop at the same depth.
- Rich text, Custom HTML, links, media addresses and custom CSS are cleaned
  with the shared sanitizers in `@justflows/blocks`, the same on the canvas
  and the public page.
- Pasted blocks are parsed and cleaned the same way, get new ids, and lose
  their locks. Imported patterns are validated against the pattern schema.
- A block type that no active block handles is never written into the page
  as text; only a well-formed type is named in an HTML comment.

## Previews

- **The canvas never runs stored scripts.** Core blocks are drawn from
  cleaned props; plugin and theme blocks are shown through a builder-only
  sanitizer that removes scripts, frames, forms, event handlers, unsafe
  links, CSS that loads anything and positioning. Links and forms on the
  canvas are inert.
- **Preview** opens the public page in a new tab with the visitor's view of
  the draft. Scripts the theme and plugins load run there as on the page.
- Plugin admin screens run in same-origin frames and talk to the admin only
  through `postMessage`, checked by origin, frame and message source.

## Audit log

Site-wide design changes are recorded under Security → Audit log with the
person, the site and the part changed. The entries never contain the content.

| Action | When |
| --- | --- |
| `design.part_published`, `design.part_reset` | Header, footer or a template is published or reset |
| `design.presets_published` | Style presets are published |
| `design.styles_published` | Global styles are published or saved live |
| `design.widgets_published` | A widget area or the widget layout is published |
| `design.menu_saved` | A menu is created or published |
| `design.patterns_changed` | A pattern is saved, imported or deleted |
| `design.reusable_published`, `design.reusable_deleted` | A reusable block is published or deleted |
| `content.published`, `content.revision_restored`, … | Pages and posts, as before |

`apps/server/tests/integration/security/builder-hardening.test.ts` checks
the new entries, the size limits, CSRF and error handling, and `pnpm
test:security` runs both files.

## Known limits

- **Custom roles and design.** There is no capability for site design, so
  custom roles cannot change templates, menus, widgets, patterns, reusable
  blocks or styles.
- **Plugin code is trusted.** A plugin block's `render`, migrations and hooks
  run with the server's rights. Previews are limited in number and rate, but
  a slow `render` is not interrupted.
- **Error messages for editors.** Some design routes show the message of a
  failed save to administrators and editors; it may include a database
  driver's wording.
