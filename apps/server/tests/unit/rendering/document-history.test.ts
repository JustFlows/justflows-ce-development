import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let staleIds: string[] = [];
let failInsert = false;

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    async run(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (failInsert && /INSERT INTO document_history/i.test(sql)) throw new Error("db down");
    },
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/SELECT id FROM document_history/i.test(sql)) return staleIds.map((id) => ({ id }));
      if (/SELECT doc FROM document_history/i.test(sql)) return [{ doc: JSON.stringify({ version: 1, blocks: ["old"] }) }];
      return [{ id: "h1", revision: 4, state: "published", created_at: "2026-11-13 10:00:00", created_by: "u1", created_by_name: "Ada" }];
    },
  }),
}));

const { recordDocumentHistory, listDocumentHistory, getDocumentHistoryDoc, DOCUMENT_HISTORY_LIMIT } = await import(
  "../../../src/lib/rendering/document-history.js"
);

beforeEach(() => {
  calls.length = 0;
  staleIds = [];
  failInsert = false;
});

const entry = { siteId: "site-1", kind: "template_part" as const, key: "footer", revision: 5, state: "draft" as const, doc: { a: 1 } };

describe("document history", () => {
  it("records the written document with its revision and author", async () => {
    await recordDocumentHistory({ ...entry, actorId: "u1" });
    const insert = calls.find((c) => /INSERT INTO document_history/i.test(c.sql))!;
    expect(insert.params.slice(1, 8)).toEqual(["site-1", "template_part", "footer", 5, "draft", JSON.stringify({ a: 1 }), "u1"]);
  });

  it("prunes only this document's versions beyond the limit, scoped to the site", async () => {
    staleIds = ["old-1", "old-2"];
    await recordDocumentHistory(entry);
    const select = calls.find((c) => /SELECT id FROM document_history/i.test(c.sql))!;
    expect(select.sql).toContain(`OFFSET ${DOCUMENT_HISTORY_LIMIT}`);
    expect(select.params).toEqual(["site-1", "template_part", "footer"]);
    const del = calls.find((c) => /DELETE FROM document_history/i.test(c.sql))!;
    expect(del.params).toEqual(["site-1", "old-1", "old-2"]);
  });

  it("does not delete anything when nothing is past the limit", async () => {
    await recordDocumentHistory(entry);
    expect(calls.some((c) => /DELETE/i.test(c.sql))).toBe(false);
  });

  it("never fails the save it describes", async () => {
    failInsert = true;
    await expect(recordDocumentHistory(entry)).resolves.toBeUndefined();
  });

  it("lists versions newest first with author names", async () => {
    const items = await listDocumentHistory("site-1", "template_part", "footer");
    expect(items).toEqual([
      { id: "h1", revision: 4, state: "published", createdAt: "2026-11-13T10:00:00Z", createdBy: "u1", createdByName: "Ada" },
    ]);
    expect(calls[0]!.params).toEqual(["site-1", "template_part", "footer"]);
  });

  it("reads one version only within its site and document", async () => {
    expect(await getDocumentHistoryDoc("site-1", "template_part", "footer", "h1")).toEqual({ version: 1, blocks: ["old"] });
    expect(calls[0]!.params).toEqual(["h1", "site-1", "template_part", "footer"]);
  });
});
