// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/lib/database/db.js";
import { runAllMigrations, type DbDriver } from "../../../src/lib/database/run-migrations.js";
import {
  getTemplatePartDocs,
  publishTemplatePartDoc,
  saveTemplatePartDraft,
} from "../../../src/lib/rendering/template-parts-db.js";
import {
  getThemeTemplateDocs,
  saveThemeTemplateDraft,
} from "../../../src/lib/themes/theme-templates-db.js";
import { DocumentRevisionConflictError } from "../../../src/lib/database/document-revision.js";
import {
  DOCUMENT_HISTORY_LIMIT,
  getDocumentHistoryDoc,
  listDocumentHistory,
  recordDocumentHistory,
} from "../../../src/lib/rendering/document-history.js";
import { getSiteSetting, setSiteSetting, updateSiteSettingAtomically } from "../../../src/lib/settings/site-settings.js";

/**
 * Builder 2.0 concurrency on a real database (justflows-ce#302): revision
 * checks on template parts and theme templates, document history, and atomic
 * list settings. Opt in only with a disposable database:
 *
 *   BUILDER_TEST_DATABASE=1 DB_NAME=builder_test DB_DRIVER=postgres|mysql|mariadb \
 *   pnpm vitest run tests/integration/database/builder-concurrency-db.integration.test.ts
 */
const enabled = process.env.BUILDER_TEST_DATABASE === "1" && process.env.DB_NAME === "builder_test";

describe.skipIf(!enabled)("builder concurrency on a real database", () => {
  const siteId = randomUUID();
  const otherSite = randomUUID();

  beforeAll(async () => {
    const db = await getDb();
    await runAllMigrations(db, process.env.DB_DRIVER as DbDriver);
    for (const id of [siteId, otherSite]) {
      const tenantId = randomUUID();
      await db.run("INSERT INTO tenants (id, slug, name, status) VALUES (?, ?, ?, 'active')", [tenantId, `t-${tenantId}`, "Builder"]);
      await db.run("INSERT INTO sites (id, tenant_id, name, url) VALUES (?, ?, ?, ?)", [id, tenantId, "Builder", `https://${id}.example`]);
    }
  }, 60_000);

  afterAll(async () => {
    await (await getDb()).close();
  });

  it("bumps template part revisions and refuses stale writes without writing", async () => {
    expect(await saveTemplatePartDraft(siteId, "footer", { mine: 1 }, 0)).toBe(1);
    expect(await saveTemplatePartDraft(siteId, "footer", { mine: 2 }, 1)).toBe(2);
    await expect(saveTemplatePartDraft(siteId, "footer", { stale: true }, 1)).rejects.toBeInstanceOf(DocumentRevisionConflictError);
    await expect(publishTemplatePartDoc(siteId, "footer", { first: true }, 0)).rejects.toMatchObject({ actualRevision: 2 });
    const docs = await getTemplatePartDocs(siteId, "footer");
    expect(docs).toMatchObject({ draft: { mine: 2 }, revision: 2 });
    expect(await publishTemplatePartDoc(siteId, "footer", { live: true }, 2)).toBe(3);
    expect(await getTemplatePartDocs(siteId, "footer")).toMatchObject({ doc: { live: true }, draft: null, revision: 3 });
    /** Unchecked writes still work and still bump the revision. */
    expect(await saveTemplatePartDraft(siteId, "footer", { legacy: true })).toBe(4);
  });

  it("lets exactly one of two concurrent first saves win", async () => {
    const results = await Promise.allSettled([
      saveTemplatePartDraft(siteId, "header", { a: 1 }, 0),
      saveTemplatePartDraft(siteId, "header", { b: 1 }, 0),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("lets exactly one of two concurrent updates from the same revision win", async () => {
    const start = await saveTemplatePartDraft(siteId, "widgets:sidebar", { v: 0 }, 0);
    const results = await Promise.allSettled([
      saveTemplatePartDraft(siteId, "widgets:sidebar", { v: "a" }, start),
      saveTemplatePartDraft(siteId, "widgets:sidebar", { v: "b" }, start),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getTemplatePartDocs(siteId, "widgets:sidebar")).revision).toBe(start + 1);
  });

  it("checks theme template revisions per theme and slug", async () => {
    expect(await saveThemeTemplateDraft(siteId, "acme.theme", "single", { version: 1, blocks: [] }, 0)).toBe(1);
    await expect(saveThemeTemplateDraft(siteId, "acme.theme", "single", { stale: 1 }, 0)).rejects.toBeInstanceOf(DocumentRevisionConflictError);
    expect(await saveThemeTemplateDraft(siteId, "other.theme", "single", { version: 1, blocks: [] }, 0)).toBe(1);
    expect((await getThemeTemplateDocs(siteId, "acme.theme", "single")).revision).toBe(1);
  });

  it("records, prunes, lists, and scopes document history", async () => {
    for (let revision = 1; revision <= DOCUMENT_HISTORY_LIMIT + 3; revision++) {
      await recordDocumentHistory({ siteId, kind: "template_part", key: "footer", revision, state: "draft", doc: { revision } });
    }
    const items = await listDocumentHistory(siteId, "template_part", "footer");
    expect(items).toHaveLength(DOCUMENT_HISTORY_LIMIT);
    expect(items[0]!.revision).toBe(DOCUMENT_HISTORY_LIMIT + 3);
    expect(await getDocumentHistoryDoc(siteId, "template_part", "footer", items[0]!.id)).toEqual({ revision: DOCUMENT_HISTORY_LIMIT + 3 });
    expect(await getDocumentHistoryDoc(otherSite, "template_part", "footer", items[0]!.id)).toBeNull();
    expect(await getDocumentHistoryDoc(siteId, "template_part", "header", items[0]!.id)).toBeNull();
    expect(await listDocumentHistory(otherSite, "template_part", "footer")).toEqual([]);
  }, 30_000);

  it("keeps every concurrent change to a list setting", async () => {
    await setSiteSetting(siteId, "builder_list", []);
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        updateSiteSettingAtomically<string[]>(siteId, "builder_list", (current) => [...(current ?? []), `item-${i}`]),
      ),
    );
    expect(((await getSiteSetting<string[]>(siteId, "builder_list")) ?? []).sort()).toEqual(["item-0", "item-1", "item-2", "item-3"]);
  });

  it("creates a missing list setting and updates a stored JSON null", async () => {
    expect(await updateSiteSettingAtomically<string[]>(siteId, "builder_new", (current) => [...(current ?? []), "a"])).toEqual(["a"]);
    await setSiteSetting(siteId, "builder_null", null);
    expect(await updateSiteSettingAtomically<string[]>(siteId, "builder_null", (current) => [...(current ?? []), "b"])).toEqual(["b"]);
    expect(await getSiteSetting(siteId, "builder_null")).toEqual(["b"]);
  });

  it("updates a list stored as real JSON rather than through setSiteSetting", async () => {
    const db = await getDb();
    const driver = process.env.DB_DRIVER;
    const cast = driver === "postgres" ? "?::text::jsonb" : driver === "mysql" ? "CAST(? AS JSON)" : "?";
    const keyColumn = driver === "postgres" ? "key" : "`key`";
    await db.run(
      `INSERT INTO site_settings (id, site_id, ${keyColumn}, value, updated_at) VALUES (?, ?, 'builder_raw', ${cast}, CURRENT_TIMESTAMP)`,
      [randomUUID(), siteId, JSON.stringify(["x"])],
    );
    expect(await updateSiteSettingAtomically<string[]>(siteId, "builder_raw", (current) => [...(current ?? []), "y"])).toEqual(["x", "y"]);
    expect(await getSiteSetting(siteId, "builder_raw")).toEqual(["x", "y"]);
  });
});
