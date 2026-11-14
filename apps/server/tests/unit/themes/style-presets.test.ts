// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Style preset storage (justflows-ce#301): draft and publish on top of the
 * atomic list setting, and the usage scan behind the impact summary.
 */

const settings = new Map<string, unknown>();
const queries: { sql: string; params: unknown[] }[] = [];
let contentRows: Record<string, unknown>[] = [];

vi.mock("../../../src/lib/settings/site-settings.js", () => ({
  getSiteSetting: async (_site: string, key: string) => settings.get(key) ?? null,
  updateSiteSettingAtomically: async (_site: string, key: string, mutate: (current: unknown) => unknown) => {
    const next = mutate(settings.get(key) ?? null);
    settings.set(key, next);
    return next;
  },
}));
vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (/FROM content/.test(sql)) return contentRows;
      /** PostgreSQL's jsonb text form puts a space after each colon; the scan must still match. */
      if (/FROM template_parts/.test(sql)) return [{ part: "footer", doc: '{"blocks": [{"props": {"styleRef": "card"}}]}', draft_doc: null }];
      if (/FROM theme_templates/.test(sql)) return [];
      if (/FROM menus/.test(sql)) return [];
      return [];
    },
  }),
}));

const mod = await import("../../../src/lib/themes/style-presets.js");

beforeEach(() => {
  settings.clear();
  queries.length = 0;
  contentRows = [];
});

describe("style preset drafts", () => {
  it("saves into a draft seeded from the published list, and publishes the draft", async () => {
    settings.set(mod.STYLE_PRESETS_KEY, [{ id: "card", name: "Card", style: { radius: "md" } }]);
    await mod.saveStylePreset("s1", { id: "hero", name: "Hero", style: { padTop: "7", css: "evil{}" } });

    expect((await mod.listStylePresets("s1")).map((p) => p.id)).toEqual(["card"]);
    const draft = await mod.listStylePresets("s1", { draft: true });
    expect(draft.map((p) => p.id)).toEqual(["card", "hero"]);
    expect(draft[1]!.style).toEqual({ padTop: "7" });
    expect(await mod.stylePresetsHaveDraft("s1")).toBe(true);

    const published = await mod.publishStylePresets("s1");
    expect(published.map((p) => p.id)).toEqual(["card", "hero"]);
    expect(await mod.stylePresetsHaveDraft("s1")).toBe(false);
    expect(await mod.listStylePresets("s1", { draft: true })).toEqual(published);
  });

  it("replaces a preset with the same id, deletes from the draft, and discards the draft", async () => {
    await mod.saveStylePreset("s1", { id: "card", name: "Card", style: { radius: "md" } });
    await mod.publishStylePresets("s1");
    await mod.saveStylePreset("s1", { id: "card", name: "Card v2", style: { radius: "lg" } });
    expect((await mod.listStylePresets("s1", { draft: true }))[0]).toMatchObject({ name: "Card v2", style: { radius: "lg" } });
    expect((await mod.listStylePresets("s1"))[0]).toMatchObject({ name: "Card", style: { radius: "md" } });

    await mod.discardStylePresetDraft("s1");
    expect((await mod.listStylePresets("s1", { draft: true }))[0]).toMatchObject({ name: "Card" });

    await mod.deleteStylePreset("s1", "card");
    expect(await mod.listStylePresets("s1", { draft: true })).toEqual([]);
    expect((await mod.listStylePresets("s1")).map((p) => p.id)).toEqual(["card"]);
  });

  it("refuses an invalid preset", async () => {
    await expect(mod.saveStylePreset("s1", { id: "Bad id", name: "x", style: {} })).rejects.toThrow(/Invalid/);
  });
});

describe("stylePresetUsage", () => {
  it("counts content by type and lists parts, templates, reusable blocks and patterns", async () => {
    const uses = (styleRef: string) => JSON.stringify({ version: 1, blocks: [{ type: "core.group", props: { styleRef } }] });
    contentRows = [
      { id: "a", title: "A", type: "page", locale: "en", status: "published", author_id: null, blocks: uses("card") },
      { id: "b", title: "B", type: "page", locale: "en", status: "draft", author_id: null, blocks: uses("card") },
      { id: "c", title: "C", type: "page", locale: "en", status: "published", author_id: null, blocks: uses("card") },
      { id: "d", title: "D", type: "post", locale: "en", status: "published", author_id: null, blocks: uses("card") },
      /** Matched by the coarse LIKE (the id appears), but not as a styleRef. */
      { id: "e", title: "card", type: "post", locale: "en", status: "published", author_id: null, blocks: JSON.stringify({ blocks: [{ props: { text: '"card"' } }] }) },
    ];
    settings.set("reusable_blocks", [
      { id: "r1", blocks: [{ type: "core.group", props: { styleRef: "card" } }] },
      { id: "r2", blocks: [{ type: "core.group", props: { styleRef: "other" } }] },
    ]);
    settings.set("block_patterns", [{ id: "p1", blocks: { en: [{ props: { styleRef: "card" } }] } }]);
    const usage = await mod.stylePresetUsage("s1", "card");
    expect(usage).toEqual({
      content: { page: 3, post: 1 },
      templateParts: ["footer"],
      templates: [],
      reusableBlocks: 1,
      patterns: 1,
      total: 7,
    });
    /** One bounded query per table, each filtering on the quoted id, then checked exactly. */
    expect(queries.map((q) => q.params[1])).toEqual(['%"card%', '%"card%', '%"card%', '%"card%']);
    expect(queries.every((q) => /LIMIT \d+/.test(q.sql))).toBe(true);
  });
});
