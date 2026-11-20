# 03 — Plugin License Policy

**Applies to:** All software extensions registered as Justflows plugins via `justflows.json`.

**Version:** 3.2

---

## Overview

Justflows **core is MIT**. Plugins are **not** automatically MIT.

Plugins that integrate with Justflows through hooks, APIs, and the plugin runtime
are separately licensed packages. Each plugin declares its license in the manifest.

> **Plugins declare their own license. Official Marketplace listings and
> installed packages use a GPL-compatible SPDX identifier (GPL, MIT, BSD, ISC, and similar).
> They are not MIT just because core is MIT.**

You may **charge money** for plugins. Closed-source plugins, free or paid, are
allowed on the official Marketplace only under a closed-source contract with Justflows (see
[Closed-source plugins](#closed-source-plugins-under-contract)).

---

## Allowed licenses

| License | Official Marketplace? |
|---|---|
| **GPL-2.0-or-later** | Yes (common) |
| **GPL-3.0-or-later** | Yes |
| **MIT** | Yes |
| **ISC / BSD-2-Clause / BSD-3-Clause** | Yes |
| **Apache-2.0** | Check with Marketplace review |
| **Closed source** (`LicenseRef-<name>`) | Only under a closed-source contract with Justflows, free or paid |

---

## Requirements for all plugins

Every plugin **must**:

1. Integrate via documented Justflows APIs (`@justflows/sdk`, hooks, plugin runtime)
2. Ship a valid `justflows.json` manifest with unique `id`, semver `version`, declared `permissions`
3. Declare a license in the manifest and `package.json`
4. Respect the permission system

Marketplace listings **must** also:

5. Use a **GPL-compatible** license, or a closed `LicenseRef-` license under contract
6. Provide source code to recipients as that license requires, and always to Justflows reviewers

Every plugin **must not**:

1. Modify, replace, or overwrite Justflows Core files
2. Circumvent update signing on official channels
3. Obfuscate Marketplace-listed source in a way that prevents license compliance

---

## Paid plugins (allowed)

| You can charge for | You cannot do on Marketplace |
|---|---|
| Download / license key | List a closed-source plugin without a contract |
| Updates and maintenance | Withhold source required by a GPL listing |
| Priority support | Misrepresent license obligations |
| Marketplace listing convenience | |

Example: sell a plugin for €99/year with updates and support — **if** the listing
is GPL-compatible and source is available to buyers.

---

## Distribution channels

### A. Justflows Marketplace (official)

| Requirement | Details |
|---|---|
| **License** | GPL-compatible, or closed (`LicenseRef-`) under a closed-source contract |
| **Approval** | Manual security review |
| **Signing** | Signed after approval |
| **Payments** | Paid listings use Justflows Payments |
| **Source** | Available to purchasers / as required by license |

See [07-marketplace.md](./07-marketplace.md).

### B. Private sideload (self-hosted)

Administrators may install plugins outside the marketplace:

- The plugin keeps the license declared in its manifest
- The installer still requires a **GPL-compatible** SPDX identifier; a closed
  `LicenseRef-` license installs only from the Marketplace, never as a sideload
- Administrator assumes responsibility for unsigned sideloads

### C. Bundled with the repo / local development

Develop plugins in `plugins/<your-plugin-name>/` (copy `plugins/hello-world/`).
Example plugins in this repo are **GPL-2.0-or-later**, separately from MIT core.


## Closed-source plugins (under contract)

A plugin may declare a closed license with an SPDX custom identifier,
`LicenseRef-<name>` (for example `LicenseRef-Acme-Commercial`), and ship that
license text as its `LICENSE` file.

- The registry accepts a closed license, on a free or paid listing, only when the
  publisher has a **closed-source contract** with Justflows and a verified identity,
  and for Justflows' own packages.
- Justflows reviewers always receive the full source. Closed source is never
  closed to review.
- Justflows installs a closed-license package **only** with a valid Marketplace
  signature. Uploads, pinned digests, and `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES` cannot
  install one.
- The Marketplace marks these listings **Closed source**.
- Other license words in the manifest ("Proprietary", "All rights reserved", and
  similar) are still rejected. Use the `LicenseRef-` form.

---

## Plugin manifest — license field

```json
{
  "schemaVersion": 1,
  "id": "acme.seo",
  "name": "Acme SEO",
  "version": "1.0.0",
  "publisher": "acme",
  "license": "GPL-2.0-or-later",
  "justflows": ">=1.0.0 <2.0.0",
  "permissions": ["content:read", "settings:read"]
}
```

---

## Revocation & enforcement

Justflows may refuse listing or delist plugins that:

- Use non-GPL-compatible licenses on the Marketplace without a closed-source contract
- Fail security review
- Violate marketplace terms
- Mislead users about licensing

---

## Related documents

- [02-sdk-and-public-api.md](./02-sdk-and-public-api.md)
- [05-blocks-and-patterns.md](./05-blocks-and-patterns.md)
- [07-marketplace.md](./07-marketplace.md)
