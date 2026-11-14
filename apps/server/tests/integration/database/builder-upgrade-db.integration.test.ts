// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/lib/database/db.js";
import { MIGRATION_ORDER, runAllMigrations, type DbDriver } from "../../../src/lib/database/run-migrations.js";
import { getTemplatePartDocs, publishTemplatePartDoc } from "../../../src/lib/rendering/template-parts-db.js";
import { getThemeTemplateDocs } from "../../../src/lib/themes/theme-templates-db.js";
import { listReusableBlocks, resolveReusableBlocks, saveReusableBlock } from "../../../src/lib/rendering/reusable-blocks.js";
import { setSiteSetting } from "../../../src/lib/settings/site-settings.js";
import { serializeContentRow } from "../../../src/lib/content/content-api.js";
import { getRuntimeBlockRegistry } from "../../../src/lib/rendering/runtime-blocks.js";

/**
 * Upgrade drill for Builder 2.0 (justflows-ce#310).
 *
 * A database at the last schema before Builder 2.0 is filled with documents
 * the way the previous version stored them: a page with grid placement,
 * custom CSS, device visibility and a reusable block, a footer, a header
 * library, a template override, and a reusable block library without
 * revisions. Then the Builder 2.0 migrations run. Everything must read back
 * the same, render the same, and accept the new revision checks.
 *
 * It needs an empty database of its own, since it starts from the old schema:
 *
 *   BUILDER_UPGRADE_TEST_DATABASE=1 DB_NAME=builder_upgrade_test DB_DRIVER=postgres|mysql|mariadb \
 *   pnpm vitest run tests/integration/database/builder-upgrade-db.integration.test.ts
 */
const enabled = process.env.BUILDER_UPGRADE_TEST_DATABASE === "1" && process.env.DB_NAME === "builder_upgrade_test";

const BUILDER_MIGRATIONS = ["0057_document_revisions", "0058_document_history"] as const;
const BEFORE_BUILDER = MIGRATION_ORDER.filter((name) => !(BUILDER_MIGRATIONS as readonly string[]).includes(name));

/** A page as the previous builder saved it: no editor metadata, layout in `layout`, raw custom CSS. */
const LEGACY_PAGE = {
  version: 1,
  blocks: [
    {
      id: "grid",
      type: "core.grid",
      version: 1,
      props: { columns: 12, gap: "md" },
      children: [
        { id: "left", type: "core.paragraph", version: 1, props: { text: "Left <em>column</em>", layout: { col: 1, span: 6, row: 1 } } },
        { id: "right", type: "core.heading", version: 1, props: { level: 2, text: "Right", layout: { col: 7, span: 6, row: 1 }, devices: ["desktop"] } },
      ],
    },
    { id: "styled", type: "core.section", version: 1, props: { background: "default", padding: "lg", css: "color: rebeccapurple;", style: { padTop: "4" } }, children: [] },
    { id: "promo-ref", type: "core.reusable", version: 1, props: { ref: "promo" } },
  ],
};
const LEGACY_FOOTER = { version: 1, blocks: [{ id: "f", type: "core.paragraph", version: 1, props: { text: "© Upgrade" } }] };
const LEGACY_HEADER = { entries: [{ id: "main", name: "Main", base: { blocks: [{ id: "h", type: "core.paragraph", version: 1, props: { text: "Header" } }] } }] };
const LEGACY_TEMPLATE = { version: 1, blocks: [{ id: "t", type: "core.post-content", version: 1, props: {} }] };
const LEGACY_REUSABLE = [{ id: "promo", name: "Promo", updatedAt: "2026-01-01T00:00:00.000Z", blocks: [{ id: "r", type: "core.paragraph", version: 1, props: { text: "Old promo" } }] }];

describe.skipIf(!enabled)("Builder 2.0 upgrade drill on a real database", () => {
  const siteId = randomUUID();
  const contentId = randomUUID();
  let before = "";

  const render = async (blocks: unknown[]) => {
    const library = new Map((await listReusableBlocks(siteId)).map((item) => [item.id, item]));
    return getRuntimeBlockRegistry().renderDocument({ blocks: resolveReusableBlocks(blocks as never, library as never, 0, { preview: false }) } as never);
  };

  beforeAll(async () => {
    const db = await getDb();
    const driver = process.env.DB_DRIVER as DbDriver;
    await runAllMigrations(db, driver, BEFORE_BUILDER);
    /** The drill only means something on the old schema: no revision column yet. */
    const oldSchema = await db.query("SELECT revision FROM template_parts LIMIT 1").then(() => false, () => true);
    if (!oldSchema) throw new Error("builder_upgrade_test must start empty: template_parts already has a revision column");

    const tenantId = randomUUID();
    await db.run("INSERT INTO tenants (id, slug, name, status) VALUES (?, ?, ?, 'active')", [tenantId, `t-${tenantId}`, "Upgrade"]);
    await db.run("INSERT INTO sites (id, tenant_id, name, url) VALUES (?, ?, ?, ?)", [siteId, tenantId, "Upgrade", `https://${siteId}.example`]);
    await db.run(
      "INSERT INTO content (id, site_id, type, title, slug, locale, status, blocks, fields) VALUES (?, ?, 'page', 'Legacy', 'legacy', 'en', 'published', ?, '{}')",
      [contentId, siteId, JSON.stringify(LEGACY_PAGE)],
    );
    /** The previous version wrote these rows without a revision column. */
    await db.run("INSERT INTO template_parts (id, site_id, part, doc) VALUES (?, ?, 'footer', ?)", [randomUUID(), siteId, JSON.stringify(LEGACY_FOOTER)]);
    await db.run("INSERT INTO template_parts (id, site_id, part, doc) VALUES (?, ?, 'header', ?)", [randomUUID(), siteId, JSON.stringify(LEGACY_HEADER)]);
    await db.run("INSERT INTO theme_templates (id, site_id, theme_id, slug, doc) VALUES (?, ?, 'justflows.default', 'page', ?)", [randomUUID(), siteId, JSON.stringify(LEGACY_TEMPLATE)]);
    await setSiteSetting(siteId, "reusable_blocks", LEGACY_REUSABLE);

    const row = (await db.query<Record<string, unknown>>("SELECT * FROM content WHERE id = ?", [contentId]))[0]!;
    before = await render((serializeContentRow(row).blocks as { blocks: unknown[] }).blocks);

    await runAllMigrations(db, driver, BUILDER_MIGRATIONS);
  }, 120_000);

  afterAll(async () => {
    await (await getDb()).close();
  });

  it("keeps pages exactly as they were, and renders them the same", async () => {
    const db = await getDb();
    const row = (await db.query<Record<string, unknown>>("SELECT * FROM content WHERE id = ?", [contentId]))[0]!;
    const blocks = (serializeContentRow(row).blocks as { blocks: unknown[] }).blocks;
    expect(blocks).toEqual(LEGACY_PAGE.blocks);
    const after = await render(blocks);
    expect(after).toBe(before);
    expect(after).toContain("Old promo");
    expect(after).toContain("rebeccapurple");
  });

  it("reads the footer, header library and template override with a starting revision", async () => {
    expect(await getTemplatePartDocs(siteId, "footer")).toMatchObject({ doc: LEGACY_FOOTER, draft: null, revision: 1 });
    expect(await getTemplatePartDocs(siteId, "header")).toMatchObject({ doc: LEGACY_HEADER, revision: 1 });
    expect(await getThemeTemplateDocs(siteId, "justflows.default", "page")).toMatchObject({ doc: LEGACY_TEMPLATE, revision: 1 });
  });

  it("reads the old reusable block library, and saves to it with revision checks", async () => {
    const [promo] = await listReusableBlocks(siteId);
    expect(promo).toMatchObject({ id: "promo", name: "Promo", blocks: LEGACY_REUSABLE[0]!.blocks });
    const saved = await saveReusableBlock(siteId, { id: "promo", blocks: [{ id: "r", type: "core.paragraph", version: 1, props: { text: "New promo" } }] }, { expectedRevision: promo!.revision });
    expect(saved.revision).toBe(promo!.revision + 1);
  });

  it("accepts revision-checked saves on upgraded parts, and refuses stale ones", async () => {
    expect(await publishTemplatePartDoc(siteId, "footer", LEGACY_FOOTER, 1)).toBe(2);
    await expect(publishTemplatePartDoc(siteId, "footer", LEGACY_FOOTER, 1)).rejects.toMatchObject({ actualRevision: 2 });
  });

  it("can run the Builder 2.0 migrations again without changing anything", async () => {
    const db = await getDb();
    await runAllMigrations(db, process.env.DB_DRIVER as DbDriver, BUILDER_MIGRATIONS);
    expect(await getTemplatePartDocs(siteId, "footer")).toMatchObject({ revision: 2 });
  });
});
