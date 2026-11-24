// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/lib/database/db.js";
import { runAllMigrations, type DbDriver } from "../../../src/lib/database/run-migrations.js";
import { runWithTenant, type TenantRequestContext } from "../../../src/lib/tenancy/context.js";
import { principalForAssistant, type AgentPrincipal } from "../../../src/lib/ai/tools/principal.js";
import { callTool, outcomeText, toolsForPrincipal } from "../../../src/lib/ai/tools/registry.js";
import type { AgentTool } from "../../../src/lib/ai/tools/manage-tool.js";

/**
 * Cross-site isolation for every agent tool, on a real shared database.
 *
 * Site B is filled through its own agent tools, with a marker in every value.
 * Then site A's administrator (every capability, users & roles tools on) calls
 * every tool it can see with every id, slug and key that exists on site B.
 * No answer may contain B's marker, and none of B's rows may change.
 *
 * Opt in only with a disposable database:
 *   AGENT_ISOLATION_TEST_DATABASE=1 DB_NAME=isolation_test DB_DRIVER=postgres|mysql|mariadb \
 *   pnpm vitest run tests/integration/database/agent-isolation-db.integration.test.ts
 */
const enabled = process.env.AGENT_ISOLATION_TEST_DATABASE === "1" && process.env.DB_NAME === "isolation_test";

/** Uppercase on purpose: slugs are lowercase, and site A reusing one of B's slugs for its own record is not a leak. */
const MARKER = "BSECRET";

/** Work that reaches outside the database (crawling, the export folder) is not a cross-site data path. */
const SKIPPED_TOOLS = new Set(["static_export_run", "static_export_clear"]);

const ID_LIKE = /^(id|ids|slug|key|part|revisionId|parentId|homePageId|blogPageId|translationGroupId)$/;

interface Site {
  tenantId: string;
  siteId: string;
  hostname: string;
  adminId: string;
  rootSite: boolean;
}

function newSite(label: string, rootSite = false): Site {
  return { tenantId: randomUUID(), siteId: randomUUID(), hostname: `${label}-${randomUUID().slice(0, 8)}.isolation.test`, adminId: randomUUID(), rootSite };
}

function contextOf(site: Site): TenantRequestContext {
  return {
    tenantId: site.tenantId,
    siteId: site.siteId,
    hostname: site.hostname,
    userMode: "isolated",
    databaseMode: "current",
    rootSite: site.rootSite,
    activePluginIds: new Set(),
    networkPluginIds: new Set(),
  };
}

async function principalFor(site: Site): Promise<AgentPrincipal> {
  const principal = await runWithTenant(contextOf(site), () =>
    principalForAssistant({ userId: site.adminId, siteId: site.siteId, role: "administrator" }),
  );
  return { ...principal, userTools: true };
}

function asSite<T>(site: Site, work: () => Promise<T>): Promise<T> {
  return runWithTenant(contextOf(site), work);
}

/** A placeholder of the right type for a property that is not an id. */
function filler(name: string, type: unknown): unknown {
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("string")) {
    if (name === "action") return "approve";
    if (name === "source") return "site";
    if (name === "locale") return "en";
    return "x";
  }
  if (types.includes("integer") || types.includes("number")) return 1;
  if (types.includes("boolean")) return false;
  if (types.includes("array")) return [];
  if (types.includes("object")) return {};
  return null;
}

/** Arguments for `tool` that aim every id-like property at `victim`. */
function attackArgs(tool: AgentTool, victim: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  let aimed = false;
  const required = new Set(tool.inputSchema.required ?? []);
  for (const [name, spec] of Object.entries(tool.inputSchema.properties)) {
    const type = (spec as { type?: unknown }).type;
    if (ID_LIKE.test(name)) {
      args[name] = name === "ids" ? [victim] : victim;
      aimed = true;
    } else if (name === "items" && (tool.name === "trash_restore" || tool.name === "trash_purge")) {
      args.items = ["content", "media", "comment", "menu", "pattern", "reusable"].map((type) => ({ type, id: victim }));
      aimed = true;
    } else if (required.has(name)) {
      args[name] = filler(name, type);
    }
  }
  return aimed ? args : null;
}

/** Every row of every site-owned table, for one site. */
async function snapshot(siteId: string, tables: string[]): Promise<Record<string, string>> {
  const db = await getDb();
  const out: Record<string, string> = {};
  for (const table of tables) {
    const rows = await db.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE site_id = ?`, [siteId]);
    out[table] = JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());
  }
  return out;
}

describe.skipIf(!enabled)("agent tools never reach another site", () => {
  const driver = process.env.DB_DRIVER as DbDriver;
  const root = newSite("root", true);
  const siteA = newSite("site-a");
  const siteB = newSite("site-b");
  let siteTables: string[] = [];
  const victims = new Set<string>();
  const seedFailures: string[] = [];
  let bContentDraft = "";

  beforeAll(async () => {
    const db = await getDb();
    await runAllMigrations(db, driver);
    for (const site of [root, siteA, siteB]) {
      await db.run("INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, 'active')", [site.tenantId, site.hostname, site.hostname.replace(/\./g, "-")]);
      await db.run("INSERT INTO sites (id, name, url, tenant_id, status) VALUES (?, ?, ?, ?, 'active')", [site.siteId, site.hostname, `https://${site.hostname}`, site.tenantId]);
      await db.run("INSERT INTO site_domains (id, site_id, hostname, is_primary) VALUES (?, ?, ?, ?)", [randomUUID(), site.siteId, site.hostname, true]);
      await db.run(
        "INSERT INTO users (id, site_id, email, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?, 'x', 'administrator')",
        [site.adminId, site.siteId, `admin@${site.hostname}`, `admin-${site.siteId.slice(0, 8)}`, site === siteB ? `${MARKER} admin` : "Admin"],
      );
    }

    /** Site B fills itself through its own tools. */
    const b = await principalFor(siteB);
    const seed = async (name: string, args: Record<string, unknown>) => {
      const result = await asSite(siteB, () => callTool(b, name, args));
      if (!result.outcome.ok) seedFailures.push(`${name}: ${result.outcome.error}`);
      return result.outcome.ok ? (result.outcome.data as Record<string, unknown>) : null;
    };
    const paragraph = (text: string) => ({ version: 1, blocks: [{ type: "core.paragraph", props: { text } }] });
    const draft = await seed("content_create", { title: `${MARKER} draft page`, type: "page", blocks: paragraph(`${MARKER} draft body`) });
    bContentDraft = String(draft?.id ?? "");
    const post = await seed("content_create", { title: `${MARKER} published post`, type: "post", blocks: paragraph(`${MARKER} body`), publish: true });
    await seed("menus_upsert", { slug: "b-only-menu", name: `${MARKER} menu`, items: [{ id: "1", label: `${MARKER} link`, type: "custom", url: "/b-only" }] });
    await seed("taxonomies_create", { slug: "b-only-tax", name: `${MARKER} taxonomy` });
    await seed("terms_create", { slug: "b-only-tax", name: `${MARKER} term` });
    await seed("content_types_create", { slug: "b-only-type", label: `${MARKER} type` });
    await seed("reusable_blocks_save", { name: `${MARKER} block`, blocks: paragraph(`${MARKER} reusable`).blocks });
    await seed("redirects_create", { source: "/b-only", kind: "exact", targetType: "internal", target: "/b-only-target", status: 301, enabled: true });
    await seed("comment_rules_create", { list: "block", field: "phrase", pattern: `${MARKER}-rule` });
    await seed("spam_terms_create", { kind: "phrase", value: `${MARKER}spam` });
    await seed("languages_create", { code: "nl" });
    await seed("widget_areas_create", { key: "b-only-area", label: `${MARKER} area` });
    await seed("template_parts_update", { part: "footer", blocks: paragraph(`${MARKER} footer`).blocks });
    await seed("users_create", { email: "b-only@site-b.test", username: "bonlyuser", displayName: `${MARKER} user`, role: "editor" });
    await seed("roles_create", { name: `${MARKER} role`, capabilities: ["content:read"] });

    /** Rows no agent tool creates. */
    await db.run(
      "INSERT INTO media (id, site_id, filename, mime_type, size_bytes, storage_key, url, alt_text) VALUES (?, ?, ?, 'image/png', 1, ?, ?, ?)",
      [randomUUID(), siteB.siteId, `${MARKER}.png`, `${siteB.siteId}/b-only.png`, `/uploads/${siteB.siteId}/b-only.png`, `${MARKER} alt`],
    );
    if (post?.id) {
      await db.run(
        "INSERT INTO comments (id, site_id, content_id, author_name, author_email, body, status) VALUES (?, ?, ?, ?, 'b-only@site-b.test', ?, 'pending')",
        [randomUUID(), siteB.siteId, String(post.id), `${MARKER} commenter`, `${MARKER} comment`],
      );
    }

    const columns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name AS table_name, column_name AS column_name FROM information_schema.columns
       WHERE table_schema = ${driver === "postgres" ? "current_schema()" : "DATABASE()"}`,
    );
    const byTable = new Map<string, Set<string>>();
    for (const row of columns) {
      const table = String(row.table_name);
      if (!byTable.has(table)) byTable.set(table, new Set());
      byTable.get(table)!.add(String(row.column_name));
    }
    siteTables = [...byTable].filter(([, cols]) => cols.has("site_id")).map(([table]) => table).sort();
    for (const [table, cols] of byTable) {
      if (!cols.has("site_id")) continue;
      for (const column of ["id", "slug", "key", "theme_id", "plugin_id", "translation_group_id"]) {
        if (!cols.has(column)) continue;
        const quoted = column === "key" ? (driver === "postgres" ? '"key"' : "`key`") : column;
        const rows = await db.query<{ value: unknown }>(`SELECT ${quoted} AS value FROM ${table} WHERE site_id = ? LIMIT 5`, [siteB.siteId]);
        for (const row of rows) if (row.value != null && String(row.value)) victims.add(String(row.value));
      }
    }
  }, 120_000);

  afterAll(async () => {
    await (await getDb()).close();
  });

  it("seeds site B through its own tools", () => {
    expect(seedFailures).toEqual([]);
    expect(bContentDraft).not.toBe("");
    expect(victims.size).toBeGreaterThan(15);
  });

  it("refuses an explicit siteId or tenantId for another site", async () => {
    const a = await principalFor(siteA);
    for (const args of [{ siteId: siteB.siteId }, { filter: { tenant_id: siteB.tenantId } }]) {
      const result = await asSite(siteA, () => callTool(a, "content_list", args));
      expect(result.outcome).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("refuses a menu item that links to site B's content", async () => {
    const a = await principalFor(siteA);
    const result = await asSite(siteA, () =>
      callTool(a, "menus_upsert", { slug: "primary", items: [{ id: "1", label: "", type: "page", contentId: bContentDraft }] }),
    );
    expect(result.outcome.ok).toBe(false);
  });

  it("leaks nothing and changes nothing on site B, whatever site A's tools are aimed at", async () => {
    const a = await principalFor(siteA);
    const tools = (await asSite(siteA, () => toolsForPrincipal(a))).filter((tool) => !SKIPPED_TOOLS.has(tool.name));
    expect(tools.length).toBeGreaterThan(100);

    const before = await snapshot(siteB.siteId, siteTables);
    const leaks: string[] = [];
    let calls = 0;
    const record = (tool: string, args: unknown, text: string) => {
      calls += 1;
      if (text.includes(MARKER)) leaks.push(`${tool} ${JSON.stringify(args)} -> ${text.slice(0, 300)}`);
    };

    for (const tool of tools) {
      const baseline: Record<string, unknown> = {};
      for (const name of tool.inputSchema.required ?? []) {
        baseline[name] = filler(name, (tool.inputSchema.properties[name] as { type?: unknown } | undefined)?.type);
      }
      const plain = await asSite(siteA, () => callTool(a, tool.name, baseline));
      record(tool.name, baseline, outcomeText(plain.outcome));

      for (const victim of victims) {
        const args = attackArgs(tool, victim);
        if (!args) break;
        const result = await asSite(siteA, () => callTool(a, tool.name, args));
        record(tool.name, args, outcomeText(result.outcome));
      }
    }

    const after = await snapshot(siteB.siteId, siteTables);
    const changed = siteTables.filter((table) => before[table] !== after[table]);
    console.info(`[isolation] ${calls} calls across ${tools.length} tools, ${victims.size} site B values, ${siteTables.length} site tables`);
    expect(leaks).toEqual([]);
    expect(changed).toEqual([]);
  }, 600_000);
});
