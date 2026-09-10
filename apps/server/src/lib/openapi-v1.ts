// SPDX-License-Identifier: MIT

export const PUBLIC_API_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Justflows Public Content API",
    version: "v1",
    description:
      "Published content, media, menus, and content types for headless frontends. Enable the public API in Admin → Settings. Drafts are never returned unless `preview=1` is sent with an editor session cookie.",
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/search": {
      get: {
        summary: "Search published content (preview never includes drafts)",
        parameters: [
          ...["q", "locale", "type", "taxonomy", "term", "after", "before"].map(name => ({ name, in: "query", schema: { type: "string" } })),
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
        ],
        responses: {
          "200": { description: "items (id, title, url, excerpt, highlights as text/match segments), total, page, limit, hasMore, backend, typoTolerance" },
          "400": { description: "Invalid search parameters" },
          "429": { description: "Too many searches" },
        },
      },
    },
    "/content": {
      get: {
        summary: "List published content",
        parameters: [
          { name: "type", in: "query", schema: { type: "string" } },
          { name: "slug", in: "query", schema: { type: "string" } },
          { name: "locale", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "preview",
            in: "query",
            description: "Include drafts when the caller has an editor session",
            schema: { type: "string", enum: ["1"] },
          },
        ],
        responses: {
          "200": { description: "Paginated content list" },
        },
      },
    },
    "/content/{slug}": {
      get: {
        summary: "Get one published entry by slug",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "locale", in: "query", schema: { type: "string" } },
          { name: "preview", in: "query", schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": { description: "Content entry including custom fields" },
          "404": { description: "Not found" },
        },
      },
    },
    "/content-types": {
      get: {
        summary: "List content type definitions",
        responses: { "200": { description: "Type schemas, including builtins" } },
      },
    },
    "/media": {
      get: {
        summary: "List media library items",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", maximum: 200 } }],
        responses: { "200": { description: "Media items with public URLs" } },
      },
    },
    "/menus": {
      get: {
        summary: "List navigation menus",
        parameters: [{ name: "locale", in: "query", schema: { type: "string" } }],
        responses: {
          "200": {
            description:
              "Menus with resolved item URLs, each menu's layout/design config, and — for a mega-menu item — its regions as sanitized block JSON for the caller to render. Items gated by an auth/role/plugin visibility rule are never included: the public API always resolves as an anonymous visitor.",
          },
        },
      },
    },
    "/menus/{slug}": {
      get: {
        summary: "Get one menu by slug",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "locale", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "Resolved menu, its design config, and any mega-menu regions as sanitized block JSON. Same visibility-rule omission as GET /menus.",
          },
          "404": { description: "Not found" },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "This OpenAPI document",
        responses: { "200": { description: "OpenAPI 3.1 document" } },
      },
    },
  },
} as const;
