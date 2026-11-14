# Builder 2.0 release

Release evidence, documentation index and rollout plan for Builder 2.0
([#292](https://github.com/JustFlows/justflows-ce/issues/292)). Each
acceptance criterion of #292 is listed with the evidence that it holds: an
automated test, a manual check still to be recorded, or an approved
limitation with its follow-up ticket.

## Documentation

| For | Read |
| --- | --- |
| Authors and editors | [Using the page builder](BUILDER-GUIDE.md) |
| Keyboard and assistive technology | [Builder accessibility](BUILDER-ACCESSIBILITY.md) |
| Document format, ids, nesting, migrations | [Builder document architecture](BUILDER-DOCUMENT.md) |
| Plugin and theme blocks | [Block editor contract](BLOCK-CONTRACT.md), [Blocks](BLOCKS.md), [Plugins](PLUGINS.md) |
| Themes, global styles, templates | [Themes](THEMES.md) |
| How the canvas matches the page, recovery | [Builder preview and recovery](BUILDER-PREVIEW.md) |
| Budgets, caching, diagnostics | [Builder performance](BUILDER-PERFORMANCE.md) |
| Permissions, limits, audit log | [Builder security](BUILDER-SECURITY.md) |
| SDK versioning and deprecations | [SDK compatibility](SDK-COMPATIBILITY.md) |
| Testing extensions | [Testing extensions](TESTING-EXTENSIONS.md) |

## Evidence

Paths are relative to `apps/server` unless they start with `packages/`.
"Admin" tests run with `pnpm vitest run --config admin-ui/vitest.config.ts`;
database suites run with `node scripts/run-database-suites.mjs` on
PostgreSQL, MySQL and MariaDB (and in CI).

| # | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Select, insert, move, nest, duplicate, copy/paste and delete on the canvas without losing content or ids | Admin `PageBuilder.actions.test.tsx`, `DragContext.test.tsx`, `dnd.test.ts`, `drop-rules.test.ts`, `block-actions.test.ts`; `packages/blocks/tests/unit/block-clipboard.test.ts`; database `builder-journeys-db` (ids kept through save and publish) | Automated |
| 2 | The same from Layers and by keyboard, invalid targets explained | Admin `Navigator.test.tsx`, `accessible-authoring.test.tsx` (canvas selection by keyboard, shortcuts, documented keyboard paths) | Automated; manual keyboard run pending |
| 3 | Text, button/link, list, caption and media fields edited in context | Admin `inline-editing.test.tsx`, `BlockPreview.inline-edit.test.tsx`, `media-fields.test.tsx`; `packages/blocks/tests/unit/inline.test.ts` | Automated |
| 4 | Flex and grid layouts, resize and reposition, same result on the page | Admin `layout-controls.test.tsx`, `GridEditor.test.tsx`, `preview-parity.test.tsx`; `packages/blocks/tests/unit/container-layout.test.ts`; database `builder-journeys-db` (grid renders on the published page) | Automated |
| 5 | Desktop, tablet and mobile previews; existing documents keep their behaviour | Admin `responsive-panel.test.tsx`, `preview-parity.test.tsx` (breakpoint rules); `packages/blocks/tests/unit/responsive.test.ts`; database `builder-upgrade-db` (pages render the same after upgrade) | Automated; visual check across themes pending (#310) |
| 6 | Global styles and overrides show their source, preview before publish, reset separately | Admin `style-presets.test.tsx`, `computed-block-values.test.ts`; `packages/blocks/tests/unit/style-presets.test.ts`, `builder-values.test.ts`, `template-defaults.test.ts` | Automated |
| 7 | Header, footer and templates edited in context with site-wide indication | Admin `site-context.test.tsx`, `shell/BuilderShell.test.tsx`; database `builder-journeys-db` (footer draft, publish, stale save) | Automated |
| 8 | Autosave, publish, undo/redo, refresh recovery, revisions, conflict detection | Admin `pages/admin/design/PageBuilderPage.test.tsx`, `useBuilderHistory.test.tsx`, `shell/RevisionsDialog.test.tsx`; `tests/integration/routes/content/content-draft-conflict-route.test.ts`; database `builder-concurrency-db`, `builder-journeys-db` (stale save refused, draft kept apart, revision restored) | Automated |
| 9 | Existing documents, patterns, reusable blocks, templates, plugin blocks, custom CSS and pages stay compatible | Database `builder-upgrade-db` (a pre-2.0 site upgrades with identical documents and rendering, on all three databases); `scripts/builder-rollback-drill.mjs` (see below); `packages/blocks/tests/unit/sanitize-document.test.ts` | Automated plus drill |
| 10 | A sample third-party block works end to end through SDK contracts only | `tests/integration/routes/content/block-contract-route.test.ts`; admin `plugin-block-contract.test.tsx`; database `builder-journeys-db` (plugin block migrated on read) | Automated |
| 11 | Unknown or disabled plugin blocks stay visible and recoverable, safely | Admin `block-recovery.test.tsx`; `block-contract-route.test.ts` (off and on again); database `builder-journeys-db` (kept while off); `packages/blocks/tests/unit/preview-safety.test.ts` | Automated |
| 12 | Builder and page match across themes, light/dark, locales/RTL and widths, except documented substitutions | Admin `preview-parity.test.tsx` (every core block, structure, classes, styles, breakpoints, stand-ins labelled); `tests/unit/rendering/layout-direction.test.ts` | Structural parity automated; visual comparison in browsers pending (#310) |
| 13 | Pointer, touch, keyboard, screen reader, high contrast, zoom, reduced motion, IME | Admin `accessible-authoring.test.tsx`, `i18n/plurals.test.ts`, `i18n/catalogs.test.ts`; `packages/blocks/tests/unit/accessibility.test.ts` | Automated parts done; manual matrix pending (#310) |
| 14 | Large documents meet budgets without unbounded preview or database work | Admin `builder-performance.test.tsx` (redraw and request budgets at 20, 200 and 1,000 blocks), `lib/block-preview-batch.test.ts`; `block-contract-route.test.ts` (batched previews read no database) | Counts automated; browser timings pending (#310) |
| 15 | Server tests for capabilities, tenant isolation, sanitation, preview origins, conflicts, safe failure | `tests/integration/security/builder-authorization.test.ts`, `builder-hardening.test.ts`; `packages/blocks/tests/unit/document-limits.test.ts`, `preview-safety.test.ts`; `tests/unit/cache/preview-cache-isolation.test.ts`; `pnpm test:security` | Automated |
| 16 | User and developer documentation | This page and the documents listed above | Done; to be checked against the shipped UI before release |

## Database coverage

`scripts/run-database-suites.mjs` creates one throwaway database per suite,
runs it with its own flag, and fails when a suite runs no tests. CI runs it
on PostgreSQL 18, MySQL 9.5 and MariaDB 11.4. Before #310 the CI job set one
flag for all suites, so three of its four steps skipped every test without
failing.

| Suite | PostgreSQL | MySQL | MariaDB |
| --- | --- | --- | --- |
| Builder (references, concurrency, journeys) | 21 passed | 21 passed | 21 passed |
| Builder upgrade drill | 5 passed | 5 passed | 5 passed |
| Security migrations, job queue, plugin rows, plugin schema, content visibility, agent isolation, AI keys | passed | passed | passed |
| Content scheduling, search | fail: stale fixtures (#319) | fail (#319) | fail (#319) |

## Upgrade and rollback

Builder 2.0 adds two migrations, both additive and safe to run again:
`0057_document_revisions` (a `revision` column on template parts and theme
templates) and `0058_document_history` (a new table). Stored documents are
not rewritten; new props are only written when an author saves.

**Upgrade.** The upgrade drill fills a database at the schema before Builder
2.0 with documents written the way the previous version wrote them: a page
with grid placement, custom CSS, device visibility and a reusable block, a
footer, a header library, a template override and an old reusable block
library. After the Builder 2.0 migrations, every document reads back
unchanged, the page renders byte for byte the same, upgraded parts start at
revision 1 and accept revision-checked saves, and the migrations can run
again without effect.

**Rollback.** `node scripts/builder-rollback-drill.mjs` takes the previous
version's block package from git and runs its cleaner and renderer on
documents saved by Builder 2.0. Result for `c5dba61` (the version before
Builder 2.0):

| Documents | Block ids | Text | Ignored by the previous version |
| --- | --- | --- | --- |
| Layout, responsive values, presets | kept | kept | Container layouts render as a stack; tablet and mobile overrides are ignored; style presets are ignored |
| Editor labels and locks | kept | kept | nothing |
| Inline media fields | kept | kept | nothing |
| Reusable reference and plugin block | kept | kept | nothing |

Going back to the previous version therefore loses no content, but pages
that use the new layout, responsive or preset settings look simpler until
the site upgrades again. The `revision` column and `document_history` table
are ignored by the previous version.

## Rollout

1. Merge to `develop`; CI runs the unit, admin, security and database suites
   on all three databases.
2. Run the rollback drill and the manual checks in
   [Builder accessibility](BUILDER-ACCESSIBILITY.md#testing) (accessibility,
   browsers, performance) on a staging copy of a representative site, and
   record the results and versions here.
3. Release with the changelog entries for #293–#310. Note in the release
   notes that downgrading keeps content but drops the look of Builder 2.0
   layout, responsive and preset settings.
4. Before upgrading a production site, take a backup (see
   [Backup and recovery](BACKUP-RECOVERY.md)). To roll back, reinstall the
   previous version; no schema change needs undoing.
5. Close #292 when the release is public and this page links its evidence.

## Known limitations

| Limitation | Ticket |
| --- | --- |
| Core blocks are drawn by the builder, not the server renderer; parity is checked by test | #311 |
| Some admin messages with counts have one plural form | #312 |
| Accessibility checks are not yet available in the management API or to the assistant | #313 |
| Custom roles cannot change site design | #314 |
| Some design routes show a failed save's raw message to administrators and editors | #315 |
| A slow plugin block render is not interrupted | #316 |
| Email logos are typed as addresses, not picked from the media library | #317 |
| KaTeX loads with the builder even without formulas | #318 |
| Content scheduling and search database suites need updated fixtures | #319 |
| Browser-based journeys, visual parity, browser timings and the manual accessibility matrix | #310 (carried-over items) |
