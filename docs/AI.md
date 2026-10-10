# Bring your own AI

Justflows does not sell AI, host models, or bill for tokens. You bring your own,
in one of two ways:

1. **Connect your agent.** Justflows runs an [MCP](https://modelcontextprotocol.io)
   server. Claude (claude.ai, Claude Desktop, Claude Code), ChatGPT, Cursor,
   VS Code and other MCP clients can then work on your site with the
   permissions you give them, on your own subscription.
2. **Bring your own key (BYOK).** Add an Anthropic, OpenAI, or
   OpenAI-compatible API key. It powers an assistant inside the admin.

> A consumer subscription (Claude Pro/Max, ChatGPT Plus/Pro, Cursor) is not an
> API key. Those plans connect through path 1. Path 2 needs a provider API key.

## Contents

- [Connect an AI agent (MCP)](#connect-an-ai-agent-mcp)
- [Client setup](#client-setup)
- [Tools](#tools)
- [Resources and prompts](#resources-and-prompts)
- [The admin assistant (BYOK)](#the-admin-assistant-byok)
- [Settings and capabilities](#settings-and-capabilities)
- [Security model](#security-model)
- [For plugin authors](#for-plugin-authors)

## Connect an AI agent (MCP)

1. **Admin → Settings → API.** Turn on the management API, then **Let AI
   agents connect over MCP**. Both switches apply immediately.
2. Copy the **MCP server URL**: `https://your-site.example/api/mcp`.
3. Pick your app under **Connect an AI agent** and follow its instructions.

The endpoint uses the Streamable HTTP transport in stateless mode, built on
the official TypeScript SDK (`@modelcontextprotocol/sdk`). Every request
carries its own credential, so a revoked key or grant stops working on the
next message.

There are two ways to authenticate:

| Method | For | How |
| --- | --- | --- |
| API key | Cursor, Claude Code, Claude Desktop (config file), VS Code | `Authorization: Bearer jfk_…`. The same keys as the [management API](FEDERATED-API.md). |
| OAuth 2.1 | claude.ai and ChatGPT connectors, Claude Desktop custom connectors | The app registers itself and sends you to a Justflows consent screen. |

**Hosted connectors need public HTTPS.** claude.ai and ChatGPT call your site
from the internet, so it must be reachable at a public `https://` address.
The setup page warns when it is not. Local and development installs can still
use API-key clients. The advertised URL comes from `APP_URL`, or from the
request when `APP_URL` is a loopback address.

### Creating a key for a client

**Create a key for <client>** makes a key with a preset:

| Preset | Capabilities |
| --- | --- |
| Content editor | `content:*` (read, create, update, delete, publish, revisions:read), `media:read/upload/delete`, `comments:moderate`, `settings:read`, `settings:manage`. Menus are managed with `settings:manage`. Narrow the key afterwards if menus are not needed. |
| Full admin | Everything you hold, except `ai:use`. |
| Read only | `content:read`, `content:revisions:read`, `media:read`, `settings:read`, `plugins:read`, `themes:read`. |

A key can never exceed its creator's capabilities. On every request the key
is also re-intersected with the owner's **current** access.

### Connected apps

Apps authorized through OAuth are listed under **Settings → API → Connected
apps** for administrators (every user's grants). The list shows when the grant was created and last used,
and **Revoke** ends it immediately.

## Client setup

Replace `URL` with your MCP server URL and `KEY` with a `jfk_…` key.

**Cursor** — `.cursor/mcp.json` in the project, or global MCP settings:

```json
{ "mcpServers": { "justflows": { "url": "URL", "headers": { "Authorization": "Bearer KEY" } } } }
```

**Claude Code:**

```sh
claude mcp add --transport http justflows URL --header "Authorization: Bearer KEY"
```

**Claude Desktop.** Use **Settings → Connectors → Add custom connector**,
paste the URL and sign in (OAuth). Or add a key-based bridge to
`claude_desktop_config.json`:

```json
{ "mcpServers": { "justflows": { "command": "npx", "args": ["-y", "mcp-remote", "URL", "--header", "Authorization: Bearer KEY"] } } }
```

**claude.ai** — **Settings → Connectors → Add custom connector**, paste the
URL. You are sent to Justflows to sign in and approve.

**ChatGPT** — **Settings → Apps & Connectors → Advanced settings**, turn on
developer mode, create a connector with the URL and choose OAuth.

**VS Code** — `.vscode/mcp.json`:

```json
{ "servers": { "justflows": { "type": "http", "url": "URL", "headers": { "Authorization": "Bearer KEY" } } } }
```

### OAuth endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource[/api/mcp]` | Protected resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `POST /oauth/register` | Dynamic client registration (RFC 7591) |
| `GET /oauth/authorize` | Authorization code + PKCE (S256 only); continues at `/oauth/consent` |
| `POST /oauth/token` | Code exchange and refresh-token rotation |
| `POST /oauth/revoke` | Token revocation (RFC 7009) |

A `401` from `/api/mcp` carries
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"`,
which is how clients discover the flow. Tokens can also be bound to
`/api/manage/v1` (`resource=https://your-site/api/manage/v1`) for
agent-facing use of the management API. This authorization server exists only
for MCP and agent use of the management API. It is not a general third-party
app platform.

## Tools

Tools are generated from the [management API](FEDERATED-API.md) operations. A
tool call runs the operation's own handler in-process, over an in-memory HTTP
connection, with the same `ensureKeyCan` capability and scope check and the
same service layer as `/api/manage/v1`. Each tool's capability comes from the
operation's `x-required-capability`. A test fails if an operation is neither
a tool nor a documented exclusion.

A tool is listed in `tools/list` only when the session holds its
capabilities. Calling an unlisted tool is refused. Each tool has MCP
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

| Group | Tools |
| --- | --- |
| Discovery | `site_describe` (start here), `blocks_catalog`, `content_types_list`, `content_types_get` |
| Content | `content_list` (type, status, locale, search, author), `content_get`, `content_create`, `content_update`, `content_delete` (trash), `content_publish`, `content_unpublish`, `content_schedule`, `content_revisions_list`, `content_revision_get` |
| Media | `media_list`, `media_get`, `media_upload` (public URL or base64), `media_update` (alt text, caption, focal point), `media_delete` |
| Menus | `menus_list`, `menus_get`, `menus_upsert`, `menus_delete` |
| Comments | `comments_list`, `comments_moderate` (one or many), `comments_edit`, `comments_reply`, `comments_delete` |
| Content types | `content_types_create`, `content_types_update`, `content_types_delete` |
| Site | `settings_get`, `settings_update`, `languages_list/create/update/delete`, `redirects_list/create/update`, `permalinks_get/update`, `plugins_list/activate/deactivate`, `themes_list/activate`, `cache_stats`, `cache_clear`, `static_export_status`, `static_export_run`, `static_export_clear`, `trash_list/restore/purge`, `analytics_summary`, `comment_rules_list/create/delete`, `spam_terms_list/create/delete`, `cookies_get/update`, `email_templates_list/update/restore/preview`, `email_design_update/restore`, `site_health`, `site_diagnostics` |
| Design | `headers_get`, `headers_options`, `headers_update`, `template_parts_get/update` (the footer is part `footer`), `widget_areas_list/get/update/discard_draft`, `widget_layout_update`, `content_set_header`, `templates_list/get/update/discard_draft/reset`, `themes_customize_get/update/discard_draft`, `reusable_blocks_list/save/delete`, `patterns_list/get/save/delete/export/import`, `error_pages_get/update` |
| Users & roles | `users_list/get/create/update/delete`, `roles_list/create/update/delete`. Listed only when the key or OAuth grant turns on **users & roles tools**, even with `users:manage`. |

A full-admin key (every capability except `ai:use`, with users & roles tools turned on) is offered every tool above. A session still only sees the tools its capabilities allow.

Not exposed, because the result is a secret or the action replaces the running install: the OpenAPI document, the event catalog, webhook endpoints and their signing secrets, API key creation, plugin and theme zip upload, and applying a core update. The management API has no taxonomy-term endpoints yet, so there are no taxonomy tools. Sending a test email stays in the admin.

**Agent content is validated.** `content_create` and `content_update` check
block bodies against the live block registry before anything is written:
unknown types are rejected with the list of valid ones, required props must
be set, select props must use a listed option, children are allowed only
where the block supports them, and each block's `validateProps` must accept
the props. The platform sanitizer still runs in the shared write path.
Validation problems come back as tool errors (`isError: true`) the model can
fix.

**Safe by default.** `content_create` saves a draft unless `publish: true` is
passed and the session has `content:publish`. `content_update` requires
`expectedVersion`, so it never silently overwrites a newer edit.

`media_upload` accepts a public `http(s)` URL (downloaded with the SSRF guard
on every redirect, never from a private address) or inline base64. Uploads
are limited to 20 MB and to the media library's allowed types. Inline base64
must fit in a 2 MB request.

### Attribution and audit

Every MCP or assistant call that is not read-only is written to the audit log
as `ai.tool_called`. The entry holds the user, the key id or OAuth client id
and grant, the tool, the target id, and the outcome. Arguments are never
logged. Revisions created by an agent record `via` (`mcp` or `assistant`) and
the client name, so the editor's history reads "… · via Claude".

## Resources and prompts

| Resource | Content |
| --- | --- |
| `justflows://docs/authoring` | How to build valid content: blocks, drafts, versions, media, translations |
| `justflows://docs/blocks` | This repository's `docs/BLOCKS.md` |
| `justflows://content-types/<slug>` | Each content type's field schema |

Prompts: `draft_post`, `translate_entry`, `seo_metadata`, `audit_alt_text`.

## The admin assistant (BYOK)

### Provider keys

**Admin → Settings → AI** is the only admin page for configuring provider
keys. It manages site-wide keys. The API also supports personal keys for users
with `ai:use`; a personal key takes precedence over the site key for the same
provider.

| Provider | Notes |
| --- | --- |
| Anthropic | Claude models via the Messages API. |
| OpenAI | GPT and o-series models via Chat Completions. Optional organization and project ids. |
| OpenAI-compatible | Any endpoint with a custom base URL: OpenRouter, Azure OpenAI (v1 API), Mistral, Groq, Ollama (`http://localhost:11434/v1`), LM Studio. |

Keys are encrypted at rest with `secret-box` (`APP_SECRET`) and are
**write-only**. The UI shows the provider and the last four characters, and
no API response ever contains a key. Saving, replacing, and removing a key is
audit-logged (`ai.provider_saved` / `ai.provider_removed`), without the key.
**Test connection** lists the key's models and stores them for the model
picker. Every provider call is made by the server; a key never reaches the
browser.

Provider adapters live in `apps/server/src/lib/ai/providers/<provider>/`,
behind one interface (`providers/types.ts`): streaming chat, tool calling,
and image input.

### Using the assistant

**Assistant** in the sidebar opens a chat panel. In the content editor, the
**AI ✦** menu offers one-click actions:

- rewrite, shorten, or expand the selected text;
- write the excerpt and the SEO title and description;
- write alt text for the entry's images (vision models);
- draft the entry from a brief;
- translate the entry into another configured language, creating a linked
  draft translation.

Every action shows its result for review first. Nothing is saved until you
apply it and save as usual.

The assistant uses the **same tool registry as the MCP server**, running as
you: it can never do more than you can, and there is no service account.
Read-only tools run automatically. **Every create, update, delete, publish, or
settings change** is shown as a confirmation card with a preview — a
before/after diff for content and media — and runs only when you click
Approve. Destructive changes need an explicit click every time. The server
enforces this, not the UI: the chat loop never executes a non-read-only tool.
A write runs only through a separate request made when you approve it.

The panel shows token usage per conversation, and the optional daily request
limit. Provider errors (invalid key, quota exceeded, model unavailable, rate
limited) are reported in plain words. **Conversations are not stored on the
server**: they live in your browser tab (`sessionStorage`). Only what you and
the tools put into a conversation is sent to the provider.

## Settings and capabilities

| Setting | Default | Where |
| --- | --- | --- |
| `mcp_enabled` | off | Settings → API. Also needs `manage_api_enabled`. |
| `mcp_rate_limit` | unset (uses `manage_api_rate_limit`) | Settings → API |
| `ai_assistant_enabled` | off | Settings → AI |
| `ai_allow_private_endpoints` | off | Settings → AI |
| `ai_user_daily_limit` | unset (unlimited) | Settings → AI |

The `ai:use` capability lets a user use the assistant and add personal keys.
Administrator and editor roles get it by default; assign it to any role or
user like any other capability. Configuring site-wide providers and the
switches needs `settings:manage`.

Migration `0036_ai_byok` (PostgreSQL, MySQL, MariaDB) adds:

- `ai_provider_credentials`;
- `ai_usage_daily`;
- `oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_tokens`;
- `revisions.via` / `via_client`;
- `api_keys.mcp_user_tools`.

## Security model

- **Prompt injection is assumed.** Post bodies, comments, user profiles, media
  metadata, and form content are data. The assistant's system prompt says so,
  tool output is labeled "data, not instructions", and no tool output can
  trigger a write without your click. The MCP server's instructions tell
  external agents the same.
- **Capabilities.** Every tool call re-checks the session's capabilities
  against the user's **current** role and access policy, and `AccessScope`
  (content type, locale, ownership) is enforced on every read and write by
  the management API handler. Revoking a user, key, or grant cuts off MCP and
  assistant access on the next request.
- **OAuth hardening.**
  - PKCE S256 is required.
  - Redirect URIs must match exactly. HTTPS is required, except plain HTTP on
    loopback and private-use schemes for native apps.
  - Authorization codes are single-use and live five minutes. Replaying one
    revokes the grant.
  - Access tokens live one hour. Refresh tokens rotate, and reusing one
    revokes the whole grant.
  - Every code, token, and client secret is stored only as a SHA-256 hash.
  - Tokens are bound to their resource and checked against it on every use.
  - Consent always needs a signed-in user clicking **Allow**, and the
    permissions can only be narrowed, never widened past the user's own.
- **SSRF.** Provider base URLs and `media_upload` URLs go through the webhook
  URL guard on every redirect hop. Private and loopback addresses are allowed
  only for **site-wide** provider base URLs, and only while
  `ai_allow_private_endpoints` is on. `media_upload` and personal keys never
  reach private addresses.
- **Rate limits.** MCP is limited per key or grant and per IP. The OAuth
  registration, authorization, and token endpoints have their own stricter
  limits. Media upload, static export, cache, and plugin/theme activation keep
  their extra per-route limits when called through tools. The assistant is
  limited per user.
- **Errors.** Failed MCP authentication is a generic `401` with the
  `WWW-Authenticate` challenge. It never says whether a key, token, or client
  exists. OAuth token errors are generic too.
- **Secrets** never appear in logs, audit entries, tool results, error
  messages, or the OpenAPI/MCP schema.

## For plugin authors

- **Plugin tools.** A plugin can add tools through the `mcp.tools` filter.
  Append `McpToolDefinition` objects: `name`, `description`, `inputSchema`,
  `capability`, optional `annotations`, and `handler(args, context)`.
  - The host lists the tool only to sessions that hold `capability`, checks it
    again on every call, audits non-read-only calls, and attributes revisions.
  - The handler must do any per-resource checks itself.
  - Names must be `snake_case`, prefixed with the plugin, and must not shadow
    a core tool.

  ```ts
  ctx.hooks.filter("mcp.tools", (tools) => [
    ...tools,
    {
      name: "acme_seo_score",
      description: "Score an entry for SEO and list what to fix.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      capability: "content:read",
      annotations: { readOnlyHint: true },
      handler: async ({ id }, { siteId }) => scoreEntry(siteId, String(id)),
    },
  ]);
  ```
- **Plugin capabilities** work with keys and grants like core ones.
