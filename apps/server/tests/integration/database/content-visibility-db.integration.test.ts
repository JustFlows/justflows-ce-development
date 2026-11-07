// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANONYMOUS_VIEWER, ContentVisibilityPolicySchema, SearchQuerySchema } from "@justflows/content";
import { PluginVisibilityRuleRegistry } from "@justflows/plugin-api";

const viewer = vi.hoisted(() => ({ current: null as unknown }));
const registry = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  ensurePluginRuntime: async () => undefined,
  getPluginLoader: () => ({ visibilityRuleRegistry: registry.current }),
  getRuntimeHooks: () => ({ applyFilter: async (_hook: string, value: unknown) => value, has: () => false }),
}));
vi.mock("../../../src/lib/navigation/permalinks-db.js", () => ({
  contentPermalinks: async (rows: Array<{ slug: string }>) => rows.map((row) => `/${row.slug}`),
}));
vi.mock("../../../src/lib/content/visibility-viewer.js", () => ({
  currentVisibilityViewer: async () => viewer.current,
  visibilityRequestMemo: () => undefined,
}));

import { getDb } from "../../../src/lib/database/db.js";
import { runAllMigrations, type DbDriver } from "../../../src/lib/database/run-migrations.js";
import { listPublishedContent, listPublishedPostsPage } from "../../../src/lib/content/content-public.js";
import { queryPublishedContent } from "../../../src/lib/content/content-query.js";
import { getVisibilityScope } from "../../../src/lib/content/visibility-scope.js";
import { saveVisibilityOverride } from "../../../src/lib/content/visibility-policies.js";
import { createPluginContentApi } from "../../../src/lib/plugins/plugin-content.js";
import { indexSearchContent, saveSearchSettings, searchContent } from "../../../src/lib/search/search-db.js";

/** Opt in only with a disposable database; never uses the developer's installed site. */
const enabled = process.env.VISIBILITY_TEST_DATABASE === "1" && process.env.DB_NAME === "visibility_test";

describe.skipIf(!enabled)("content visibility on a real database", () => {
  const siteId = randomUUID();
  const otherSite = randomUUID();
  const memberId = randomUUID();
  const member = { userId: memberId, roles: ["member"], authenticated: true };
  const ids: Record<string, string> = {};
  const policy = (input: Record<string, unknown>) => ContentVisibilityPolicySchema.parse(input);
  const query = { contentType: "post", taxonomy: "", term: "", orderBy: "published", order: "desc", limit: 50, offset: 0 };
  const titles = (items: Array<{ title: string }>) => items.map((item) => item.title).sort();
  const asViewer = async <T,>(who: unknown, work: () => Promise<T>) => {
    viewer.current = who;
    return work();
  };

  async function addContent(site: string, title: string, type = "post", groupId: string | null = null, locale = "en-US") {
    const db = await getDb();
    const id = randomUUID();
    ids[title] = id;
    await db.run(
      `INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, status, blocks, fields, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, '{}', ?)`,
      [id, site, type, title, title.toLowerCase(), locale, groupId, JSON.stringify({ version: 1, blocks: [{ id: "b", type: "core.paragraph", version: 1, props: { text: `needle ${title}` } }] }), "2026-01-01 00:00:00"],
    );
    return id;
  }

  async function setTypeDefault(slug: string, visibility: unknown) {
    const db = await getDb();
    await db.run("UPDATE content_types SET settings = ? WHERE site_id = ? AND slug = ?", [JSON.stringify({ visibility }), siteId, slug]);
    await flush();
  }

  async function flush() {
    const { getJfCache } = await import("../../../src/lib/cache/jf-cache.js");
    await getJfCache().invalidate("content:");
  }

  beforeAll(async () => {
    registry.current = new PluginVisibilityRuleRegistry();
    viewer.current = ANONYMOUS_VIEWER;
    const db = await getDb();
    await runAllMigrations(db, process.env.DB_DRIVER as DbDriver);
    for (const [id, slug] of [[siteId, "visibility-site"], [otherSite, "other-site"]]) {
      const tenantId = randomUUID();
      await db.run("INSERT INTO tenants (id, slug, name, status) VALUES (?, ?, ?, 'active')", [tenantId, `t-${tenantId}`, "Visibility"]);
      await db.run("INSERT INTO sites (id, tenant_id, name, url) VALUES (?, ?, ?, ?)", [id!, tenantId, slug!, `https://${id!}.example`]);
      await db.run(
        "INSERT INTO content_types (id, site_id, slug, label, description, is_builtin, fields) VALUES (?, ?, 'post', 'Post', '', ?, '[]')",
        [randomUUID(), id!, process.env.DB_DRIVER === "postgres" ? true : 1],
      );
    }
    await addContent(siteId, "Open");
    await addContent(siteId, "Members");
    await addContent(siteId, "Secret");
    const group = randomUUID();
    const original = await addContent(siteId, "Translated", "post", group);
    await addContent(siteId, "Vertaald", "post", group, "nl-NL");
    await addContent(otherSite, "Foreign");
    await saveVisibilityOverride(siteId, ids.Members!, policy({ audience: "nobody", allowRoles: ["member"] }), null);
    await saveVisibilityOverride(siteId, ids.Secret!, policy({ audience: "nobody" }), null);
    await saveVisibilityOverride(siteId, group, policy({ audience: "authenticated" }), null);
    /** The same rule on a second site must not reach this site. */
    await saveVisibilityOverride(otherSite, ids.Open!, policy({ audience: "everyone" }), null);
    await saveSearchSettings(siteId, { publicTypes: ["post"] });
    for (const title of ["Open", "Members", "Secret", "Translated"]) await indexSearchContent(siteId, ids[title]!, true);
    await flush();
    expect(original).toBe(ids.Translated);
  });

  afterAll(async () => {
    const db = await getDb();
    await db.run("DELETE FROM sites WHERE id IN (?, ?)", [siteId, otherSite]);
    await db.close?.();
  });

  it("gives SQL and in-memory checks the same answer for every viewer", async () => {
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>("SELECT id, type, translation_group_id FROM content WHERE site_id = ?", [siteId]);
    for (const who of [ANONYMOUS_VIEWER, member, { userId: randomUUID(), roles: ["subscriber"], authenticated: true }]) {
      const scope = await getVisibilityScope(siteId, who);
      const { sql, params } = scope.sql("c");
      const fromSql = await db.query<{ id: string }>(`SELECT c.id FROM content c WHERE c.site_id = ? AND ${sql}`, [siteId, ...params]);
      const fromMemory = rows
        .filter((row) => scope.allows({ id: String(row.id), type: String(row.type), translationGroupId: row.translation_group_id == null ? null : String(row.translation_group_id) }))
        .map((row) => String(row.id));
      expect(fromSql.map((row) => String(row.id)).sort()).toEqual(fromMemory.sort());
    }
  });

  it("keeps lists, totals, and pagination exact for each viewer", async () => {
    const anonymous = await asViewer(ANONYMOUS_VIEWER, () => queryPublishedContent(siteId, "en-US", query));
    expect(titles(anonymous.items)).toEqual(["Open"]);
    expect(anonymous.total).toBe(1);
    const signedIn = await asViewer(member, () => queryPublishedContent(siteId, "en-US", query));
    expect(titles(signedIn.items)).toEqual(["Members", "Open", "Translated"]);
    expect(signedIn.total).toBe(3);
    const page = await asViewer(ANONYMOUS_VIEWER, () => listPublishedPostsPage(siteId, "en-US", { limit: 10, offset: 0 }));
    expect(titles(page.items)).toEqual(["Open"]);
    expect(page.total).toBe(1);
    const memberPage = await asViewer(member, () => listPublishedPostsPage(siteId, "en-US", { limit: 10, offset: 0 }));
    expect(memberPage.total).toBe(3);
  });

  it("does not let one visitor's list reach the next through a cache", async () => {
    await asViewer(member, () => listPublishedPostsPage(siteId, "en-US", { limit: 5, offset: 0 }));
    const next = await asViewer(ANONYMOUS_VIEWER, () => listPublishedPostsPage(siteId, "en-US", { limit: 5, offset: 0 }));
    expect(titles(next.items)).toEqual(["Open"]);
  });

  it("applies one rule to every translation", async () => {
    const scope = await getVisibilityScope(siteId, ANONYMOUS_VIEWER);
    const { sql, params } = scope.sql("c");
    const db = await getDb();
    const rows = await db.query<{ title: string }>(`SELECT c.title FROM content c WHERE c.site_id = ? AND ${sql}`, [siteId, ...params]);
    expect(rows.map((row) => row.title)).not.toContain("Vertaald");
  });

  it("filters search, including its total", async () => {
    const search = SearchQuerySchema.parse({ q: "needle", locale: "en-US" });
    const anonymous = await asViewer(ANONYMOUS_VIEWER, () => searchContent(siteId, search));
    expect(anonymous.items.map((item) => item.title)).toEqual(["Open"]);
    expect(anonymous.total).toBe(1);
    const signedIn = await asViewer(member, () => searchContent(siteId, search));
    expect(signedIn.total).toBe(3);
  });

  it("keeps shared output anonymous even during a signed-in request", async () => {
    const published = await asViewer(member, () => listPublishedContent(siteId));
    expect(titles(published)).toEqual(["Open"]);
    const api = createPluginContentApi("justflows.seo", siteId);
    const listed = await asViewer(member, () => api.listPublished({ types: ["post"], limit: 50 }));
    expect(titles(listed)).toEqual(["Open"]);
    await expect(asViewer(member, () => api.getPublished!({ type: "post", slug: "members" }))).resolves.toBeNull();
  });

  it("lets a type default hide everything, and an override open one entry back up", async () => {
    await setTypeDefault("post", policy({ audience: "authenticated" }));
    await saveVisibilityOverride(siteId, ids.Open!, policy({ audience: "everyone" }), null);
    await flush();
    const anonymous = await asViewer(ANONYMOUS_VIEWER, () => queryPublishedContent(siteId, "en-US", query));
    expect(titles(anonymous.items)).toEqual(["Open"]);
    await saveVisibilityOverride(siteId, ids.Open!, null, null);
    await flush();
    const closed = await asViewer(ANONYMOUS_VIEWER, () => queryPublishedContent(siteId, "en-US", query));
    expect(closed.items).toEqual([]);
    await setTypeDefault("post", null);
  });

  it("evaluates a per-item plugin rule and hides everything when the rule goes away", async () => {
    const rules = registry.current as PluginVisibilityRuleRegistry;
    const dispose = rules.register("justflows.sample", {
      id: "only-open",
      label: "Only open",
      evaluate: ({ content }) => ({ effect: content?.slug === "open" ? "allow" : "deny", reason: "sample" }),
    });
    await setTypeDefault("post", policy({ rules: [{ id: "justflows.sample:only-open", mode: "require" }] }));
    const allowed = await asViewer(ANONYMOUS_VIEWER, () => queryPublishedContent(siteId, "en-US", query));
    expect(titles(allowed.items)).toEqual(["Open"]);
    expect(allowed.total).toBe(1);
    dispose();
    /** The type's rule now denies. Entries with their own override do not use it. */
    const denied = await asViewer(member, () => queryPublishedContent(siteId, "en-US", query));
    expect(titles(denied.items)).toEqual(["Members", "Translated"]);
    expect(denied.total).toBe(2);
    await setTypeDefault("post", null);
  });
});
