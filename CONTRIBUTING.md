# CONTRIBUTING.md

Thank you for contributing to Justflows!

## License

Justflows core is licensed under the **MIT License**.

By contributing, you agree that your contributions to core are licensed under MIT and
that you have the right to submit them.

Bundled plugins and themes keep **their own license** (see each package manifest).
Contributions to those packages follow that package's license.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin Version 1.1](https://developercertificate.org/).

By contributing, you certify that:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have the right to
    submit it under the open source license indicated in the file; or

(b) The contribution is based upon previous work that, to the best of my knowledge,
    is covered under an appropriate open source license and I have the right under
    that license to submit that work with modifications, whether created in whole or
    in part by me, under the same open source license (unless I am permitted to
    submit under a different license), as indicated in the file; or

(c) The contribution was provided directly to me by some other person who certified
    (a), (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution are public and that
    a record of the contribution (including all personal information I submit with it,
    including my sign-off) is maintained indefinitely and may be redistributed
    consistent with this project or the open source license(s) involved.
```

## Sign-off

Every commit must include a sign-off line:

```
Signed-off-by: Your Name <your.email@example.com>
```

Example:

```bash
git commit -s -m "fix(auth): validate session expiry"
```

## Branch model

This is the public development repository. Do not push to `main` or `develop`.
Releases are published from `main` to [`JustFlows/justflows-ce`](https://github.com/JustFlows/justflows-ce) `developers` first. A version is cut from `developers` to `main` there.

| Branch | Purpose |
| --- | --- |
| `main` | Stable snapshot. Protected. Update only by PR from `develop`. |
| `develop` | Integration. Protected. Update only by PR from a prefixed branch. |
| `feature/<name>` | New work. Branch this off `develop`. |
| `bug/<name>` or `fix/<name>` | Bug fixes. |
| `patch/<name>` | Patches. |
| `hotfix/<name>` | Production emergencies, branched from `main`. |
| `chore/`, `docs/`, `refactor/`, `test/` | Also allowed. |

Branch names outside those prefixes are rejected.

```bash
git fetch origin
git checkout develop
git pull origin develop
git checkout -b feature/short-description
# make changes, commit with -s
git push -u origin HEAD
```

Open a pull request **into `develop`**. Tests, the dependency audit, and CodeQL run on that PR only — not on feature-branch pushes and not on PRs into `main`.

After the work lands on `develop`, maintainers open a pull request from `develop` **into `main`** for the release. That PR does not re-run the test suite. Merging into `main` runs `.github/workflows/sync-to-justflows-ce.yml`, which opens (or updates) a publish PR into `justflows-ce` **`developers`**. Only that Action and org owners can open PRs there. Cut the public version from `developers` to `main` on `justflows-ce`.

The GitHub release body must copy the complete matching version section from `CHANGELOG.md`, verbatim through the next version heading. Include every category present—normally `Added`, `Changed`, `Fixed`, and `Removed`—and do not replace it with GitHub's generated notes. Verify the published body and release assets after creation.

## Code guidelines

- Match existing TypeScript style and package conventions
- Keep CMS core packages free of Express/React/EJS imports (see architecture docs)
- Add `// SPDX-License-Identifier: MIT` to new core source files
- Run tests and typecheck before opening a PR
- Name and place new files and folders per [docs/CONVENTIONS.md](docs/CONVENTIONS.md); update it in the same PR if you introduce a pattern it doesn't cover

## Local verification

From the repository root:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @justflows/installer test
pnpm --filter @justflows/server test
```

`pnpm test` runs every workspace package that declares a `test` script (Turbo). Installer tests cover the `.jfpkg` manifest contract used by the plugin/theme installer. Server tests cover SEO helpers, the public OpenAPI document, and axe checks on login, install, content, media, and plugin admin routes.

Pull requests into `develop` run the core package tests, installer contract tests, typechecks, dependency audit, and CodeQL in GitHub Actions (`.github/workflows/ci.yml`). A green PR means those packages built and tested on CI, not only on a laptop.

### Security and CodeQL checklist

- Never strip HTML with a regular expression or render stored HTML directly. Use the `@justflows/blocks` sanitizers (`sanitizeRichText`, `sanitizeHtmlBlock`, or `sanitizePlainText`) immediately before the relevant HTML or text sink.
- Add `express-rate-limit` middleware to every route that performs filesystem access or another expensive operation, including authenticated install, delete, download, and `sendFile` handlers. CodeQL does not recognize the custom in-process counter as route middleware.
- Resolve every user-influenced filesystem path with `resolvePathUnderBase`; do not rely on string replacement, prefix checks without a trailing separator, or exists-then-open checks.
- Treat network data persisted by caches, uploads, imports, and downloaders as untrusted. Use fixed application-owned directories, derived filenames, size limits, schema/content validation, and ensure later readers never treat cached bytes as executable or trusted package content.
- Run the PR CodeQL workflow after security-sensitive or broad changes and inspect every new branch alert. Do not disable a query or dismiss an alert unless the flow is demonstrably intentional and the security boundary is documented.

## Plugin and theme contributions

Write a new plugin in `plugins/<your-plugin-name>/`. Copy `plugins/hello-world`
and change the id, manifest, and `src/`. See `plugins/README.md` and `docs/`.

Extensions declare **their own license** in the manifest. Official Marketplace
listings must use a **GPL-compatible license**. See `LICENSING.md` and
`licenses/03-plugins.md`.

## Questions

- Licensing: `legal@justflows.com`
- Security: see `SECURITY.md` or email `security@justflows.com`
- Conduct: see `CODE_OF_CONDUCT.md`

### Scheduling integration tests

The opt-in scheduling suite uses a fresh disposable `schedule_test` database
and verifies the new migration, concurrent workers, restart catch-up, revisions,
locale isolation, expiry and durable events on PostgreSQL, MySQL and MariaDB.
See [the scheduling verification commands](docs/SCHEDULING.md#developer-verification).
