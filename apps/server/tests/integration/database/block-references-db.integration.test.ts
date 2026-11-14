// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/lib/database/db.js";
import { runAllMigrations, type DbDriver } from "../../../src/lib/database/run-migrations.js";
import { setSiteSetting } from "../../../src/lib/settings/site-settings.js";
import { publishTemplatePartDoc, saveTemplatePartDraft } from "../../../src/lib/rendering/template-parts-db.js";
import { saveThemeTemplateDraft } from "../../../src/lib/themes/theme-templates-db.js";
import { findBlockReferences } from "../../../src/lib/rendering/block-references.js";
import { stylePresetUsage } from "../../../src/lib/themes/style-presets.js";
import {
  getReusableBlock,
  listReusableBlocks,
  publishReusableDraft,
  saveReusableBlock,
} from "../../../src/lib/rendering/reusable-blocks.js";
import { listDocumentHistory } from "../../../src/lib/rendering/document-history.js";

/**
 * Reference scans and reusable block drafts on a real database
 * (justflows-ce#301, #304). JSON columns differ per driver (PostgreSQL JSONB
 * prints spaces after colons; MySQL and MariaDB JSON do too or not), so the
 * coarse LIKE and the exact check are proven here, not only against mocks.
 *
 *   BUILDER_TEST_DATABASE=1 DB_NAME=builder_test DB_DRIVER=postgres|mysql|mariadb \
 *   pnpm vitest run tests/integration/database/block-references-db.integration.test.ts
 */
const enabled = process.env.BUILDER_TEST_DATABASE === "1" && process.env.DB_NAME === "builder_test";

describe.skipIf(!enabled)("block references on a real database", () => {
  const siteId = randomUUID();
  const otherSite = randomUUID();
  const doc = (blocks: unknown[]) => JSON.stringify({ version: 1, blocks });
  const reusableRef = (ref: string) => ({ id: randomUUID(), type: "core.reusable", version: 1, props: { ref } });
  const styled = (styleRef: string) => ({ id: randomUUID(), type: "core.group", version: 1, props: { styleRef } });

  async function insertContent(site: string, title: string, status: string, blocks: unknown[]): Promise<string> {
    const id = randomUUID();
    await (await getDb()).run(
      "INSERT INTO content (id, site_id, type, title, slug, locale, status, blocks, fields) VALUES (?, ?, 'page', ?, ?, 'en', ?, ?, '{}')",
      [id, site, title, `${title.toLowerCase().replace(/\s+/g, "-")}-${id.slice(0, 6)}`, status, doc(blocks)],
    );
    return id;
  }

  beforeAll(async () => {
    const db = await getDb();
    await runAllMigrations(db, process.env.DB_DRIVER as DbDriver);
    for (const id of [siteId, otherSite]) {
      const tenantId = randomUUID();
      await db.run("INSERT INTO tenants (id, slug, name, status) VALUES (?, ?, ?, 'active')", [tenantId, `t-${tenantId}`, "Refs"]);
      await db.run("INSERT INTO sites (id, tenant_id, name, url) VALUES (?, ?, ?, ?)", [id, tenantId, "Refs", `https://${id}.example`]);
    }
  }, 60_000);

  afterAll(async () => {
    await (await getDb()).close();
  });

  it("finds exact reusable references in content, parts, templates, menus and the library, per site", async () => {
    const uses = await insertContent(siteId, "Uses it", "published", [{ id: "s", type: "core.section", version: 1, props: {}, children: [reusableRef("cta")] }]);
    await insertContent(siteId, "Draft use", "draft", [reusableRef("cta")]);
    /** Mentions the id, but not as a reusable reference. */
    await insertContent(siteId, "Lookalike", "published", [{ id: "x", type: "core.paragraph", version: 1, props: { text: '"cta"', ref: "cta" } }]);
    await insertContent(siteId, "Other block", "published", [reusableRef("cta-2")]);
    await insertContent(otherSite, "Other site", "published", [reusableRef("cta")]);

    await saveTemplatePartDraft(siteId, "footer", { version: 1, blocks: [reusableRef("cta")] });
    await publishTemplatePartDoc(siteId, "header", { entries: [{ base: { blocks: [reusableRef("cta")] } }] });
    await saveThemeTemplateDraft(siteId, "justflows.default", "page", { version: 1, blocks: [reusableRef("cta")] });
    await (await getDb()).run("INSERT INTO menus (id, site_id, slug, name, items) VALUES (?, ?, 'main', 'Main', ?)", [
      randomUUID(),
      siteId,
      JSON.stringify([{ label: "Shop", mega: { regions: [{ blocks: [reusableRef("cta")] }] } }]),
    ]);
    await setSiteSetting(siteId, "reusable_blocks", [
      { id: "cta", name: "CTA", blocks: [] },
      { id: "wrapper", name: "Wrapper", blocks: [reusableRef("cta")] },
    ]);

    const usage = await findBlockReferences(siteId, "ref", "cta");
    expect(usage.content.map((c) => c.title).sort()).toEqual(["Draft use", "Uses it"]);
    expect(usage.content.find((c) => c.id === uses)).toMatchObject({ status: "published", type: "page", locale: "en" });
    expect(usage.templateParts.sort()).toEqual(["footer", "header"]);
    expect(usage.templates).toEqual(["page"]);
    expect(usage.menus).toEqual(["main"]);
    expect(usage.reusableBlocks).toEqual(["wrapper"]);
    expect(usage.truncated).toBe(false);
  });

  it("counts style preset use with the same scan", async () => {
    await insertContent(siteId, "Card page", "published", [styled("card"), styled("card-lg")]);
    await insertContent(siteId, "Another card", "published", [styled("card")]);
    const usage = await stylePresetUsage(siteId, "card");
    expect(usage.content).toEqual({ page: 2 });
    expect(usage.total).toBe(2);
  });

  it("keeps reusable block drafts apart from what pages render until publish, and records history", async () => {
    await setSiteSetting(siteId, "reusable_blocks", []);
    const created = await saveReusableBlock(siteId, { id: "promo", name: "Promo", blocks: [{ id: "p", type: "core.paragraph", version: 1, props: { text: "v1" } }] });
    expect(created.revision).toBe(1);
    await saveReusableBlock(siteId, { id: "promo", blocks: [{ id: "p", type: "core.paragraph", version: 1, props: { text: "v2" } }] }, { draft: true, expectedRevision: 1 });
    const stored = await getReusableBlock(siteId, "promo");
    expect(stored!.blocks[0]!.props.text).toBe("v1");
    expect(stored!.draft!.blocks[0]!.props.text).toBe("v2");

    const published = await publishReusableDraft(siteId, "promo", { expectedRevision: 1 });
    expect(published).toMatchObject({ revision: 2, blocks: [{ props: { text: "v2" } }] });
    expect((await listReusableBlocks(siteId)).find((b) => b.id === "promo")!.draft).toBeUndefined();

    const history = await listDocumentHistory(siteId, "reusable_block", "promo");
    /** Versions saved within one second may list in any order on MySQL; the set is what matters. */
    expect(history.map((h) => h.state).sort()).toEqual(["draft", "published", "published"]);
  });
});
