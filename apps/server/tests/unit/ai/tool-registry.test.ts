// SPDX-License-Identifier: MIT
import { describe, expect, it, vi, beforeEach } from "vitest";

const access = vi.hoisted(() => ({ capabilities: [] as string[] }));
vi.mock("../../../src/lib/auth/access-policy.js", () => ({
  availableCapabilityDefinitions: async () => [],
  getEffectiveAccess: async () => ({
    roleId: "editor",
    capabilities: access.capabilities,
    policy: { scopes: {} },
  }),
}));
const hooks = vi.hoisted(() => ({ tools: [] as unknown[] }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  getPluginLoader: () => null,
  getRuntimeHooks: () => ({
    has: (name: string) => name === "mcp.tools",
    applyFilter: async (_name: string, value: unknown[]) => [...value, ...hooks.tools],
  }),
}));
const dispatch = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<{ status: number; body: unknown }> => ({
    status: 200,
    body: { ok: true },
  })),
);
vi.mock("../../../src/lib/ai/tools/dispatch.js", () => ({ dispatchManageApi: dispatch }));
const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog: audit }));

const { MANAGE_API_OPENAPI } = await import("../../../src/lib/http/openapi-manage.js");
const { CORE_TOOLS, EXCLUDED_OPERATIONS } = await import("../../../src/lib/ai/tools/catalog.js");
const { callTool, checkArguments, toolsForPrincipal } =
  await import("../../../src/lib/ai/tools/registry.js");
const { removesSomething } = await import("../../../src/lib/ai/tools/manage-tool.js");
const { syntheticKey } = await import("../../../src/lib/ai/tools/principal.js");
const { asksForCredential } = await import("../../../src/lib/ai/hub/hub-credentials.js");
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
  const operations = Object.entries(
    MANAGE_API_OPENAPI.paths as Record<
      string,
      Record<string, { "x-required-capability"?: string }>
    >,
  ).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
  );
  const generated = new Map(
    CORE_TOOLS.filter((tool) => tool.operation).map((tool) => [
      `${tool.operation!.method} ${tool.operation!.path}`,
      tool,
    ]),
  );

  it("covers every management API operation with a tool or a documented exclusion", () => {
    const missing = operations
      .map(({ key }) => key)
      .filter((key) => !generated.has(key) && !(key in EXCLUDED_OPERATIONS));
    expect(missing).toEqual([]);
  });

  it("takes each tool's capability from the operation's x-required-capability", () => {
    for (const tool of CORE_TOOLS.filter((t) => t.operation)) {
      const op = operations.find(
        ({ key }) => key === `${tool.operation!.method} ${tool.operation!.path}`,
      )!.op;
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
      if (tool.operation?.method === "GET")
        expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      if (tool.operation?.method === "DELETE")
        expect(tool.annotations.destructiveHint, tool.name).toBe(true);
    }
  });

  it("calls a write non-destructive only when it adds something", () => {
    const additive = CORE_TOOLS.filter((tool) => !tool.annotations.readOnlyHint && !tool.annotations.destructiveHint).map((tool) => tool.name);
    expect(additive.sort()).toEqual([
      "comment_rules_create", "content_create", "content_types_create", "languages_create", "media_upload", "plugins_activate",
      "redirects_create", "roles_create", "spam_terms_create", "taxonomies_create", "terms_create", "trash_restore", "widget_areas_create",
    ]);
  });

  it("marks every write visitors can see, or that emails someone, as open world, and nothing else", () => {
    const closed = CORE_TOOLS.filter((tool) => !tool.annotations.readOnlyHint && !tool.annotations.openWorldHint).map((tool) => tool.name);
    expect(closed.sort()).toEqual([
      "comment_rules_create", "comment_rules_delete", "content_update", "email_design_restore", "email_design_update",
      "email_templates_restore", "email_templates_update", "patterns_delete", "patterns_import", "patterns_save",
      "reusable_blocks_discard", "roles_create", "roles_delete", "roles_update", "spam_terms_create", "spam_terms_delete",
      "style_presets_delete", "style_presets_discard", "style_presets_save", "templates_discard_draft", "themes_customize_discard_draft",
      "trash_purge", "users_delete", "users_update", "widget_areas_create", "widget_areas_discard_draft",
    ]);
    for (const tool of CORE_TOOLS.filter((entry) => entry.annotations.readOnlyHint))
      expect(tool.annotations, tool.name).toMatchObject({ destructiveHint: false, openWorldHint: false });
  });

  it("keeps the assistant's red confirmation for calls that remove something", () => {
    const tool = (name: string) => CORE_TOOLS.find((entry) => entry.name === name)!;
    for (const name of ["content_delete", "static_export_clear", "reusable_blocks_discard", "plugins_deactivate", "templates_reset", "trash_purge"])
      expect(removesSomething(tool(name)), name).toBe(true);
    for (const name of ["content_update", "headers_update", "comments_reply", "users_create", "content_create"])
      expect(removesSomething(tool(name)), name).toBe(false);
  });

  it("includes the minimum tool set the issue asks for", () => {
    const names = new Set(CORE_TOOLS.map((tool) => tool.name));
    for (const name of [
      "site_describe",
      "blocks_catalog",
      "content_types_list",
      "content_types_get",
      "content_list",
      "content_get",
      "content_create",
      "content_update",
      "content_delete",
      "content_publish",
      "content_unpublish",
      "content_schedule",
      "content_revisions_list",
      "content_revision_get",
      "media_list",
      "media_get",
      "media_upload",
      "media_update",
      "media_delete",
      "menus_list",
      "menus_get",
      "menus_upsert",
      "menus_delete",
      "comments_list",
      "comments_moderate",
      "comments_reply",
      "comments_delete",
      "content_types_create",
      "content_types_update",
      "content_types_delete",
      "headers_get",
      "headers_update",
      "headers_options",
      "template_parts_get",
      "template_parts_update",
      "content_set_header",
      "templates_list",
      "themes_customize_get",
      "themes_customize_update",
      "widget_areas_list",
      "widget_areas_get",
      "widget_areas_update",
      "widget_layout_update",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

describe("capability filtering", () => {
  it("lists only tools whose capabilities the key AND the owner both hold", async () => {
    access.capabilities = ["content:read", "content:create", "media:read"];
    const tools = await toolsForPrincipal(
      principal(["content:read", "content:create", "settings:manage"]),
    );
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("content_list");
    expect(names).toContain("content_create");
    expect(names).not.toContain("media_list"); // owner has it, key does not
    expect(names).not.toContain("menus_upsert"); // key has settings:manage, owner does not
    expect(names).not.toContain("content_publish");
  });

  it("offers reading users with users:read alone, and changing them only when the key opted in", async () => {
    access.capabilities = ["users:read", "users:manage"];
    const readOnly = (await toolsForPrincipal(principal(["users:read"]))).map((t) => t.name);
    expect(readOnly.filter((name) => /^(users|roles)_/.test(name)).sort()).toEqual(["roles_list", "users_get", "users_list"]);
    const off = (await toolsForPrincipal(principal(["users:read", "users:manage"]))).map(
      (t) => t.name,
    );
    expect(off.filter((name) => /^(users|roles)_/.test(name)).sort()).toEqual(["roles_list", "users_get", "users_list"]);
    expect((await toolsForPrincipal(principal(["content:read"], true))).map((t) => t.name)).not.toContain("users_list");
    const assistant: AgentPrincipal = { ...principal(["users:read", "users:manage"]), kind: "assistant", via: "assistant" };
    expect((await toolsForPrincipal(assistant)).filter((t) => t.group === "users")).toEqual([]);
    const on = (await toolsForPrincipal(principal(["users:read", "users:manage"], true))).map(
      (t) => t.name,
    );
    expect(on).toContain("users_list");
    expect(on).toContain("roles_create");
  });

  it("never takes a credential as a tool argument", () => {
    for (const tool of CORE_TOOLS) expect(asksForCredential(tool.inputSchema), tool.name).toBe(false);
  });

  it("creates a user without a password, and refuses one", async () => {
    access.capabilities = ["users:read", "users:manage"];
    const caller = principal(["users:read", "users:manage"], true);
    const account = { email: "sam@example.com", username: "sam", displayName: "Sam" };
    const refused = await callTool(caller, "users_create", { ...account, password: "a-Long-passw0rd!" });
    expect(refused.outcome).toMatchObject({ ok: false, status: 400 });
    expect(dispatch).not.toHaveBeenCalled();
    const created = await callTool(caller, "users_create", account);
    expect(created.outcome.ok).toBe(true);
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ method: "POST", path: "/users", body: account });
    expect(created.annotations.openWorldHint).toBe(true);
  });

  it("refuses a date of birth on users_update", async () => {
    access.capabilities = ["users:read", "users:manage"];
    const caller = principal(["users:read", "users:manage"], true);
    const refused = await callTool(caller, "users_update", { id: "u2", birthDate: "1990-01-01" });
    expect(refused.outcome).toMatchObject({ ok: false, status: 400 });
    expect((await callTool(caller, "users_update", { id: "u2", role: "author", scopes: {} })).outcome.ok).toBe(true);
  });

  it("leaves the date of birth and second-factor state out of users_get", async () => {
    access.capabilities = ["users:read"];
    dispatch.mockResolvedValueOnce({
      status: 200,
      body: { user: { id: "u2", email: "sam@example.com", role: "author", birth_date: "1990-01-01", twoFactorEnabled: true, passkeys: 2, content: { total: 3 }, effectiveCapabilities: ["content:read"] } },
    });
    const { outcome } = await callTool(principal(["users:read"]), "users_get", { id: "u2" });
    expect(outcome).toEqual({ ok: true, data: { user: { id: "u2", email: "sam@example.com", role: "author", effectiveCapabilities: ["content:read"] } } });
  });

  it("offers header, footer and user tools to a full admin key", async () => {
    const all = [
      "content:read",
      "content:create",
      "content:update",
      "content:delete",
      "content:publish",
      "content:revisions:read",
      "media:read",
      "media:upload",
      "media:delete",
      "comments:moderate",
      "settings:read",
      "settings:manage",
      "themes:read",
      "themes:activate",
      "plugins:read",
      "plugins:activate",
      "users:read",
      "users:manage",
      "email-templates:read",
      "email-templates:manage",
      "analytics:read",
      "site:admin",
    ];
    /** The owner is an administrator, who holds the design capabilities; the key predates them (justflows-ce#314). */
    access.capabilities = [...all, "design:read", "design:manage"];
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
    expect(dispatch).toHaveBeenCalledWith(
      p,
      expect.objectContaining({ method: "DELETE", path: "/content/c1" }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.tool_called",
        target: "c1",
        detail: expect.stringContaining("tool=content_delete"),
      }),
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

/** Accessibility checks for agents (justflows-ce#313). */
describe("accessibility checks", () => {
  const blocks = [
    { id: "img", type: "core.image", version: 1, props: { src: "/uploads/a.png", alt: "" } },
    { id: "h", type: "core.heading", version: 1, props: { text: "Details", level: 4 } },
  ];

  it("offers content_accessibility_check to anyone who can read content, through the API endpoint", async () => {
    access.capabilities = ["content:read"];
    const p = principal(["content:read"]);
    expect((await toolsForPrincipal(p)).map((t) => t.name)).toContain("content_accessibility_check");
    await callTool(p, "content_accessibility_check", { id: "c1", lang: "nl" });
    expect(dispatch).toHaveBeenCalledWith(p, expect.objectContaining({ method: "GET", path: "/content/c1/accessibility", query: { lang: "nl" } }));
  });

  it("returns the issues of the saved blocks with content_update", async () => {
    access.capabilities = ["content:read", "content:update"];
    dispatch.mockResolvedValueOnce({ status: 200, body: { id: "c1", version: 2 } });
    const result = await callTool(principal(["content:read", "content:update"]), "content_update", { id: "c1", expectedVersion: 1, blocks: { version: 1, blocks } });
    expect(result.outcome.ok).toBe(true);
    const data = (result.outcome as { data: { id: string; accessibility: { counts: Record<string, number>; issues: Array<{ code: string; blockId: string }> } } }).data;
    expect(data.id).toBe("c1");
    expect(data.accessibility.counts).toEqual({ error: 0, warning: 2, unavailable: 0 });
    expect(data.accessibility.issues.map((i) => `${i.code}:${i.blockId}`)).toEqual(["image-alt:img", "heading-skip:h"]);
  });

  it("adds nothing when the update did not change blocks or failed", async () => {
    access.capabilities = ["content:read", "content:update"];
    const p = principal(["content:read", "content:update"]);
    dispatch.mockResolvedValueOnce({ status: 200, body: { id: "c1" } });
    const titleOnly = await callTool(p, "content_update", { id: "c1", expectedVersion: 1, title: "New" });
    expect((titleOnly.outcome as { data: Record<string, unknown> }).data).not.toHaveProperty("accessibility");
    dispatch.mockResolvedValueOnce({ status: 409, body: { error: "stale" } });
    const failed = await callTool(p, "content_update", { id: "c1", expectedVersion: 1, blocks: { version: 1, blocks } });
    expect(failed.outcome.ok).toBe(false);
  });
});

describe("API-only plugin tools", () => {
  it("does not list or execute arbitrary mcp.tools handlers", async () => {
    const handler = vi.fn(async () => ({ source: "server source" }));
    hooks.tools = [{ name: "acme_read_code", capability: "content:read", handler }];
    access.capabilities = ["content:read"];
    const p = principal(["content:read"]);
    expect((await toolsForPrincipal(p)).some((tool) => tool.name === "acme_read_code")).toBe(false);
    expect((await callTool(p, "acme_read_code", {})).outcome).toMatchObject({ ok: false, status: 403 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("argument checks", () => {
  const schema = {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["draft", "published"] },
      n: { type: "integer" },
    },
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

describe("security-sensitive tool output", () => {
  it("filters core management API results", async () => {
    access.capabilities = ["content:read"];
    dispatch.mockResolvedValueOnce({
      status: 200,
      body: { fields: { clientSecret: "do-not-return" } },
    });
    const result = await callTool(principal(["content:read"]), "content_get", { id: "c1" });
    expect(JSON.stringify(result)).not.toContain("do-not-return");
  });
});

describe("agent site boundary", () => {
  it.each(["api-key", "oauth", "assistant"] as const)("refuses a %s principal on a different site", async (kind) => {
    const { runWithTenant } = await import("../../../src/lib/tenancy/context.js");
    access.capabilities = ["content:read"];
    const p = principal(["content:read"]); p.kind = kind;
    await runWithTenant({ siteId: "s2", tenantId: "t2", hostname: "other.test", userMode: "isolated", databaseMode: "current", activePluginIds: new Set() }, async () => {
      expect(await toolsForPrincipal(p)).toEqual([]);
      expect((await callTool(p, "content_get", { id: "c1" })).outcome).toMatchObject({ ok: false, status: 403 });
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("refuses a mismatched key and owner", async () => {
    access.capabilities = ["content:read"];
    const p = principal(["content:read"]); p.key.siteId = "s2";
    expect(await toolsForPrincipal(p)).toEqual([]);
  });
  it("never exposes global health, diagnostics, cache or code tools to full admins", async () => {
    access.capabilities = ["site:admin", "settings:read", "settings:manage"];
    const p = principal(access.capabilities);
    for (const name of ["site_health", "site_diagnostics", "cache_stats", "cache_clear", "read_file", "execute_sql", "read_code", "execute_code"]) {
      expect((await callTool(p, name, {})).outcome).toMatchObject({ ok: false, status: 403 });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
});
