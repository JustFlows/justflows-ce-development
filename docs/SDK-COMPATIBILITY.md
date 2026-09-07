# SDK compatibility and deprecation policy

`@justflows/sdk` and the package manifest are the public contract for plugins,
themes, and CSS providers. Public exports, manifest fields, hook names and
payloads, permission names, and runtime context shapes follow Semantic
Versioning.

## Compatibility guarantees

- Patch releases fix behavior without intentionally breaking supported extensions.
- Minor releases are additive. New fields are optional unless a new manifest
  schema version explicitly opts in to them.
- A public contract is removed or changed incompatibly only in a major release.
- Runtime behavior that cannot be expressed in TypeScript receives the same
  compatibility treatment as exported types.

Every plugin, theme, and CSS-provider package declares its supported host range
as a semver range:

```json
{
  "engines": {
    "justflows": ">=0.1.8 <0.2.0"
  }
}
```

The installer checks this range against the running CE version before moving a
package out of staging. An incompatible package is not installed. The legacy
top-level `justflows` field remains readable for existing packages, but new and
updated packages must use `engines.justflows`.

A development host prerelease is treated as implementing its base release for
this host-compatibility check: `0.1.8-dev.1` satisfies a package range beginning
at `0.1.8`, while it does not satisfy one beginning at `0.1.9`. This exception
applies only to the running host compatibility check; extension versions and
stable releases retain standard SemVer precedence.

The same `ExtensionEngines` type and `ExtensionEnginesSchema` exported by
`@justflows/sdk` describe this field for every extension type.

Plugins additionally receive executable runtime context and can inspect
`ctx.runtime.justflows`, `ctx.runtime.sdk`, and
`ctx.runtime.sdkApi`. Authors can also import `SDK_VERSION` and
`SDK_API_VERSION` from `@justflows/sdk`. `ctx.version` continues to mean the
plugin's own version.

### SDK `0.1.6` — additive

- `ctx.content.listPublished(query?)` returns published entries (`type`, `slug`,
  `locale`, `fields`, `authorId` / `authorName`, dates). Requires `content:read`;
  scheduled and expired entries are excluded unless `includeScheduled` is set.
- `ctx.i18n.defaultLocale()` and `ctx.i18n.locales()` expose the site's locale
  configuration read-only (no permission).
- The `html.head` filter context gains `locale` (the current page's content
  locale). Existing handlers that ignore it are unaffected.
- A plugin manifest may declare `hostCooperative: true`. It is meaningful only
  for the handful of first-party ids the host would otherwise leave
  inactive (`justflows.seo`); it tells the runtime the shipped module only
  augments host behavior and is safe to activate. Ignored for third-party
  plugins.

Authenticated plugin HTTP requests expose additive `session.capabilities` and
`session.scopes` fields. They describe the user's effective access after custom
role, grants, denies, and resource constraints. Existing role names remain
supported, but new authorization code should use these capability contracts.

Plugins register their own user-facing capabilities through
`ctx.capabilities.register()`. Registrations live only while the plugin is
active and are the source for role-editor choices and effective policy
validation; this keeps core domain-agnostic.

## Deprecation cycle

1. Mark the public symbol or field `@deprecated`, document its replacement, and
   keep the old behavior working throughout the current major line.
2. Record the deprecation under the SDK subsection of `CHANGELOG.md` and in the
   migration guidance for extension authors.
3. Keep the deprecated contract for at least one minor release before removal.
4. Remove it only in the next major release, with an explicit migration note.

Security fixes may require a faster change. When compatibility cannot safely be
preserved, the release notes must identify the exception and the supported
migration path.

## SDK changelog and API gate

Every SDK- or extension-manifest-facing addition, deprecation, behavior change,
or removal gets a clearly labelled **SDK** bullet in `CHANGELOG.md`.
Public-roadmap work links its matching issue.

`packages/sdk/api-surface.json` is the reviewed export snapshot. CI runs
`pnpm sdk:api:check`; deleting or renaming a public export fails the check.
Intentional additive exports are recorded with `pnpm sdk:api:update`. Do not
update the snapshot to hide a removal that has not completed the deprecation
cycle.
