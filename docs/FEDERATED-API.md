# Federated management API

Justflows can be operated headlessly over HTTP — as the content and workflow
backend for a separate application, a CI pipeline, a CLI, or another service.
The **federated management API** is one versioned surface, `/api/manage/v1`,
that covers the same operations the administration UI performs, authenticated by
revocable **API keys** whose capabilities and scope the operator chooses per
key. "Federated" means one unified, discoverable surface over every internal
feature — not cross-install federation.

This is separate from:

- `/api/v1` — the read-only [public content API](../README.md) for headless
  frontends, gated by the Admin → Settings → Public API switch.
- `/api/*` — the session-cookie API the admin SPA drives (CSRF-guarded, browser
  only).

## Enabling it

The whole surface is **off by default**. Turn it on at **Admin → Settings →
API** with the master switch. That page hosts both HTTP-API switches — the
read-only public-content API (`/api/v1`) and this management API — as separate
controls. Toggling either takes effect immediately, no restart. While the
management switch is off, every key-authenticated request is refused regardless
of the key.

## API keys

Create, name, list, rotate and revoke keys at **Admin → Settings → API**.

- The secret is shown **once**, at creation or rotation. Only a SHA-256 hash is
  stored. The token carries a visible prefix (`jfk_…`) so it stays identifiable
  in logs and lists.
- Each key has: an owner, an explicit **capability set** (never broader than the
  creating administrator's own capabilities at creation time), optional
  **scope** (content type, locale, ownership), optional **expiry**, and optional
  **allowed-IP / allowed-origin** lists.
- Keys record `created`, `last used`, `expires` and a request counter.
- Revocation and expiry take effect **immediately**, without a restart.
- Every create / rotate / revoke and every authentication failure is written to
  the audit log with the key id — never the secret.

### Authentication

Present the key as a bearer token:

```
Authorization: Bearer jfk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A key-authenticated request resolves to a synthetic session whose capabilities
are the key's, never the owner's full role. **On every request** the effective
set is re-computed as `key capabilities ∩ the owner's current capabilities`, and
scope is enforced on every read and write — so revoking the owner's access, or
narrowing their role, also neuters their keys. Failed authentication returns a
generic `401` / `403` and never reveals whether a key exists, is expired, or is
out of scope.

CSRF is **not** required for key-authenticated requests (there is no ambient
credential). Cookie auth on these routes still requires it.

## The surface

| Area | Routes | Capability |
| --- | --- | --- |
| Content | `GET/POST /content`, `GET/PATCH/DELETE /content/{id}`, `POST /content/{id}/publish` · `/unpublish`, `PUT /content/{id}/schedule`, `GET /content/{id}/revisions[/{revisionId}]` | `content:read` / `create` / `update` / `publish` / `delete` / `revisions:read` |
| Media | `GET /media`, `GET /media/{id}`, `POST /media` (multipart, field `file`), `DELETE /media/{id}` | `media:read` / `upload` / `delete` |
| Comments | `GET /comments`, `PATCH /comments` (bulk), `PATCH /comments/{id}`, `POST /comments/{id}/reply`, `DELETE /comments` | `comments:moderate` |
| Menus | `GET/POST /menus`, `GET/PUT/DELETE /menus/{slug}` | `content:read` / `settings:manage` |
| Content types | `GET/POST /content-types`, `GET/PATCH/DELETE /content-types/{slug}` | `content:read` / `settings:manage` |
| Users & roles | `GET/POST /users`, `GET/PATCH/DELETE /users/{id}`, `GET/POST /roles`, `PATCH/DELETE /roles/{id}` | `users:read` / `users:manage` |
| Settings | `GET/PATCH /settings` | `settings:read` / `settings:manage` |
| Languages | `GET/POST /languages`, `PATCH/DELETE /languages/{id}` | `settings:read` / `settings:manage` |
| Redirects | `GET/POST /redirects`, `PUT /redirects/{id}` | `settings:read` / `settings:manage` |
| Plugins | `GET /plugins`, `POST /plugins/{id}/activate` · `/deactivate` | `plugins:read` / `plugins:activate` |
| Themes | `GET /themes`, `POST /themes/{id}/activate` | `themes:read` / `themes:activate` |
| Cache | `GET /cache/stats`, `POST /cache/clear` | `settings:read` / `settings:manage` |
| Static export | `GET /static-export`, `POST /static-export/run` · `/clear` | `settings:read` / `settings:manage` |
| Diagnostics / health | `GET /diagnostics`, `GET /health` | `site:admin` / (any key) |

Each operation reuses the existing service layer and the same capability check
as its cookie-authenticated counterpart — no parallel business logic, no
capability bypass.

### Envelope

- **List** responses are `{ data: [...], page: { limit, cursor, nextCursor,
  total } }`. Pass `?limit=` and `?cursor=` (opaque, from `nextCursor`).
- **Errors** are `{ "error": "..." }`.
- Rate-limited requests return `429` with `Retry-After`.
- GETs return an `ETag`; send `If-None-Match` for a conditional `304`.
- Write methods are reachable only by key auth and same-origin cookie sessions —
  never through wildcard CORS. Authenticated routes echo only explicitly allowed
  origins (per-key `allowedOrigins` plus the global list) and never combine `*`
  with credentials.

### Rate limits

Every key-authenticated route is limited per key **and** per IP. The ceiling is
the key's own `rateLimitPerMin` when set, otherwise the global
`manage_api_rate_limit` (default 120/min). Filesystem-touching routes (media
upload, plugin/theme activation, static export) carry an additional limiter.

## Events and webhooks

- `GET /api/manage/v1/events` — the event catalog, with payload schemas. These
  are the same names a webhook endpoint subscribes to; every delivery is the
  envelope `{ id, event, createdAt, data }`.
- A key with `settings:manage` manages **its own** webhook endpoints:
  `GET/POST /webhooks`, `PUT/DELETE /webhooks/{id}`,
  `POST /webhooks/{id}/rotate-secret`. Rows a key registers are tagged with the
  key id; it can neither see nor change endpoints created by another key or by
  an administrator. See [Webhooks](WEBHOOKS.md) for signing and retries.

**In-process hooks (actions / gates / filters) are not exposed over HTTP** —
that stays a plugin concern. HTTP integrations *observe* via webhook events and
*act* via this API.

## Discoverability

`GET /api/manage/v1/openapi.json` is the OpenAPI 3.1 document for the whole
authenticated surface. It declares the `bearerAuth` scheme and notes the
capability each operation requires (`x-required-capability`). Plugins that
register routes extend it through the `openapi.document` filter, exactly as for
`/api/v1`.

## Publishing schedules

`PUT /content/{id}/schedule` requires both scoped `content:publish` and
`content:update`. Send nullable ISO-offset `publishOn` and `unpublishOn` dates
plus the current `expectedVersion`; both dates `null` cancel the schedule.
Content responses expose those dates, and `status=scheduled` listing includes
live entries with scheduled revisions or expiry. See
[Scheduled publishing](SCHEDULING.md#http-contract) for validation and examples.
