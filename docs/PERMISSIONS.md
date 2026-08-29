# Permissions and capabilities

Two different lists.

## Plugin permissions (manifest)

Declared on the plugin. Core uses them to decide which APIs `PluginContext`
exposes. Sensitive permissions are called out in Admin:

- `network:outbound`
- `users:manage`
- `settings:manage`
- `auth:hook`

The full enum is `PluginPermissionSchema` in `packages/sdk/src/plugin.ts`:
content/media/users/settings CRUD, `admin:extend`, `jobs:register`,
`auth:hook`, `network:outbound`.

`content:create` is required for `ctx.content.ensureType` and `ensurePage`.
Publishing a page also requires `content:publish`. Deleting a type and its
entries (`ctx.content.deleteType`) requires `content:delete`.

UI gating is not a security boundary. Server routes still check the signed-in
user.

## User capabilities (roles)

Administrators, editors, authors, and so on get capabilities from
`packages/sdk/src/capabilities.ts`. Check capabilities in server code; do not
hard-code role names.

A plugin that contributes an admin page still runs in the signed-in user's
session. An author without `plugins:install` cannot upload packages even if a
plugin UI looks like it could.
