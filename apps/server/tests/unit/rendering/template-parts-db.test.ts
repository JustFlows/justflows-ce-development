import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DB_DRIVER = "postgres";

// In-memory stand-in for the template_parts table, keyed by (site_id, part).
const table = new Map<string, { doc: string; draft_doc: string | null; revision: number }>();
const key = (site: unknown, part: unknown) => `${site}::${part}`;

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    async query(sql: string, params: unknown[] = []) {
      if (/SELECT doc, draft_doc, revision FROM template_parts/i.test(sql)) {
        const row = table.get(key(params[0], params[1]));
        return row ? [row] : [];
      }
      return [];
    },
    async run(sql: string, params: unknown[] = []) {
      if (!/INSERT INTO template_parts/i.test(sql)) return;
      // params: [id, site, part, docJson, draftJson, stamp, stamp]
      const [, site, part, docJson, draftJson] = params as string[];
      const k = key(site, part);
      const existing = table.get(k);
      const setsDoc = /doc = EXCLUDED\.doc/.test(sql);
      const setsDraft = /draft_doc = EXCLUDED\.draft_doc/.test(sql);
      if (!existing) {
        table.set(k, { doc: docJson ?? "{}", draft_doc: draftJson ?? null, revision: 1 });
        return;
      }
      /** A plain INSERT (no upsert clause) hits the unique key, as the real table would. */
      if (!/ON CONFLICT/i.test(sql)) throw new Error("duplicate key");
      table.set(k, {
        doc: setsDoc ? (docJson ?? "{}") : existing.doc,
        draft_doc: setsDraft ? (draftJson ?? null) : existing.draft_doc,
        revision: existing.revision + 1,
      });
    },
    async execute(sql: string, params: unknown[] = []) {
      if (!/UPDATE template_parts SET/i.test(sql)) return 0;
      const values = [...params];
      const expected = values.pop() as number;
      const part = values.pop();
      const site = values.pop();
      const row = table.get(key(site, part));
      if (!row || row.revision !== expected) return 0;
      const next = { ...row, revision: row.revision + 1 };
      let i = 0;
      if (/doc = \?/.test(sql.replace(/draft_doc = \?/, ""))) next.doc = values[i++] as string;
      if (/draft_doc = \?/.test(sql)) next.draft_doc = values[i++] as string | null;
      table.set(key(site, part), next);
      return 1;
    },
  }),
}));

const {
  getTemplatePartDoc,
  getTemplatePartDocs,
  templatePartHasDraft,
  saveTemplatePartDraft,
  saveTemplatePartPublished,
  publishTemplatePartDoc,
  clearTemplatePartDraftDoc,
  seedTemplatePartRow,
} = await import("../../../src/lib/rendering/template-parts-db.js");

const SITE = "site-1";
beforeEach(() => table.clear());

describe("template-parts-db", () => {
  it("returns null for an unknown part", async () => {
    expect(await getTemplatePartDoc(SITE, "footer")).toBeNull();
    expect(await getTemplatePartDocs(SITE, "footer")).toEqual({ doc: null, draft: null, revision: 0 });
    expect(await templatePartHasDraft(SITE, "footer")).toBe(false);
  });

  it("a draft save leaves the published doc untouched", async () => {
    await saveTemplatePartPublished(SITE, "footer", { version: 1, blocks: ["live"] });
    await saveTemplatePartDraft(SITE, "footer", { version: 1, blocks: ["wip"] });
    expect(await getTemplatePartDoc(SITE, "footer")).toEqual({ version: 1, blocks: ["live"] });
    expect(await getTemplatePartDoc(SITE, "footer", { draft: true })).toEqual({ version: 1, blocks: ["wip"] });
    expect(await templatePartHasDraft(SITE, "footer")).toBe(true);
  });

  it("publish sets the doc and clears the draft", async () => {
    await saveTemplatePartDraft(SITE, "footer", { version: 1, blocks: ["wip"] });
    await publishTemplatePartDoc(SITE, "footer", { version: 1, blocks: ["final"] });
    expect(await getTemplatePartDoc(SITE, "footer")).toEqual({ version: 1, blocks: ["final"] });
    expect(await templatePartHasDraft(SITE, "footer")).toBe(false);
  });

  it("clearTemplatePartDraftDoc drops only the draft", async () => {
    await saveTemplatePartPublished(SITE, "header", { a: 1 });
    await saveTemplatePartDraft(SITE, "header", { a: 2 });
    await clearTemplatePartDraftDoc(SITE, "header");
    expect(await getTemplatePartDoc(SITE, "header")).toEqual({ a: 1 });
    expect(await getTemplatePartDoc(SITE, "header", { draft: true })).toBeNull();
  });

  it("seedTemplatePartRow writes doc and draft together", async () => {
    await seedTemplatePartRow(SITE, "footer", { v: "pub" }, { v: "draft" });
    expect(await getTemplatePartDocs(SITE, "footer")).toEqual({ doc: { v: "pub" }, draft: { v: "draft" }, revision: 1 });
    await seedTemplatePartRow(SITE, "header", { v: "pub" }, null);
    expect(await getTemplatePartDocs(SITE, "header")).toEqual({ doc: { v: "pub" }, draft: null, revision: 1 });
  });
});

describe("template-parts-db revisions", () => {
  it("bumps the revision on every write and returns it", async () => {
    expect(await saveTemplatePartDraft(SITE, "footer", { a: 1 })).toBe(1);
    expect(await saveTemplatePartDraft(SITE, "footer", { a: 2 })).toBe(2);
    expect(await publishTemplatePartDoc(SITE, "footer", { a: 3 })).toBe(3);
    expect((await getTemplatePartDocs(SITE, "footer")).revision).toBe(3);
  });

  it("applies a write that names the current revision", async () => {
    await saveTemplatePartDraft(SITE, "footer", { a: 1 });
    expect(await saveTemplatePartDraft(SITE, "footer", { a: 2 }, 1)).toBe(2);
    expect(await getTemplatePartDoc(SITE, "footer", { draft: true })).toEqual({ a: 2 });
  });

  it("refuses a write based on an older revision and leaves the row alone", async () => {
    await saveTemplatePartDraft(SITE, "footer", { mine: false });
    await saveTemplatePartDraft(SITE, "footer", { theirs: true });
    await expect(saveTemplatePartDraft(SITE, "footer", { mine: true }, 1)).rejects.toMatchObject({
      name: "DocumentRevisionConflictError",
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(await getTemplatePartDoc(SITE, "footer", { draft: true })).toEqual({ theirs: true });
  });

  it("treats 0 as 'nobody has saved yet' and refuses when someone has", async () => {
    expect(await publishTemplatePartDoc(SITE, "footer", { first: true }, 0)).toBe(1);
    await expect(publishTemplatePartDoc(SITE, "footer", { second: true }, 0)).rejects.toMatchObject({
      name: "DocumentRevisionConflictError",
      actualRevision: 1,
    });
    expect(await getTemplatePartDoc(SITE, "footer")).toEqual({ first: true });
  });

  it("refuses a revision for a row that does not exist", async () => {
    await expect(saveTemplatePartDraft(SITE, "footer", { a: 1 }, 3)).rejects.toMatchObject({ actualRevision: 0 });
  });
});
