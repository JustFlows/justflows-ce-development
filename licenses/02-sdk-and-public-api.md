# 02 — SDK & Public API License

**Applies to:** `@justflows/sdk`, `@justflows/plugin-api`, and published public API documentation.

**License:** MIT License

**Full text:** [MIT.txt](./MIT.txt)

---

## Purpose

The SDK is the public boundary for extension developers. It is part of the
Justflows MIT core, not a copyleft license.

Plugins and themes that use the SDK **keep their own license**. Using hooks,
templates, or APIs does not relicense an extension as MIT, and it does not
force the extension onto GPL.

See:

- [03-plugins.md](./03-plugins.md)
- [04-themes.md](./04-themes.md)

---

## Extension licenses are independent

Justflows treats plugins and themes as **separately licensed packages**:

- They use Justflows hooks, actions, or filters
- They call documented SDK APIs
- They include Justflows template markup or theme functions
- They extend admin UI through the plugin runtime
- They register blocks, routes, jobs, or content types through Justflows APIs

That integration does **not** make the extension MIT. Authors declare a license
in the package manifest. The official Marketplace accepts **GPL-compatible**
SPDX identifiers, and a closed `LicenseRef-<name>` license only under a
closed-source contract with Justflows.

---

## Licenses accepted for Marketplace distribution

Acceptable for plugins and themes listed on the official Marketplace (non-exhaustive):

| License | Marketplace? |
|---|---|
| **GPL-2.0-or-later** | Yes (common for extensions) |
| **GPL-3.0-or-later** | Yes |
| **MIT** | Yes |
| **ISC / BSD-2-Clause / BSD-3-Clause** | Yes |
| **Closed** (`LicenseRef-<name>`) | Only under a closed-source contract with Justflows, free or paid |

When in doubt for a Marketplace listing, use **GPL-2.0-or-later** or **MIT**.

---

## Public vs internal APIs

**Public (extension contract):**

- `@justflows/sdk` exports
- Documented hooks and filters
- Theme manifest and template APIs
- Documented REST endpoints for extension use

**Internal (not extension contract):**

- Undocumented internals in `@justflows/core`, `@justflows/database`, etc.
- Private runtime modules subject to change without notice

Extension developers should use the public SDK only.

---

## Compatibility declaration

Extensions should declare compatibility in manifest:

```json
"justflows": ">=1.0.0 <2.0.0"
```

And declare **their own** license:

```json
"license": "GPL-2.0-or-later"
```

---

## Related documents

- [03-plugins.md](./03-plugins.md)
- [04-themes.md](./04-themes.md)
- [07-marketplace.md](./07-marketplace.md)
