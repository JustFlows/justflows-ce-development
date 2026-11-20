# Justflows Licensing

Justflows Community Edition uses a **permissive core with separately licensed extensions**:

- **Core:** MIT License
- **Plugins & themes** declare their own license (bundled examples use GPL-2.0-or-later). They are not MIT just because they ship next to core
- **Marketplace:** curated directory with security review (GPL-compatible extensions; closed-source plugins and themes, free or paid, only under a contract)
- **Enterprise modules** (optional, separate): commercial license

**Version:** 4.1  
**Effective date:** 2026-11-20  
**Copyright holder:** Justflows Contributors

---

## Quick reference

| Component | License | Closed source when distributed? |
|---|---|---|
| **Core** (`packages/*`, `apps/server`) | [MIT](licenses/MIT.txt) | Allowed (preserve MIT notice) |
| **SDK** (`@justflows/sdk`) | MIT | Allowed (preserve MIT notice) |
| **Plugins** (hooks, admin UI, API integration) | [Own license](licenses/03-plugins.md) | Marketplace: **No** |
| **Themes** (templates, patterns, styles) | [Own license](licenses/04-themes.md) | Marketplace: **No** |
| **Blocks & patterns** | Same as parent component | Same as parent |
| **Enterprise modules** (optional) | [Commercial](licenses/06-enterprise-license.md) | Yes (separate product) |
| **Marketplace listings** | GPL-compatible, or closed (`LicenseRef-`) under a closed-source contract | Only under a contract |

---

## Why MIT for core

1. **Easy to adopt** — host, embed, fork, and ship Justflows without copyleft on the platform itself
2. **Separate extension licenses** — plugins and themes keep the license their authors choose
3. **Contributions stay simple** — core contributions are MIT
4. **Proven model** — permissive core plus independently licensed extensions is common for modern platforms

---

## What you can do

| Action | Allowed? |
|---|---|
| Self-host for free | Yes |
| Modify core for your own use | Yes |
| Distribute modified core | Yes — **preserve the MIT copyright notice** |
| Sell hosting / support / services | Yes |
| Sell plugins/themes | Yes — under **their own license**. Official Marketplace listings are **GPL-compatible**, or closed under a closed-source contract |
| Charge for plugins | Yes (charge for access, updates, support) |
| Keep modifications private (never distribute) | Yes |

---

## What you cannot do

| Action | Allowed? |
|---|---|
| Remove copyright / license notices from core | **No** |
| List closed-source plugins/themes on the official Marketplace without a contract | **No** |
| Use Justflows trademark to imply your fork is official | **No** |

---

## Paid plugins

You **can** charge money for plugins and themes. Plugins and themes are **not** MIT by default.

- Each extension declares its own license in its manifest
- Official Marketplace listings use a **GPL-compatible** license (source available to recipients), or a closed `LicenseRef-` license under a closed-source contract (plugins and themes, free or paid)
- You charge for **download access**, **updates**, **support**, or **Marketplace convenience**
- Recipients of a GPL-licensed extension keep the rights of that GPL license

See [licenses/03-plugins.md](licenses/03-plugins.md) and [licenses/07-marketplace.md](licenses/07-marketplace.md).

---

## Enterprise Edition (optional)

Enterprise-only features shipped **outside** the MIT core repository may use a
separate commercial license. They must not be required to run basic Community Edition.

See [licenses/06-enterprise-license.md](licenses/06-enterprise-license.md).

---

## Document index

| File | Purpose |
|---|---|
| [LICENSE](LICENSE) | Root MIT license |
| [licenses/MIT.txt](licenses/MIT.txt) | Full MIT text |
| [licenses/GPL-2.0.txt](licenses/GPL-2.0.txt) | GNU GPL v2 text (used by some plugins/themes) |
| [licenses/01-core.md](licenses/01-core.md) | Core scope and MIT obligations |
| [licenses/02-sdk-and-public-api.md](licenses/02-sdk-and-public-api.md) | SDK under MIT |
| [licenses/03-plugins.md](licenses/03-plugins.md) | Plugin license policy |
| [licenses/04-themes.md](licenses/04-themes.md) | Theme license policy |
| [licenses/05-blocks-and-patterns.md](licenses/05-blocks-and-patterns.md) | Blocks and patterns |
| [licenses/06-enterprise-license.md](licenses/06-enterprise-license.md) | Optional enterprise commercial license |
| [licenses/07-marketplace.md](licenses/07-marketplace.md) | Marketplace developer agreement |
| [licenses/08-trademark-support-warranty.md](licenses/08-trademark-support-warranty.md) | Trademark, support, warranty |
| [licenses/09-terms-and-conditions.md](licenses/09-terms-and-conditions.md) | Services terms (English authoritative) |

---

## Legal disclaimer

This is a policy template, not legal advice. Consult qualified counsel before release.
