# Extension review requirements

An extension must meet these requirements to be listed in the Marketplace. Extensions
run as trusted server code, so a listing, a signature, or a passing check is **not a
guarantee of safety**. See [extension trust](EXTENSION-TRUST.md).

## Automated checks

The registry's quality check runs these on every submission. A failure blocks the
listing. Authors can run the [extension checker](EXTENSION-CHECKER.md) themselves
with `justflows check`, locally or in CI; its rules are the automated baseline for
review.

| Requirement            | Checked by                                            |
| ---------------------- | ----------------------------------------------------- |
| Valid manifest         | Schema validation of required fields, id, and version |
| Known permissions      | Declared permissions must exist in the SDK            |
| Consistent permissions | Features that need a permission must declare it       |
| Accepted license       | GPL-compatible, or closed `LicenseRef-` (signed only) |
| Valid listing          | Free and paid listing rules                           |
| Installable package    | Package layout and archive checks                     |

## Human review

A reviewer checks what automation cannot:

- **Least privilege:** each permission has a clear purpose in the extension.
- **Honest behavior:** the listing describes what the code does, including any data
  sent to third parties.
- **Readable code:** no obfuscated code or hidden remote code loading.
- **No SDK bypass:** no use of Node.js APIs to reach secrets, other tenants' data, or
  files outside the extension's own scope.
- **Tenant safety:** handlers enforce site ownership on their own data.
- **Safe output:** user input is validated, and output uses the SDK sanitizers.
- **Secrets:** no credentials in the package, and none written to logs.
- **Disclosure:** the publisher has a working security contact.

## Updates

An update that adds permissions is reviewed again, and installed sites need an
administrator's approval. See [permissions](PERMISSIONS.md#permission-changes-on-update).

## After listing

If a problem is found, the publisher gets a chance to fix it privately. Versions can
be withdrawn through the [advisory feed](SECURITY-ADVISORIES.md). Withdrawing a version
warns operators. It does not remove anything from their sites.
