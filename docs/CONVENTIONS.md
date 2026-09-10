# Naming and structure conventions

This document is the canonical reference for how files, folders, and packages
are named across Justflows CE. Most of the repository already follows these
rules by convention; this page makes the rules explicit so new packages,
plugins, and PRs stay consistent. If you add a folder or naming pattern this
document doesn't cover, extend it in the same PR.

## Top-level layout

| Path                     | Contents                                       | Naming                                                                                   |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server`            | Express app, EJS views, and the Vite SSR admin | see below                                                                                |
| `packages/<name>`        | Framework-neutral domain packages              | lower-kebab package name, scoped `@justflows/<name>`                                     |
| `plugins/<name>`         | Example and developer plugin workspaces        | lower-kebab, matches the plugin id's last segment                                        |
| `themes/<name>`          | Presentation themes                            | lower-kebab                                                                              |
| `css-providers/<name>`   | CSS framework integrations                     | lower-kebab, one word where possible (`open-props` is the accepted multi-word exception) |
| `docs/*.md`              | Author/extension guides                        | `UPPERCASE.md`, except `README.md`                                                       |
| `licenses/*.md`          | Licensing policy documents                     | `NN-slug.md`, zero-padded two-digit prefix in reading order                              |
| `migrations/*.sql`       | Database migrations                            | `NNNN_description[.dialect].sql`, see [Migrations](#migrations)                          |
| `docker`, `scripts`      | Distribution and release tooling               | lower-kebab                                                                              |
| `.agents/skills/<skill>` | Agent skill guides                             | `justflows-<area>`, one `SKILL.md` per folder, plus `agents/{claude,cursor,openai}.yaml` |

`apps/` is plural because it is the workspace category for deployable
applications, not a count; it currently holds one app (`apps/server`) and may
hold more later (e.g. a future worker or CLI app). Don't rename it to
singular when there's only one entry.

## Packages (`packages/*`)

- Package directory name and npm name are the same slug: `packages/plugin-api` ⇒ `@justflows/plugin-api`.
- Every package has a single barrel at `src/index.ts`. Consumers import the
  package by its public export, not by deep path, unless the package
  explicitly documents subpath exports (e.g. `packages/database/src/schema/*`).
- Source files are `kebab-case.ts` throughout `packages/*/src`. No camelCase
  or PascalCase filenames — this holds with zero exceptions today; keep it
  that way.
- Prefer a flat `src/` over a directory-per-file. Wrap a concern in its own
  subdirectory only when it holds more than one file (multiple modules,
  or an implementation plus its types). A folder containing a single
  `hash.ts` or a single `types.ts` should usually just be a top-level file
  (`hash.ts`, `types.ts`) instead.
- Tests are colocated as `<name>.test.ts` next to the file under test. This
  is the standard going forward for all packages. A few packages still use a
  `src/__tests__/` folder from before this was written down — leave those as
  they are rather than a drive-by rename, but write new tests colocated and
  migrate a package's tests to colocated form when you're already touching
  most of its `src/` in one PR.
- A package with no tests yet should start with colocated `*.test.ts`, not a
  `__tests__/` folder.

## `apps/server/src` (Express app)

- `routes/<resource>.ts`: one file per resource, named for the resource the
  routes serve. Use the plural form for collection-style resources
  (`blocks.ts`, `menus.ts`, `themes.ts`, `users.ts`) and the singular/mass
  form for singleton or whole-site concerns (`content.ts`, `install.ts`,
  `security.ts`, `settings.ts`, `site.ts`). When in doubt, match the plural
  default.
- `middleware/<concern>.ts`: kebab-case, named for what the middleware
  enforces or attaches, not for where it's used.
- `lib/<concern>.ts`: kebab-case. Files that read/write a specific table or
  domain use the `<concern>-db.ts` suffix (`themes-db.ts`, `menus-db.ts`,
  `plugins-db.ts`, `css-providers-db.ts`); keep using that suffix for new
  DB-access modules so it stays a reliable signal.
- `views/*.ejs`: flat, kebab-case for multi-word views
  (`under-construction.ejs`). Nest only for genuinely reusable fragments,
  as `views/partials/` already does.
- Tests live in a single `__tests__/` folder per directory
  (`lib/__tests__`, `middleware/__tests__`) — this is the established
  pattern for `apps/server/src` specifically and differs from the
  colocated-test rule for `packages/*`; don't mix the two within this tree.
- A package (`packages/x`) and its host-side wiring in `apps/server/src/lib`
  may legitimately share a base filename when one wraps the other (for
  example `packages/cache/src/jf-cache.ts` and
  `apps/server/src/lib/jf-cache.ts`, or `site-widgets.ts` in both
  `packages/blocks/src/core` and `apps/server/src/lib`). This is intentional,
  not a collision — the package file is framework-neutral logic and the
  `apps/server` file is the Express-side singleton/wiring around it.

## `apps/server/admin-ui/src` (SSR admin application)

- `entry-server.tsx` is the Node render entry; `entry-client.tsx` is the browser
  hydration entry. Shared components must render without browser globals.
- `ssr-data.ts` is the typed boundary for request-scoped initial data. Never put
  secrets or data outside the current session's capabilities in this payload.
- Import `Link`, `NavLink`, `Navigate`, and `useNavigate` from `admin-router`
  so rendered links and navigation use the configured admin base path. For
  native anchors or browser navigation, resolve admin URLs with `publicAdminPath`
  from `admin-path`; keep API and public-site URLs unchanged.
- Vite writes browser assets to `dist/client` and the Node renderer to
  `dist/server`; distribution paths must include both.

- `pages/<Name>Page.tsx`: one top-level React page per admin screen, PascalCase,
  suffixed `Page`. Group route-scoped page families in a subfolder named for
  the group (`pages/admin/security/`).
- `components/<Name>.tsx`: PascalCase, one component per file. Group a
  cohesive feature's components in a lower-kebab subfolder
  (`components/builder/`), not by file type.
- Non-component logic inside a feature folder (state helpers, tree/DOM
  utilities, types) is `kebab-case.ts` (`components/builder/block-tree.ts`,
  `dnd.ts`, `grid.ts`), matching the package convention above.
- Hooks are `camelCase.ts` starting with `use`
  (`components/builder/useBuilderHistory.ts`), matching standard React
  convention — this is the one deliberate exception to kebab-case for
  non-component files.
- `lib/`, `config/`, `i18n/`: kebab-case utility modules.
- Tests are colocated as `<Name>.test.tsx` / `<name>.test.ts` next to the
  file under test. `pages/__tests__/admin-a11y.test.tsx` predates this rule
  and covers cross-page a11y assertions rather than one page, which is why
  it doesn't live next to a single page file — leave it where it is.

## Plugins (`plugins/*`)

- Directory name matches the plugin id's final segment
  (`justflows.hello-world` ⇒ `plugins/hello-world`).
- Minimum layout: `justflows.json`, `package.json`, `src/index.ts`. See
  [PLUGINS.md](PLUGINS.md) and [MANIFEST.md](MANIFEST.md).
- Copy `plugins/hello-world` to start a new plugin; don't hand-build the
  layout from scratch.

## Themes (`themes/*`)

- `justflows-theme.json` (or `justflows.json`) marks a directory as a theme.
- Theme metadata declares `engines.justflows`; a packaged theme repeats the
  same range in its archive-root `justflows.json` install manifest.
- `styles/`, `patterns/`, `demo/` are the recognized subfolders; see
  [THEMES.md](THEMES.md) for exactly what the host reads from each.

## `docs/` and `licenses/`

- `docs/*.md` guides are named `UPPERCASE.md` for the topic they cover
  (`PLUGINS.md`, `THEMES.md`, `MANIFEST.md`). `README.md` is the index and is
  the only mixed-case file in the folder. New author-facing guides follow
  this pattern and get a row in `docs/README.md`'s table.
- `licenses/*.md` are named `NN-slug.md`, numbered in the order
  `LICENSING.md` presents them. The number is load-bearing — it's
  cross-referenced by `CONTRIBUTING.md` and `LICENSING.md` — so don't
  renumber an existing file; append the next number for a new policy
  document.

## Migrations

- `NNNN_description.sql` for Postgres (the default dialect, no suffix) and
  `NNNN_description.mysql.sql` for MySQL. MariaDB reuses the MySQL file: the
  runner tries `.mariadb.sql`, then `.mysql.sql`, then the bare `.sql`
  (`migrationFileCandidates` in `run-migrations.ts`). Only add a separate
  `NNNN_description.mariadb.sql` when the DDL must actually differ between the
  two — it has not so far, and `0013`–`0016` no longer carry one. Only the
  consolidated `0012_baseline` still ships all three files.
- Zero-pad the number to four digits. Use `snake_case` for the description.
- `0012_baseline` contains the ordered schema history from `0001` through
  `0012`. It is used for both fresh installations and upgrades from older
  releases, then recorded once in the existing `_migrations` table.
- Never edit the shipped `0012_baseline` or a later applied migration (see
  `AGENTS.md`). Add the next number, even if only one dialect's schema
  actually changes. Find the highest number in `migrations/` and use the next number;
  `0029_search_metrics` is currently the latest.
- Add each new migration name to `MIGRATION_ORDER` in
  `apps/server/src/lib/run-migrations.ts`. The runner skips names already
  recorded in `_migrations`.

## Scripts (`scripts/*`)

- Prefer `.js` for Node scripts at the repo root's CommonJS default. Reach
  for `.cjs` only when a script must force CommonJS despite `"type": "module"`
  being set somewhere in its resolution path — not as a stylistic choice.
  (`scripts/bootstrap-gate.cjs` and `scripts/install-token.cjs` predate this
  rule and don't need the distinction; new scripts should default to `.js`.)

## Resolved gaps

These were flagged in the initial structure audit and have since been fixed
to match the rules above:

- `public/js/*.js` is now tracked in version control (it's hand-authored
  source referenced directly by `apps/server/src/views/layout.ejs`, not a
  build artifact).
- `apps/server/src/lib/i18n/admin/` and `.../catalogs/` are renamed to
  `admin-catalogs/` and `site-catalogs/` — they hold different catalogs (the
  admin application's nested translation bundle vs. the public site's flat one), and
  the parallel `-catalogs` suffix makes that distinction explicit instead of
  one directory looking like the unqualified default.
- `packages/auth/src` no longer wraps single-file concerns in their own
  subdirectories: `password/hash.ts` → `password.ts`,
  `capabilities/index.ts` → `capabilities.ts`, `session/types.ts` →
  `session.ts`, matching the flat style of `sdk`, `updater`, and `jobs`.
