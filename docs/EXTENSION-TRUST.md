# Extension trust

Plugins, themes, and CSS providers run in the same Node.js process as the site.
They are trusted server code. Justflows does not sandbox them.

Installing an extension gives its publisher the same level of access as shell
access to the application account. Decide whether you trust the publisher before
you install, and limit who holds the administrator role.

## What the SDK constrains

Manifest permissions and the SDK define what well-behaved extensions may do.

- `ctx` APIs check the permissions declared in the extension's manifest. See
  [permissions](PERMISSIONS.md).
- The host checks site activation, user capabilities, and explicit site selectors
  before it calls a plugin's API handlers.
- User access never expands what a plugin's manifest allows.

These checks are a contract for extensions that use the SDK. They are not a
security boundary against an extension that chooses to ignore it.

## What same-process code can still reach

Code running in the server process can bypass the SDK. It can use any Node.js API
and reach whatever the application account can, including:

- environment variables, such as `APP_SECRET` and database credentials;
- files the application account can read or write;
- the database, with the application's privileges and across tenants that share
  it;
- outbound network connections;
- the memory of the running process, including other extensions and core.

The host also cannot tell whether an opaque resource ID in a plugin's own
database belongs to another site. Plugin handlers must enforce site ownership
themselves.

## What signatures and integrity checks prove

| Check             | Proves                                                          | Does not prove                                          |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Package signature | The package came through the marketplace signing key unchanged  | The code is safe or free of vulnerabilities             |
| Pinned digest     | The package matches the digest the operator chose to trust      | Anything about the code's behavior                      |
| File integrity    | Installed files still match the baseline from a trusted install | The original package was harmless, or the host is clean |

An installation with no baseline is unverified, which is not the same as passing.
Do not describe a signature, an integrity pass, or a quality check as a guarantee
of safety.

## Decision: untrusted extensions are not supported

**Status:** Accepted. This records current behavior.

**Context:** Multi-tenant and self-hosted operators may want to run extensions
from publishers they do not fully trust. Justflows loads extensions into the
server process, so permissions and signatures cannot contain them.

**Decision:** Justflows CE restricts extension installation to trusted operators
and trusted code. It does not offer or advertise a sandbox.

**Consequences:**

- Installing a package or core update stays an administrator-only action, and
  operators should treat it as equal to shell access.
- Signature enforcement stays on by default. Do not set
  `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1` on a public host.
- Do not let tenants upload their own server-side extensions on a shared
  installation.
- Running untrusted code would need a separate project with enforceable operating
  system or process boundaries, and demonstrated isolation before it could be
  described as a sandbox.

If you suspect a compromised extension, follow
[incident response](INCIDENT-RESPONSE.md).

## Plugin trust states

**Status:** the first part of a planned plugin sandbox
([#270](https://github.com/JustFlows/justflows-ce/issues/270)). Trust states
are recorded and shown today, but **every plugin still runs in the server
process with full access**, whatever its state. The decision above still
applies until the sandbox ships and passes its isolation tests. Nothing here is
a sandbox.

Every installed plugin has one of four states, shown on **Plugins** and counted
in the Security Center (**Plugin verification**). Until this installation has
received an attestation list from Justflows, nothing can be verified, so both
places hide the states. They appear by themselves once a list arrives, or
straight away with `JF_PLUGIN_SANDBOX=on`, where the states decide how plugins
run. An expired list still shows, because a stale list is worth knowing about.

| State | Meaning |
| --- | --- |
| Verified by Justflows | This exact release passed the [extension review](EXTENSION-REVIEW.md). Justflows lists its package id, version and archive digest in a signed attestation feed. |
| Trusted by you | An administrator trusted this installation's exact build. |
| Legacy trust | Installed before trust states existed and unchanged since. It keeps running as before until the grace deadline. |
| Unverified | Everything else, including every new install and update without an attestation, and plugins installed from source. |

The rules:

- **Verified binds one archive digest.** It comes from the attestation feed at
  `api.justflows.com`, signed with a release key and domain-separated from
  release and advisory signatures. It is never read from the manifest or
  anything else the publisher controls. An update has a new digest, so it starts
  unverified until its own attestation appears. The digest is the one recorded
  in the file integrity baseline at install.
- **It fails closed.** The feed is verified again on every read. A missing,
  tampered or expired feed verifies nothing, and an older feed never replaces a
  newer one. The feed is refreshed every six hours.
- **Revocation wins.** A release the signed advisory feed marks as revoked is
  unverified, even if it is attested or trusted by you.
- **Verified is not a guarantee of safety.** It means the release passed the
  review requirements.
- **Trusted by you** is for code you wrote or checked yourself. It is available
  only on a single self-hosted site: never with `JF_MULTISITE=true`, and never
  with `JF_OPERATOR_TRUST=off`. Only an administrator on the main site can set
  it, with their current password. It binds the installed digest, so an update
  is not trusted.
- **Legacy trust** starts the first time a release with trust states runs.
  Plugins installed before that keep it for 90 days. Any install, update or
  reinstall after that is a new package and does not get it. Justflows will
  issue attestations for its own plugins, so they become verified rather than
  legacy.

Every state change is audited as `extension.trust_changed`, and operator trust
as `extension.operator_trusted` and `extension.operator_untrusted`.

With `JF_PLUGIN_SANDBOX=on`, unverified plugins run their server code in the
experimental [plugin sandbox](PLUGIN-SANDBOX.md), and verified releases and
builds you trusted run outside it as plugins do today. The sandbox does not yet
cover admin apps or what a plugin adds to public pages, so it is off by default
and the decision above still applies.

## Update trust policy

Marketplace installs and updates fail closed. Justflows downloads packages only
through the configured Marketplace API, bounds the request and archive size, and
requires the archive digest to match a signature from a Marketplace key trusted
by this core release. A missing, unreachable, or invalid trust service never
falls back to an unsigned update. Operators can explicitly pin a package digest;
the development-only `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1` escape hatch is not a
production trust policy.

Marketplace signing keys rotate through a core release. During a planned
rotation, a release can trust both the retiring and replacement public keys;
after publishers and operators have upgraded, a later release removes the old
key. An emergency revocation removes the affected key from a security release.
Already installed code remains subject to the signed advisory feed and file
integrity checks, because removing a key cannot prove that existing files are
safe.

### Marketplace signing keys

Trusted keys are listed in `MARKETPLACE_KEYS`
(`apps/server/src/lib/extensions/package-trust.ts`). A key is Ed25519 or ECDSA
P-256 (ES256, as signed by a KMS), and may be limited to package types with
`types`: the plugin registry's key vouches for `plugin` and `css-provider`
packages only, the theme registry's for `theme` only. A key without `types`
vouches for every type; only the original Ed25519 key does, and it is retiring.

The signed message is `id \n version \n publisher \n digest`, so a signature
covers the package, its version, its publisher, and the exact archive.

Since #274 the registries hold no signing key. A separate signing service signs
a release only when an approver recorded an approval for that exact release
there, so a compromised registry cannot produce a valid signature. The keys
live in OVHcloud KMS and cannot be exported. Rotation and emergency revocation
runbooks are in the signing service's README.

The update action accepts only a SemVer version newer than the installed one.
Reinstalling the same version or downgrading through the update API is refused.
Recovery from a withdrawn or broken release uses a deliberate trusted reinstall
or backup restore, with the administrator choosing the exact signed package or
pinned digest; it is not an automatic downgrade. Automatic updates also stop at
a major-version boundary and wait for a person when a plugin adds permissions.
