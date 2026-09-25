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

The full enum is `PluginPermissionSchema` in `packages/sdk/src/plugin.ts`:
content/media/users/settings CRUD, `admin:extend`, `jobs:register`,
`diagnostics:publish`,
`auth:hook`, `network:outbound`, `mail:send`, `mail:transport`, `mail:templates`.

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

1. capabilities from the selected built-in or custom role;
2. optional per-user grants;
3. explicit per-user denies (a deny always wins);
4. resource scopes for site, content type, locale, and ownership.

Use `requireCapability()` at HTTP boundaries and `userCan()` where the resource
is loaded inside a handler. Pass the resource's `siteId`, `contentType`,
`locale`, and `ownerId` so scoped grants are enforceable server-side. Hiding a
button in Admin is only a convenience.

Plugin HTTP handlers receive `session.capabilities` and `session.scopes` as a
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
