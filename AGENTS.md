# Justflows agent guide

## Scope

These instructions apply to the entire repository. Load the focused skill in `.agents/skills/` that matches the work before making changes. Use `justflows-platform` first for cross-cutting or architectural work. Load `justflows-changelog` whenever the change belongs on `CHANGELOG.md` or implements a Public Roadmap item.

This is the public development repository (`justflows-ce-development`). Open
PRs into `develop` from `feature/`, `bug/`, `patch/`, or the other allowed
prefixes. Do not push to `main` or `develop`. CI runs only on PRs into
`develop`. Publish snapshots go to `justflows-ce` only when Dirk asks.

User-visible work must cite the matching [Public Roadmap](https://github.com/orgs/JustFlows/projects/35) issue in `CHANGELOG.md` (see `.agents/skills/justflows-changelog/SKILL.md`). Close that `justflows-ce` issue only after the line has shipped on public `justflows-ce`, not when the feature PR merges here.

## Repository invariants

- This is a pnpm/Turborepo TypeScript monorepo. Use pnpm and workspace filters; do not introduce a second package-management path.
- Keep `packages/core` independent of Express, React, and EJS. Framework integration belongs in `apps/server`.
- Treat `packages/sdk` as a stable public contract. Coordinate compatible changes through the SDK, plugin runtime, example extension, and tests.
- Support PostgreSQL, MySQL, and MariaDB wherever persistence changes. Treat the shipped `0036_baseline` and every later applied migration as immutable; add the next numbered migration (check the highest number in `migrations/`) and register it in `MIGRATION_ORDER`. Ship `NNNN_name.sql` (PostgreSQL) and `NNNN_name.mysql.sql`; MariaDB reuses the MySQL file automatically (`migrationFileCandidates` in `run-migrations.ts`) — only add `NNNN_name.mariadb.sql` when the DDL genuinely has to differ.
- Preserve browser-first installation and administration. Production users must not need a source checkout or build toolchain.
- Never weaken authentication, capability checks, path validation, archive validation, HTML sanitization, upload limits, or secret handling.
- New core source files start with `// SPDX-License-Identifier: MIT`. Extension manifests declare their own license; Marketplace listings use a GPL-compatible license.
- Do not commit credentials, real `.env` files, generated builds, uploads, caches, or dependency directories.
- Preserve unrelated working-tree changes. Make the smallest coherent change and verify it at the narrowest useful scope.
- Public production releases must use stable SemVer only. Never commit an `-rc`, `-alpha`, `-beta`, or other prerelease version to public `main`, stable release branches, stable tags, release assets, package manifests, lockfiles, or released changelog headings. Prerelease identifiers belong only in private development or an explicitly requested public prerelease workflow.
- Every GitHub release body must contain the complete matching version section from `CHANGELOG.md`, copied verbatim through the next version heading. Preserve every category present, including `Added`, `Changed`, `Fixed`, and `Removed`; never substitute GitHub's generated notes for the full project changelog.
- Never add an AI agent as a contributor, author, co-author, or credits entry in commits, changelogs, contributor files, package metadata, or release notes. After every commit, check `git log -1 --format='%B'` and strip `Co-authored-by: Cursor` with `git commit-tree` if a wrapper injected it.
- Do not add `actions/dependency-review-action` as a required CI job. It needs GitHub Dependency graph, which public `justflows-ce` does not have, and fails with "Dependency review is not supported on this repository." Advisory gating is `pnpm audit --audit-level high` in the `security` job. Do not reintroduce that action when syncing to the public repo.
- Treat CodeQL findings as real defects: constrain filesystem paths with `resolvePathUnderBase`; rate-limit every route that performs filesystem or other expensive work with `express-rate-limit`; use the `@justflows/blocks` sanitizers instead of tag-stripping regexes or raw stored HTML; never interpolate request data into a `console.*` format string (use `.replace(/\n/g, "")` and `JSON.stringify`); and avoid exists-then-open races. Review network data written by caches and uploads as untrusted persisted content. Do not disable CodeQL to make a public PR green. The only sanctioned query exclusions are the ones documented in `.github/codeql/codeql-config.yml` (`js/http-to-file-access`, `js/insufficient-password-hash`); adding another needs Dirk's explicit approval and a written justification there. See the security checklist in `CONTRIBUTING.md`.

## Working map

- `apps/server/src`: Express app, routes, middleware, services, EJS, installation, and runtime integration.
- `apps/server/admin-ui`: React/Vite administration SPA.
- `packages/core`: lifecycle, hooks, configuration, logging, and health.
- `packages/database`: adapters, schema, migration tooling, and queries.
- `packages/sdk`: public plugin/theme types and APIs.
- `packages/plugin-api`: extension loading, manifests, activation, and runtime boundaries.
- `packages/{auth,content,blocks,media,installer,updater,cache,jobs}`: domain packages.
- `plugins/`: developer workspace for plugins. Create `plugins/<name>/` and start there. `plugins/hello-world` is the example to copy.
- `themes/default` and `css-providers`: presentation integrations.
- `migrations`: the consolidated schema baseline and later tracked SQL migrations for all database dialects.
- `docker`, `scripts`, and `server.js`: distribution, hosting, startup, and releases.

## Performance and data-access rules

Read [docs/PERFORMANCE.md](docs/PERFORMANCE.md) before changing list rendering, bulk operations, background jobs, or database-backed helpers.

- Trace helper calls inside loops: database access can be hidden behind settings, URL, permission, or reference-resolution functions.
- Batch related reads and writes with parameterized, bounded queries. `Promise.all(items.map(query))` is still N queries; do not use it as a substitute for batching.
- Load shared settings and reference data once per operation. Keep reused data scoped to the correct database, site, locale, preview mode, and authorization context; avoid process-global mutable snapshots.
- Use `Map`/`Set` indexes for repeated array searches and membership tests. Preserve ordering and duplicate/first-match behavior; multiple linear passes are acceptable when clearer.
- Preserve tenant predicates, transaction/lock boundaries, validation, per-item hooks/audits, cache invalidation, and failure behavior when optimizing.
- For performance fixes, add regression coverage that verifies both results and query growth for multi-item inputs. Run focused checks and report any unavailable real-database checks.

## Folder and test placement

Follow `docs/CONVENTIONS.md` for the complete layout. Server helpers and routes
are grouped by domain; admin pages use `pages/admin/<domain>/`. Tests belong
in the owning app/package/plugin's `tests/` tree, outside production `src`.
Keep the admin browser suite under `apps/server/admin-ui/tests/` and HTTP/DB
integration suites under `apps/server/tests/integration/`. Update imports,
mock paths, assets, worker entrypoints, and test configs together when moving
files. Preserve package public exports and route registration order.

## Verification

Use package-level checks while iterating, then relevant root checks when practical. Typical commands are `pnpm --filter <package> typecheck`, `pnpm --filter <package> test`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Report checks not run and why.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
