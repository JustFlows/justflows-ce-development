# Permissions and capabilities

Two different lists.

## Plugin permissions (manifest)

Declared on the plugin. Core uses them to decide which APIs `PluginContext`
exposes. Sensitive permissions are called out in Admin:

- `network:outbound`
- `users:manage`
- `settings:manage`
- `mail:send` — send through the host-configured outbound email transport
- `mail:transport` — register an outbound email provider transport
- `mail:templates` — register namespaced system-email definitions and preview fixtures
- `auth:hook`
- `files:private` — store and serve private files with `ctx.files`

The full enum is `PluginPermissionSchema` in `packages/sdk/src/plugin.ts`:
content/media/users/settings CRUD, `admin:extend`, `jobs:register`,
`diagnostics:publish`,
`auth:hook`, `network:outbound`, `mail:send`, `mail:transport`, `mail:templates`,
`files:private`.

`content:create` is required for `ctx.content.ensureType` and `ensurePage`.
Publishing a page also requires `content:publish`. Deleting a type and its
entries (`ctx.content.deleteType`) requires `content:delete`.

Core content deletion is recoverable: `content:delete` moves an entry to the
site trash. Administrators and editors can restore trashed resources;
administrator role checks protect permanent deletion and empty-trash actions.
See [Trash and retention](TRASH.md).

UI gating is not a security boundary. Server routes still check the signed-in
user.

## User capabilities (roles)

`mail:read` allows inspection of privacy-masked delivery records. `mail:manage`
allows retrying deliveries and managing suppressions. `email-templates:read`
allows inspecting the system-email design, templates, and previews under
**Admin → Emails**; `email-templates:manage` allows saving, publishing,
restoring, and test-sending them. The template pair is deliberately separate
from the delivery-log pair so an administrator can grant template editing to a
user through **Admin → Users → Individual access** (or a custom role) without
also exposing the mail log. These are user capabilities, not plugin manifest
permissions.

Administrators, editors, authors, and so on get capabilities from
`packages/sdk/src/capabilities.ts`. Check capabilities in server code; do not
hard-code role names.

Sites may also create custom roles through Admin → Users. A user's effective
access is resolved in this order:

1. capabilities from the selected built-in or custom role, plus those of any
   additional roles;
2. optional per-user grants;
3. explicit per-user denies (a deny always wins);
4. resource scopes for site, content type, locale, and ownership.

### Additional roles

A user has one primary role (`users.role`) and can hold additional built-in or
plugin roles next to it. For example, a subscriber can also be a Shop
`customer`. Set them under **Admin → Users → (user) → Additional roles**, or
with `additionalRoles` on `PATCH /api/users/:id`. They are stored in
`user_additional_roles`.

- Additional roles only add capabilities. `requireRole()`, `session.role`, and
  the last-administrator guard read the primary role only.
- `administrator` can only be a primary role. Custom roles cannot be
  additional roles, because a custom role replaces the whole access policy.
- Author and contributor stay limited to their own content whether they are
  primary or additional. The limit lifts only when another held role, such as
  editor, grants the same capability without it.

Use `requireCapability()` at HTTP boundaries and `userCan()` where the resource
is loaded inside a handler. Pass the resource's `siteId`, `contentType`,
`locale`, and `ownerId` so scoped grants are enforceable server-side. Hiding a
button in Admin is only a convenience.

Plugin HTTP handlers receive `session.roles` (primary first),
`session.capabilities`, and `session.scopes` as a
read-only preview of the host-resolved policy. Plugins must still declare their
own manifest permissions; user access never expands a plugin's sandbox.

## Plugin-defined user capabilities

Core contains only platform capabilities. A plugin registers its own domains
while activating; inactive or uninstalled plugins therefore do not leave
irrelevant choices in the role editor:

```ts
async activate(ctx) {
  ctx.capabilities.register({
    id: "orders:refund",
    label: "Refund orders",
    group: "Orders",
    description: "Issue full or partial refunds",
    defaultRoles: ["administrator"],
  });
}
```

Identifiers use lower-case `domain:action` syntax. A plugin cannot replace a
core capability or another plugin's registration. Registrations are removed
automatically on deactivation. Stored custom roles keep their raw identifiers,
but an inactive capability is neither shown as assignable nor included in
effective access until its owning plugin registers it again.

A plugin that contributes an admin page still runs in the signed-in user's
session. An author without `plugins:install` cannot upload packages even if a
plugin UI looks like it could.

## Plugin-defined user roles

A plugin can add a role while it is active. The id is stored on `users.role`
and shows up in New User Default Role, invites, and the user editor. Shop
registers `customer` (no administration capabilities) on activation.
Deactivation removes the role from those lists; accounts that already have it
keep the stored id and lose the plugin's capabilities until it is active again.

```ts
async activate(ctx) {
  ctx.roles.register({
    id: "customer",
    label: "Customer",
    description: "Registered shop customer. No administration access.",
    capabilities: [],
  });
}
```

The id is 2–32 lowercase letters, digits, and hyphens. A plugin cannot replace
a core role (`subscriber`, `contributor`, `author`, `editor`, `administrator`)
or another plugin's registration.

`ctx.users.create` needs the `users:manage` manifest permission. It can only
assign a role that same plugin registered, so Shop can create a `customer`
and cannot create an administrator. The host still enforces password policy,
uniqueness, and the audit log. The `actor` is the signed-in staff member; for
an account a visitor creates for themselves (Shop checkout) it has an empty
`userId`, and the audit log records no actor.

`ctx.users.addRole(target, role, actor)` gives an existing user, found by
`{ userId }` or `{ email }`, one of the plugin's own roles as an additional
role. Their primary role and sign-in stay as they are. It needs the same
`users:manage` permission and the same ownership rule. It succeeds without a
change when the user already holds the role, and returns status 404 when there
is no such user. Shop uses it when a customer is added under an email that
already signs in, and when a signed-in user places their first order. The
method is optional on the SDK type, so check `ctx.users.addRole` before calling
it on older hosts.

`ctx.users.removeRole(target, role, actor)` takes one of the plugin's own
additional roles away again, with the same permission and ownership rule. The
primary role is never changed, and a user who does not hold the role is a
success. The user loses the role's capabilities on their next request. Shop
uses it when a membership subscription ends. Optional on older hosts.

`ctx.users.get(userId)` returns one user with all their roles (`roles`, main
role first), or `null`. It needs `users:manage` and is optional on older
hosts. Call it from a `user.created` or `user.updated` action to react to
role changes. Shop uses it to create a customer record for anyone who gains
the `customer` role, including a role ticked under Admin → Users.
