# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public GitHub issue.

Email **security@justflows.com** with:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected version / commit if you know it

You should receive an acknowledgement within a few days. Please give us a reasonable window to investigate and ship a fix before any public disclosure.

## Trust boundary

Justflows runs uploaded plugins, themes, CSS providers, and core-update archives **in the same Node.js process** as the site. An administrator who can upload a `.jfpkg` or core `.zip` can execute arbitrary code on the server. Treat those admin actions as equivalent to shell access.

This is by design for a self-hosted CMS. Production sites should restrict who is an administrator.

Since 0.1.2, package authenticity is checked by default: a `.jfpkg` is refused unless
it carries a valid marketplace signature or its SHA-256 digest is pinned in
`JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS`. Setting `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1`
opts out and restores the pre-0.1.2 behaviour; do not set it on a public host.

Core update archives are verified by default too. Every official release ships
`justflows.zip.sig`, an Ed25519 signature over the archive's SHA-256 digest and
its version, made with a Justflows core release key whose public half is pinned
in the core. It is a separate key from the marketplace one. The Update button,
automatic updates, and uploads all refuse an archive without a valid signature.
To apply your own build, pin its digest in `JUSTFLOWS_UPDATE_DIGEST` or sign it
with `JUSTFLOWS_UPDATE_SIGNING_KEY` (HMAC-SHA256).
`JUSTFLOWS_ALLOW_UNSIGNED_CORE_UPDATES=1` turns the check off; do not set it on
a public host.

## Production hardening

Required:

- Set `APP_SECRET` to a unique value of at least 32 characters. Documented example values are rejected in production.
- Do not commit `.env` files, credentials, or private keys.
- Do not expose database ports to the public internet.

Package and core update signature enforcement needs no configuration — it is the default. Pin your
own builds with `JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS=<package-id>:<sha256>` rather
than turning enforcement off.

See `.env.example` and `.env.production.example` for the full list.

Also:

- Keep the site behind HTTPS and a reverse proxy, and set `TRUST_PROXY` to match
  your setup — the default (`loopback`) is right for nginx or Passenger on the
  same host. Getting this wrong makes per-IP rate limiting either useless or
  spoofable.
- Do not serve `/uploads/`, `storage/`, update backups, or rollback data as
  static files. Admin → Security → Web server shows the file for each host.
  The application refreshes the site-root `.htaccess` and does not rewrite
  nginx, a reverse proxy, Passenger, or Docker. See
  [docs/MEDIA.md](docs/MEDIA.md#storage-and-cdn).
- Package and core-update archives are parsed with a time limit. A malformed
  TAR or ZIP is rejected, and extracted files are copied into the live tree
  only after the signature or digest check has passed.
- After a trusted install, Justflows stores a per-file baseline outside the
  package directory. A plugin that no longer matches is not loaded. Reinstall
  from a trusted package to restore it. There is no control that adopts the
  current files as a new baseline. When the release key is set,
  `scripts/make-zip.sh` writes `core-integrity.json` into the archive before
  it signs the zip, so an update can check the core files it just copied.
  Uploads, storage, secrets, themes, plugins, and installed extensions are
  not part of that manifest. An installation with no manifest is unverified,
  not a failed release. Check a tree with
  `node scripts/verify-core-integrity.mjs`.
- Leave `DB_SSL` alone unless you have a reason: database TLS is on by default
  for any non-localhost `DB_HOST`.
- Complete first-run setup using the setup key from `install-token/TOKEN.txt`
  (also printed to the server log). Both points where an anonymous visitor could
  otherwise act ask for it: the browser first-run page, before it downloads
  dependencies and builds, and the install wizard's admin-account step. Requests
  from localhost are exempt from both. Open the file with the same FTP client or
  File Manager you used to upload Justflows. The folder ships an Apache deny rule
  and Node never serves it, but if your host puts the application root behind a
  web server you do not control, confirm the folder is not reachable over HTTP.
  It is deleted automatically once setup completes, along with the build log.
- Turn on two-factor authentication (Admin → Security → Your account). Given the
  trust boundary above, an administrator password is a server credential; TOTP
  is the cheapest thing standing between a reused password and shell access.
  Recovery codes are shown once at enrolment — store them somewhere reachable
  without the phone.
- Review Admin → Security → Audit log after any incident, and set
  `JF_AUDIT_RETENTION_DAYS` to match your retention policy. It records sign-ins,
  privilege changes, and everything that installs or replaces code — including
  every password-reset request, completion, and failure.
- Move the admin off `/admin` (Admin → Security → Admin URL). Staff then sign
  in, request a reset and reset their password only under that path; the
  site's own `/login`, `/forgot-password` and `/reset-password` are for
  members, and answer a staff account exactly as they answer an unknown one.
  The API enforces this, not just the pages. If you lose the address, set
  `JF_ADMIN_PATH_RECOVERY=/admin` in `.env` and restart. See
  [docs/AUTH.md](docs/AUTH.md).
- Self-service password reset (the "Forgot password?" link) needs working
  outgoing mail. Links are single-use, expire (`JF_PASSWORD_RESET_TTL_MINUTES`,
  default 60), are stored only as hashes, and revoke every session on use;
  a second factor is still required afterwards. A staff link only works on the
  admin's reset page and a member link only on the site's. Turn it off or limit
  it to chosen roles under Admin → Settings. With no mail configured, recover from a
  shell with `justflows user reset-password --email you@example.com` (run from
  the install directory) — it reads the server's `.env` and has no network
  surface.
- Limit the administrator role to people you trust with the server.
- Leave the public REST API off unless you need it (Admin → Settings).

## Data protection

Justflows stores personal data in four places: user accounts, comment authors,
form submissions, and the audit log's IP addresses.

- **Subject access (GDPR Art. 15)** — `GET /api/users/:id/personal-data`
  returns everything held about one account as JSON. Generated on request; no
  copy is written to disk.
- **Erasure (GDPR Art. 17)** — `POST /api/users/:id/erase` anonymises comments,
  deletes that person's form submissions, and strips the address and user agent
  from their audit entries. Content is reassigned rather than deleted: erasure
  is a right over personal data, not a right to remove a site's articles.
- **Retention** — `JF_AUDIT_RETENTION_DAYS` (default 365) bounds the audit log.
  `JF_SUBMISSION_RETENTION_DAYS` bounds form submissions and is off by default,
  because a retention period is the operator's decision to make.

Justflows does not decide whether a request must be honoured, or what a lawful
retention period is. It provides the mechanism; the operator is the controller.
