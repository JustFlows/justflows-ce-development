// SPDX-License-Identifier: MIT
import { describe, expect, it, vi, beforeEach } from "vitest";

const access = vi.hoisted(() => ({ capabilities: [] as string[] }));
vi.mock("../../../src/lib/auth/access-policy.js", () => ({
  getEffectiveAccess: async () => ({ roleId: "editor", capabilities: access.capabilities, policy: { scopes: {} } }),
}));
const hooks = vi.hoisted(() => ({ tools: [] as unknown[] }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({
    has: (name: string) => name === "mcp.tools",
    applyFilter: async (_name: string, value: unknown[]) => [...value, ...hooks.tools],
  }),
}));
const dispatch = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<{ status: number; body: unknown }> => ({ status: 200, body: { ok: true } })));
vi.mock("../../../src/lib/ai/tools/dispatch.js", () => ({ dispatchManageApi: dispatch }));
const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog: audit }));

const { MANAGE_API_OPENAPI } = await import("../../../src/lib/http/openapi-manage.js");
const { CORE_TOOLS, EXCLUDED_OPERATIONS } = await import("../../../src/lib/ai/tools/catalog.js");
const { callTool, checkArguments, toolsForPrincipal } = await import("../../../src/lib/ai/tools/registry.js");
const { syntheticKey } = await import("../../../src/lib/ai/tools/principal.js");
import type { AgentPrincipal } from "../../../src/lib/ai/tools/principal.js";

function principal(keyCapabilities: string[], userTools = false): AgentPrincipal {
  const owner = { userId: "u1", siteId: "s1", role: "editor" };
  return {
    kind: "api-key",
    id: "key-1",
    clientName: "Cursor",
    key: syntheticKey({ id: "key-1", name: "Cursor", owner, capabilities: keyCapabilities }),
    owner,
    userTools,
    via: "mcp",
  };
}

beforeEach(() => {
  access.capabilities = [];
  hooks.tools = [];
  dispatch.mockClear();
  audit.mockClear();
});

describe("tool generation from the management API", () => {
  const operations = Object.entries(MANAGE_API_OPENAPI.paths as Record<string, Record<string, { "x-required-capability"?: string }>>).flatMap(
    ([path, methods]) => Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
  );
  const generated = new Map(CORE_TOOLS.filter((tool) => tool.operation).map((tool) => [`${tool.operation!.method} ${tool.operation!.path}`, tool]));

  it("covers every management API operation with a tool or a documented exclusion", () => {
    const missing = operations.map(({ key }) => key).filter((key) => !generated.has(key) && !(key in EXCLUDED_OPERATIONS));
    expect(missing).toEqual([]);
  });

  it("takes each tool's capability from the operation's x-required-capability", () => {
    for (const tool of CORE_TOOLS.filter((t) => t.operation)) {
      const op = operations.find(({ key }) => key === `${tool.operation!.method} ${tool.operation!.path}`)!.op;
      const required = op["x-required-capability"]!;
      if (!required.startsWith("(")) expect(tool.capabilities, tool.name).toContain(required);
    }
  });

  it("gives every tool a unique snake_case name, a description, an object schema and annotations", () => {
    const names = CORE_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of CORE_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      if (tool.operation?.method === "GET") expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      if (tool.operation?.method === "DELETE") expect(tool.annotations.destructiveHint, tool.name).toBe(true);
    }
  });

  it("includes the minimum tool set the issue asks for", () => {
    const names = new Set(CORE_TOOLS.map((tool) => tool.name));
    for (const name of [
      "site_describe", "blocks_catalog", "content_types_list", "content_types_get",
      "content_list", "content_get", "content_create", "content_update", "content_delete", "content_publish",
      "content_unpublish", "content_schedule", "content_revisions_list", "content_revision_get",
      "media_list", "media_get", "media_upload", "media_update", "media_delete",
      "menus_list", "menus_get", "menus_upsert", "menus_delete",
      "comments_list", "comments_moderate", "comments_reply", "comments_delete",
      "content_types_create", "content_types_update", "content_types_delete",
      "headers_get", "headers_update", "headers_options", "template_parts_get", "template_parts_update",
      "content_set_header", "templates_list", "themes_customize_get", "themes_customize_update",
      "widget_areas_list", "widget_areas_get", "widget_areas_update", "widget_layout_update",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

describe("capability filtering", () => {
  it("lists only tools whose capabilities the key AND the owner both hold", async () => {
    access.capabilities = ["content:read", "content:create", "media:read"];
    const tools = await toolsForPrincipal(principal(["content:read", "content:create", "settings:manage"]));
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("content_list");
    expect(names).toContain("content_create");
    expect(names).not.toContain("media_list"); // owner has it, key does not
    expect(names).not.toContain("menus_upsert"); // key has settings:manage, owner does not
    expect(names).not.toContain("content_publish");
  });

  it("hides users & roles tools unless the key opted in", async () => {
    access.capabilities = ["users:read", "users:manage"];
    const off = (await toolsForPrincipal(principal(["users:read", "users:manage"]))).map((t) => t.name);
    expect(off).not.toContain("users_list");
    const on = (await toolsForPrincipal(principal(["users:read", "users:manage"], true))).map((t) => t.name);
    expect(on).toContain("users_list");
    expect(on).toContain("roles_create");
  });

  it("offers header, footer and user tools to a full admin key", async () => {
    const all = [
      "content:read", "content:create", "content:update", "content:delete", "content:publish",
      "content:revisions:read", "media:read", "media:upload", "media:delete", "comments:moderate",
      "settings:read", "settings:manage", "themes:read", "themes:activate", "plugins:read", "plugins:activate",
      "users:read", "users:manage", "email-templates:read", "email-templates:manage", "analytics:read", "site:admin",
    ];
    access.capabilities = all;
    const names = (await toolsForPrincipal(principal(all, true))).map((tool) => tool.name);
    expect(names).toContain("headers_get");
    expect(names).toContain("headers_update");
    expect(names).toContain("template_parts_get");
    expect(names).toContain("template_parts_update");
    expect(names).toContain("content_set_header");
    expect(names).toContain("themes_customize_update");
    expect(names).toContain("users_list");
    expect(names).toContain("email_templates_list");
    expect(names).toContain("trash_purge");
  });

  it("refuses a direct call to a tool that is not listed, without dispatching", async () => {
    access.capabilities = ["content:read"];
    const result = await callTool(principal(["content:read"]), "content_delete", { id: "c1" });
    expect(result.outcome).toMatchObject({ ok: false, status: 403 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches a listed tool through the management API and audits writes, never their arguments", async () => {
    access.capabilities = ["content:read", "content:delete"];
    const p = principal(["content:read", "content:delete"]);
    const result = await callTool(p, "content_delete", { id: "c1" }, { ip: "203.0.113.5" });
    expect(result.outcome.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(p, expect.objectContaining({ method: "DELETE", path: "/content/c1" }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.tool_called", target: "c1", detail: expect.stringContaining("tool=content_delete") }),
    );

    audit.mockClear();
    await callTool(p, "content_get", { id: "c1" });
    expect(audit).not.toHaveBeenCalled(); // reads are not audited
  });

  it("turns HTTP failures into tool errors a model can act on", async () => {
    access.capabilities = ["content:read"];
    dispatch.mockResolvedValueOnce({ status: 404, body: { error: "Not found" } });
    const result = await callTool(principal(["content:read"]), "content_get", { id: "missing" });
    expect(result.outcome).toMatchObject({ ok: false, status: 404 });
  });
});

describe("plugin tools (mcp.tools)", () => {
  it("lists a plugin tool only with its capability, and checks it again on call", async () => {
    const handler = vi.fn(async () => ({ score: 42 }));
    hooks.tools = [
      { name: "acme_seo_score", description: "Score an entry for SEO.", inputSchema: { type: "object", properties: {} }, capability: "content:read", annotations: { readOnlyHint: true }, handler },
      { name: "content_get", description: "Shadowing a core tool is ignored.", inputSchema: { type: "object" }, capability: "content:read", handler },
    ];
    access.capabilities = ["content:read"];
    const p = principal(["content:read"]);
    const tools = await toolsForPrincipal(p);
    expect(tools.filter((t) => t.name === "content_get")).toHaveLength(1);
    expect(tools.map((t) => t.name)).toContain("acme_seo_score");
    const result = await callTool(p, "acme_seo_score", {});
    expect(result.outcome).toEqual({ ok: true, data: { score: 42 } });
    expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({ userId: "u1", via: "mcp", client: "Cursor" }));
  });
});

describe("argument checks", () => {
  const schema = {
    type: "object" as const,
    properties: { id: { type: "string" }, status: { type: "string", enum: ["draft", "published"] }, n: { type: "integer" } },
    required: ["id"],
    additionalProperties: false,
  };
  it("reports missing, unknown, mistyped and out-of-enum arguments", () => {
    expect(checkArguments(schema, {})).toMatch(/Missing required argument "id"/);
    expect(checkArguments(schema, { id: "x", extra: 1 })).toMatch(/Unknown argument "extra"/);
    expect(checkArguments(schema, { id: 5 })).toMatch(/"id" must be string/);
    expect(checkArguments(schema, { id: "x", status: "gone" })).toMatch(/must be one of/);
    expect(checkArguments(schema, { id: "x", n: 1.5 })).toMatch(/must be integer/);
    expect(checkArguments(schema, { id: "x", status: "draft", n: 2 })).toBeNull();
  });
});
