// SPDX-License-Identifier: MIT

/**
 * OpenAPI 3.1 description of the federated management API (`/api/manage/v1`).
 *
 * Authenticated with a revocable API key as `Authorization: Bearer jfk_…`.
 * Every operation carries `x-required-capability`: the capability the key must
 * hold (never broader than its creator's, and re-checked against the owner's
 * current access on every request). Plugin-registered routes continue to
 * advertise themselves through the `openapi.document` filter.
 */

const errorResponse = {
  description: "Error",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

function op(
  summary: string,
  capability: string,
  responses: Record<string, unknown> = { "200": { description: "OK" } },
) {
  return {
    summary,
    "x-required-capability": capability,
    responses: { ...responses, "401": errorResponse, "403": errorResponse, "429": errorResponse },
  };
}

export const MANAGE_API_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Justflows Federated Management API",
    version: "manage/v1",
    description:
      "Operate Justflows headlessly over HTTP: content, media, comments, menus, the header library, footer and templates, theme appearance, content types, users, roles, settings, languages, redirects, permalinks, plugins, themes, cache, static export, trash, email templates, diagnostics, the event catalog and self-managed webhooks. Authenticate with a revocable API key as `Authorization: Bearer jfk_…`. Enable the surface in Admin → Settings → API. Each operation reuses the same capability check as its cookie-authenticated counterpart.",
  },
  servers: [{ url: "/api/manage/v1" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "A Justflows API key (prefix `jfk_`). Create one in Admin → Settings → API.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      Page: {
        type: "object",
        properties: {
          data: { type: "array", items: {} },
          page: {
            type: "object",
            properties: {
              limit: { type: "integer" },
              cursor: { type: ["string", "null"] },
              nextCursor: { type: ["string", "null"] },
              total: { type: "integer" },
            },
          },
        },
      },
    },
  },
  paths: {
    "/openapi.json": { get: op("This OpenAPI document", "(none)") },
    "/events": { get: op("Platform event catalog with payload schemas", "(any key)") },

    "/content": {
      get: {
        ...op("List content (cursor paginated)", "content:read"),
        parameters: [
          { name: "type", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["draft", "published", "archived", "scheduled", "trash"] } },
          { name: "locale", in: "query", schema: { type: "string" } },
          { name: "search", in: "query", description: "Case-insensitive match on title or slug", schema: { type: "string" } },
          { name: "author", in: "query", description: "Author user id", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
      },
      post: op("Create a content entry (draft)", "content:create", { "201": { description: "Created" } }),
    },
    "/content/{id}": {
      get: op("Get one content entry", "content:read", {
        "200": { description: "OK" },
        "404": errorResponse,
      }),
      patch: op("Update a content entry (draft, working revision, publish or unpublish)", "content:update"),
      delete: op("Move a content entry to trash", "content:delete"),
    },
    "/content/{id}/schedule": { put: {
      ...op("Set, change or cancel publishing/expiry (also requires content:update)", "content:publish"),
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["publishOn", "unpublishOn", "expectedVersion"], additionalProperties: false,
        properties: { publishOn: { type: ["string", "null"], format: "date-time" }, unpublishOn: { type: ["string", "null"], format: "date-time" }, expectedVersion: { type: "integer", minimum: 1 } },
      } } } },
    } },
    "/content/{id}/publish": { post: op("Publish a content entry", "content:publish") },
    "/content/{id}/unpublish": { post: op("Return a published entry to draft", "content:publish") },
    "/content/{id}/revisions": { get: op("List revisions", "content:revisions:read") },
    "/content/{id}/revisions/{revisionId}": {
      get: op("Get one revision (with body)", "content:revisions:read"),
    },
    "/content/{id}/header-ref": {
      put: op("Choose which header library entry a page renders (__default__, __none__, or an entry id)", "content:update"),
    },

    "/media": {
      get: op("List media library items", "media:read"),
      post: op("Upload a file (multipart/form-data, field `file`)", "media:upload", {
        "201": { description: "Created" },
      }),
    },
    "/media/{id}": {
      get: op("Get one media item", "media:read"),
      patch: op("Update alt text, caption or focal point", "media:upload"),
      delete: op("Move a media item to trash", "media:delete"),
    },

    "/comments": {
      get: op("List comments by status", "comments:moderate"),
      patch: op("Bulk set comment status (approve/pending/spam/trash)", "comments:moderate"),
      delete: op("Permanently delete trashed comments", "comments:moderate"),
    },
    "/comments/{id}": { patch: op("Edit or restatus one comment", "comments:moderate") },
    "/comments/{id}/reply": { post: op("Reply to a comment as a moderator", "comments:moderate") },

    "/menus": { get: op("List menus", "content:read"), post: op("Create a menu", "settings:manage", { "201": { description: "Created" } }) },
    "/menus/{slug}": {
      get: op("Get one menu with resolved items", "content:read"),
      put: op("Replace a menu's items / design", "settings:manage"),
      delete: op("Trash a menu", "settings:manage"),
    },

    "/content-types": {
      get: op("List content type definitions", "content:read"),
      post: op("Create a content type", "settings:manage", { "201": { description: "Created" } }),
    },
    "/content-types/{slug}": {
      get: op("Get one content type", "content:read"),
      patch: op("Update a content type", "settings:manage"),
      delete: op("Delete a content type", "settings:manage"),
    },

    "/languages": {
      get: op("List configured languages", "settings:read"),
      post: op("Add a language", "settings:manage", { "201": { description: "Created" } }),
    },
    "/languages/{id}": {
      patch: op("Update a language (activate, reorder, rename, make default)", "settings:manage"),
      delete: op("Remove a language", "settings:manage"),
    },

    "/redirects": {
      get: op("List managed redirects", "settings:read"),
      post: op("Create a redirect", "settings:manage", { "201": { description: "Created" } }),
    },
    "/redirects/{id}": { put: op("Update a redirect", "settings:manage") },

    "/users": {
      get: op("List users", "users:read"),
      post: op("Create a user", "users:manage", { "201": { description: "Created" } }),
    },
    "/users/{id}": {
      get: op("Get a user with effective access", "users:read"),
      patch: op("Update a user's role, additional roles, access policy or display name", "users:manage"),
      delete: op("Delete a user", "users:manage"),
    },
    "/roles": {
      get: op("List built-in and custom roles", "users:read"),
      post: op("Create a custom role", "users:manage", { "201": { description: "Created" } }),
    },
    "/roles/{id}": {
      patch: op("Update a custom role", "users:manage"),
      delete: op("Delete a custom role", "users:manage"),
    },

    "/settings": {
      get: op("Read site settings", "settings:read"),
      patch: op("Change site settings", "settings:manage"),
    },

    "/tenants": {
      get: op("List workspaces and sites. The key's user must be a platform operator. Passwords are never returned.", "platform operator"),
      post: op("Create a workspace on the current database or a separate one", "platform operator", { "201": { description: "Created" } }),
    },
    "/tenants/{id}/sites": {
      post: op("Add a site. Choose inherit, current, or separate", "platform operator", { "201": { description: "Created" } }),
    },
    "/tenants/{id}/quotas": {
      get: op("Read workspace quota meters, including current usage", "platform operator"),
      put: op("Replace workspace quota limits. Null clears a meter back to unlimited", "platform operator"),
    },
    "/sites/{id}/quotas": {
      get: op("Read website quota meters, including current usage", "platform operator"),
      put: op("Replace website quota limits. Null clears a meter back to unlimited", "platform operator"),
    },
    "/tenants/{id}/suspend": { post: op("Suspend a workspace", "platform operator") },
    "/tenants/{id}/reactivate": { post: op("Reactivate a workspace", "platform operator") },
    "/tenants/{id}": { delete: op("Mark a workspace deleted. dropDatabase drops only that workspace's separate databases", "platform operator") },

    "/plugins": { get: op("List installed plugins", "plugins:read") },
    "/plugins/{id}/activate": { post: op("Activate a plugin", "plugins:activate") },
    "/plugins/{id}/deactivate": { post: op("Deactivate a plugin", "plugins:activate") },
    "/themes": { get: op("List installed themes", "themes:read") },
    "/themes/{id}/activate": { post: op("Activate a theme", "themes:activate") },

    "/cache/stats": { get: op("Object cache statistics", "settings:read") },
    "/cache/clear": { post: op("Clear the object cache and page store", "settings:manage") },
    "/static-export": { get: op("Static export status", "settings:read") },
    "/static-export/run": { post: op("Run a static export (full or incremental)", "settings:manage") },
    "/static-export/clear": { post: op("Delete the static export output", "settings:manage") },
    "/diagnostics": { get: op("Version, migrations and runtime diagnostics", "site:admin") },
    "/health": { get: op("Platform health checks", "(any key)") },

    "/headers": {
      get: op("Read the site header library (published and draft)", "content:read"),
      put: op("Save or publish the site header library", "settings:manage"),
    },
    "/headers/options": { get: op("Header picker options for pages", "content:read") },
    "/template-parts/{part}": {
      get: op("Read a template part (footer) including its draft", "content:read"),
      put: op("Save or publish a template part", "settings:manage"),
    },
    "/widgets": { get: op("List widget areas, the per-content-type widget layout, and content types", "content:read") },
    "/widgets/layout": { put: op("Save which widget area each content type shows, and where", "settings:manage") },
    "/widgets/areas/{key}": {
      get: op("Read one widget area: base blocks, per-locale overrides, and draft", "content:read"),
      put: op("Save or publish a widget area", "settings:manage"),
    },
    "/widgets/areas/{key}/discard-draft": { post: op("Discard a widget area draft", "settings:manage") },
    "/templates": { get: op("List page templates for the active theme", "content:read") },
    "/templates/{slug}": {
      get: op("Read one page template", "content:read"),
      put: op("Save or publish a page template", "settings:manage"),
      delete: op("Reset a page template to the theme file", "settings:manage"),
    },
    "/templates/{slug}/discard-draft": { post: op("Discard a page template draft", "settings:manage") },
    "/themes/customize": {
      get: op("Read theme appearance, home blocks and blog blocks", "content:read"),
      patch: op("Change theme appearance, home blocks, blog blocks, or the home and blog pages", "settings:manage"),
      delete: op("Discard unpublished theme customizer drafts", "settings:manage"),
    },
    "/reusable-blocks": {
      get: op("List reusable blocks", "content:read"),
      put: op("Create or replace a reusable block", "settings:manage"),
    },
    "/reusable-blocks/{id}": { delete: op("Delete a reusable block", "settings:manage") },
    "/patterns": {
      get: op("List site, theme and plugin block patterns", "content:read"),
      put: op("Save a site block pattern", "settings:manage"),
    },
    "/patterns/export": { get: op("Export the site pattern set", "settings:manage") },
    "/patterns/import": { post: op("Import a pattern set", "settings:manage") },
    "/patterns/{source}/{id}": { get: op("Read one pattern (source is site, theme or plugin)", "content:read") },
    "/patterns/{id}": { delete: op("Delete a site pattern", "settings:manage") },
    "/error-pages": {
      get: op("Read error page sources", "content:read"),
      put: op("Change error page sources", "settings:manage"),
    },
    "/permalinks": {
      get: op("Read permalink structure, presets and type bases", "settings:read"),
      put: op("Replace permalink settings", "settings:manage"),
    },
    "/trash": {
      get: op("List trashed content, media, comments and menus", "content:delete"),
      delete: op("Permanently delete selected trash items", "site:admin"),
    },
    "/trash/restore": { post: op("Restore trash items", "content:delete") },
    "/analytics": { get: op("Site analytics summary", "analytics:read") },
    "/comment-rules": {
      get: op("List comment block and allow rules", "comments:moderate"),
      post: op("Add a comment moderation rule", "settings:manage", { "201": { description: "Created" } }),
    },
    "/comment-rules/{id}": { delete: op("Remove a comment moderation rule", "settings:manage") },
    "/comment-spam-terms": {
      get: op("List spam terms", "comments:moderate"),
      post: op("Add a spam term", "settings:manage", { "201": { description: "Created" } }),
    },
    "/comment-spam-terms/{id}": { delete: op("Remove a spam term", "settings:manage") },
    "/cookies": {
      get: op("Read the cookie registry and category overrides", "settings:read"),
      put: op("Reclassify cookies by name", "settings:manage"),
    },
    "/email-templates": { get: op("List email templates and the email design", "email-templates:read") },
    "/email-templates/design": { put: op("Save the email design", "email-templates:manage") },
    "/email-templates/design/restore": { post: op("Restore the default email design", "email-templates:manage") },
    "/email-templates/{key}": { put: op("Save an email template", "email-templates:manage") },
    "/email-templates/{key}/restore": { post: op("Restore an email template to its default", "email-templates:manage") },
    "/email-templates/{key}/preview": { post: op("Preview an email template", "email-templates:read") },

    "/webhooks": {
      get: op("List the webhook endpoints this key registered", "settings:manage"),
      post: op("Register a webhook endpoint owned by this key", "settings:manage", {
        "201": { description: "Created — secret shown once" },
      }),
    },
    "/webhooks/{id}": {
      put: op("Update one of this key's webhook endpoints", "settings:manage"),
      delete: op("Delete one of this key's webhook endpoints", "settings:manage", {
        "204": { description: "Deleted" },
      }),
    },
    "/webhooks/{id}/rotate-secret": {
      post: op("Rotate a webhook signing secret", "settings:manage"),
    },
  },
} as const;
