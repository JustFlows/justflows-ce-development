// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";

/** The shared reference scan behind preset and reusable block usage (justflows-ce#301, #304). */

const queries: string[] = [];
vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (/FROM content/.test(sql)) {
        return [
          { id: "1", title: "Uses it", type: "page", locale: "en", status: "published", author_id: "u", blocks: '{"version": 1, "blocks": [{"type": "core.reusable", "props": {"ref": "cta"}}]}' },
          { id: "2", title: "Only mentions", type: "page", locale: "en", status: "draft", author_id: "u", blocks: { blocks: [{ type: "core.paragraph", props: { ref: "cta" } }] } },
        ];
      }
      if (/FROM menus/.test(sql)) return [{ slug: "main", items: [{ mega: { blocks: [{ type: "core.reusable", props: { ref: "cta" } }] } }] }];
      return [];
    },
  }),
}));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({
  getSiteSetting: async (_s: string, key: string) =>
    key === "reusable_blocks"
      ? [
          { id: "cta", blocks: [] },
          { id: "wrapper", blocks: [{ type: "core.reusable", props: { ref: "cta" } }] },
        ]
      : [],
}));

const { findBlockReferences, mentionsReference } = await import("../../../src/lib/rendering/block-references.js");

afterEach(() => {
  queries.length = 0;
  delete process.env.DB_DRIVER;
});

describe("findBlockReferences", () => {
  it("counts only real core.reusable references, in any JSON shape, and not the source itself", async () => {
    const usage = await findBlockReferences("s", "ref", "cta");
    expect(usage.content.map((c) => c.id)).toEqual(["1"]);
    expect(usage.menus).toEqual(["main"]);
    expect(usage.reusableBlocks).toEqual(["wrapper"]);
    expect(usage.truncated).toBe(false);
  });

  it("compares JSON columns as text for the database in use", async () => {
    process.env.DB_DRIVER = "postgres";
    await findBlockReferences("s", "ref", "cta");
    expect(queries[0]).toContain("CAST(blocks AS TEXT) LIKE ?");
    queries.length = 0;
    process.env.DB_DRIVER = "mysql";
    await findBlockReferences("s", "ref", "cta");
    expect(queries[0]).toContain("CAST(blocks AS CHAR) LIKE ?");
  });

  it("matches styleRef on any block", () => {
    expect(mentionsReference({ blocks: [{ type: "core.group", props: { styleRef: "card" } }] }, "styleRef", "card")).toBe(true);
    expect(mentionsReference({ blocks: [{ type: "core.group", props: { styleRef: "cards" } }] }, "styleRef", "card")).toBe(false);
  });
});

describe("mentionsReference on encoded storage", () => {
  it("reads documents stored as JSON text, even when encoded twice", () => {
    const doc = { blocks: [{ type: "core.reusable", props: { ref: "cta" } }] };
    expect(mentionsReference(JSON.stringify(doc), "ref", "cta")).toBe(true);
    expect(mentionsReference(JSON.stringify(JSON.stringify(doc)), "ref", "cta")).toBe(true);
    expect(mentionsReference("not json", "ref", "cta")).toBe(false);
  });
});
