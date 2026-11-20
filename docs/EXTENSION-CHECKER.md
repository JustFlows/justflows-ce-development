# Extension checker

`justflows check` looks at a plugin, theme, or CSS provider before you publish it and
reports manifest, permission, compatibility, security, packaging, and accessibility
problems. The Marketplace review runs the same rules as its automated baseline. A
passing check is **not a guarantee of safety**: extensions run as trusted server code.
See [extension review](EXTENSION-REVIEW.md) and [extension trust](EXTENSION-TRUST.md).

## Run it

```bash
justflows check ./my-plugin             # a source folder
justflows check ./my-plugin-1.2.0.jfpkg # a built package, opened like the installer does
justflows check ./my-plugin --json      # machine-readable report
justflows check --rules                 # list every rule
```

| Option | Meaning |
| --- | --- |
| `--json` | Print the report as JSON. |
| `--fail-on error\|warning\|info` | Exit with 1 at this severity or worse. Default: `error`. |
| `--baseline <file>` | Accept the findings listed in this file. |
| `--write-baseline` | Write every current finding to the baseline file and exit 0. |
| `--core <version>` | Check compatibility against this Justflows version. |

Exit codes: `0` nothing blocking, `1` blocking findings, `2` the check could not run.

In a source folder, the checker skips `node_modules`, tests, and build tooling
(`scripts/`, `*.config.*`). In a `.jfpkg` every file counts, and the packaging rules
also run.

### Accepted findings

A finding you have reviewed and accept goes into `.justflows-check.json` in the
package folder. Each entry names the rule and, optionally, the file; add a reason.

```json
{
  "version": 1,
  "ignore": [
    { "rule": "JF-S004", "file": "admin/app.js", "reason": "Value comes from escapeHtml()" }
  ]
}
```

### In CI

```yaml
- uses: JustFlows/justflows-ce/.github/actions/extension-check@main
  with:
    path: .
    fail-on: error
```

The action installs the checker from the Justflows repository, runs it, and fails the
job on blocking findings. The JSON report is written to `justflows-check.json`.

### From code

`@justflows/check` exports `checkPackage(path, options)`. Pass `extraRules` to add your
own rules; the Marketplace adds its listing rules this way.

### In the admin

The checker is a tool for plugin authors, so it is off in the admin by default. To
use it there, set `JF_EXTENSION_CHECKER=on` in `.env` and restart. **Extensions →
Plugins** then has a **Check** action for installed packages, on the main site, for
administrators. It runs the same rules on the installed files. Without the setting,
the action is hidden and its API answers `404`. `justflows check` and the CI action
work either way.

## Report

Every finding has a stable rule id, a severity (`error`, `warning`, or `info`), a
category, a message, the file and line when known, and a link to its section below.
The report includes the rule set version (`rulesetVersion`). Rule ids are never reused;
a change to what a rule reports bumps the rule set version.

The checks read code with patterns, not a full parser. A finding marks code to look
at. When it is a false alarm, add it to the baseline with a reason.

## Rules

### Manifest

### JF-M001

`justflows.json` is missing or not valid JSON. The installer needs it in the package
root.

### JF-M002

The manifest does not match the schema the installer accepts. The message names the
field.

### JF-M003

A declared permission does not exist. See [permissions](PERMISSIONS.md).

### JF-M004

A manifest feature needs a permission the manifest does not declare: `adminMenu`,
`adminApp`, and `setupPath` need `admin:extend`; `contentTypes` needs `content:delete`.

### JF-M005

A deprecated manifest field is set (`justflows`, `minJustflowsVersion`,
`maxJustflowsVersion`). Declare `engines.justflows` instead.

### JF-M006

The license is neither GPL-compatible nor a closed `LicenseRef-<name>` license, or the
package has no `LICENSE` file. Marketplace listings need both.

### JF-M007

A file the manifest declares is not in the package: the server entrypoint, an asset, an
admin page or catalog, or a pattern. In a source folder, build output under `dist/` is
not required yet.

### JF-M008

`package.json` disagrees with the manifest: a different version, or no
`"type": "module"`.

### JF-M009

The package has no `README.md`.

### JF-M010

A CSS provider declares scripts. CSS providers may only ship styles.

### JF-M011

Warning: the license is closed (`LicenseRef-<name>`). Justflows installs a closed
package only with a valid Marketplace signature, never from an upload, a pinned
digest, or `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES`. The registry signs closed packages only
under a closed-source contract with Justflows (plugins and themes, free or paid), and
reviewers always see the source.

### Compatibility

### JF-C001

`engines.justflows` is missing, is not a valid range, or does not include the Justflows
version being checked. The installer refuses a package whose range excludes the host.

### JF-C002

The `@justflows/sdk` range in `package.json` does not include the current SDK.

### Permissions

### JF-P001

The code calls an API or registers a hook that needs a permission the manifest does not
declare. The host refuses the call at run time, or the hook at activation. Declare the
permission, or remove the call.

### JF-P002

A declared permission was not found in use. Each permission must have a clear purpose
(least privilege). Some permissions cannot be detected from code; those are not
reported.

### JF-P003

A sensitive permission is declared (for example `network:outbound`, `users:manage`, or
`mail:send`). Explain in the listing why the extension needs it.

### Security

### JF-S001

`eval`, `new Function`, or a string passed to `setTimeout`/`setInterval` runs text as
code.

### JF-S002

The code reaches past the SDK: `child_process`, `vm`, `worker_threads`, or `cluster`
(error); raw network modules without `network:outbound` (error), or with it (warning,
use `ctx.outbound.fetch` for the SSRF guard); the filesystem (warning, read only the
extension's own files); or `process.env`, which holds the installation's secrets
(warning).

### JF-S003

SQL is built with `${…}` interpolation. Pass values as `?` parameters.

### JF-S004

HTML is written without sanitizing: `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`document.write`, or `dangerouslySetInnerHTML`. Use `textContent`, or sanitize with the
SDK sanitizers.

### JF-S005

The package holds credentials: key files, `.env`, `.npmrc`, or text that looks like a
private key or a provider token. Remove them and rotate the secret.

### JF-S006

HTML that the Content Security Policy blocks: an inline `<script>`, an inline event
handler such as `onclick=`, or a `javascript:` URL. Move the code to a script file.
JSON-LD and import maps are allowed inline.

### JF-S007

Code is loaded from another origin at run time: a remote `<script src>` or a dynamic
`import()` of a URL. Ship the code in the package so it is reviewed and signed.

### JF-S008

A file registers routes that change data (`post`, `put`, `patch`, `delete`) but never
reads `req.session` or a capability. Check who is calling, unless the route
authenticates another way, such as a signed webhook.

### Packaging

### JF-K001

The unpacked package is larger than the installer allows, or has too many files.

### JF-K002

The package contains a native binary (by extension or file signature). Packages ship
JavaScript, styles, and data only.

### JF-K003

A built package contains source maps, which publish the original source.

### JF-K004

A built package contains `node_modules` or development files (`.git`, editor folders,
coverage). Bundle what you need.

### Themes

### JF-T001

The theme has no `templates/index.json`, the fallback for every page.

### JF-T002

A template, part, or pattern is not valid JSON, or a template is not a block document
(`{ "blocks": [...] }`).

### JF-T003

A stylesheet uses literal colors outside custom properties. Use `var(--color-…)`
tokens so the customizer and dark mode apply. Defining tokens with literal values is
fine.

### JF-T004

A `:focus` rule removes the outline with no visible replacement, so keyboard users
cannot see where they are. Use `:focus-visible` with a visible style. The host renders
the page landmarks (`header`, `main`, `footer`) itself.

### JF-T005

A script switches the color scheme after the page loads, which flashes the wrong colors
on first paint. Use `prefers-color-scheme` in CSS.
