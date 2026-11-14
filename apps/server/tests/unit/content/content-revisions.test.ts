// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { serializeContentRow } from "../../../src/lib/content/content-api.js";
import { parseRevisionRow, revisionColumn, serializeEditorContent, serializeRevision } from "../../../src/lib/content/content-revisions.js";

const liveRow: Record<string, unknown> = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  site_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  type: "page",
  title: "Live title",
  slug: "live",
  locale: "en",
  translation_group_id: null,
  excerpt: "Live excerpt",
  status: "published",
  blocks: JSON.stringify({ version: 1, blocks: [] }),
  fields: JSON.stringify({ seoTitle: "Live SEO" }),
  author_id: null,
  published_at: "2026-01-01 00:00:00",
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
  version: 3,
};

describe("serializeEditorContent", () => {
  it("returns the live row when there is no working revision", () => {
    const editor = serializeEditorContent(liveRow, null);
    expect(editor.title).toBe("Live title");
    expect(editor.hasWorkingRevision).toBe(false);
    expect(editor.live).toBeNull();
    expect(editor.version).toBe(3);
  });

  it("overlays working revision fields without changing live status or version", () => {
    const working = parseRevisionRow({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      content_id: liveRow.id,
      site_id: liveRow.site_id,
      title: "Draft title",
      slug: "draft",
      excerpt: "Draft excerpt",
      locale: "en",
      translation_group_id: null,
      blocks: { version: 1, blocks: [{ id: "b1", type: "core.paragraph", version: 1, props: { text: "Hi" } }] },
      fields: { seoTitle: "Draft SEO" },
      version: 2,
      base_version: 3,
      kind: "working",
      source: "manual",
      created_at: "2026-02-01 00:00:00",
      created_by: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      updated_at: "2026-02-02 00:00:00",
      updated_by: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      author_name: "Ada",
    });

    const editor = serializeEditorContent(liveRow, working);
    expect(editor.title).toBe("Draft title");
    expect(editor.slug).toBe("draft");
    expect(editor.status).toBe("published");
    expect(editor.version).toBe(3);
    expect(editor.hasWorkingRevision).toBe(true);
    expect(editor.live?.title).toBe("Live title");
    expect(editor.workingRevision?.updatedByName).toBe("Ada");
    expect(editor.workingRevision?.version).toBe(2);
    expect(editor.liveChangedSinceWorking).toBe(false);
  });

  it("flags when live moved under the working draft", () => {
    const working = parseRevisionRow({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      content_id: liveRow.id,
      site_id: liveRow.site_id,
      title: "Draft title",
      slug: "live",
      excerpt: null,
      blocks: { version: 1, blocks: [] },
      fields: {},
      version: 1,
      base_version: 2,
      kind: "working",
      source: "autosave",
      created_at: "2026-02-01 00:00:00",
      updated_at: "2026-02-01 00:00:00",
    });
    expect(serializeEditorContent(liveRow, working).liveChangedSinceWorking).toBe(true);
  });
});

describe("serializeContentRow", () => {
  it("exposes a working-revision flag from a list join", () => {
    const item = serializeContentRow({ ...liveRow, working_revision_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect(item.hasWorkingRevision).toBe(true);
    expect(item.version).toBe(3);
  });
});

describe("revisionColumn", () => {
  const original = process.env.DB_DRIVER;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_DRIVER;
    else process.env.DB_DRIVER = original;
  });

  it("quotes reserved identifiers on MySQL and MariaDB", () => {
    for (const driver of ["mysql", "mariadb"]) {
      process.env.DB_DRIVER = driver;
      expect(revisionColumn("source")).toBe("`source`");
      expect(revisionColumn("kind")).toBe("`kind`");
    }
  });

  it("leaves identifiers bare on PostgreSQL", () => {
    process.env.DB_DRIVER = "postgres";
    expect(revisionColumn("source")).toBe("source");
  });
});
describe("serializeRevision", () => {
  it("omits blocks from the list payload and includes them when requested", () => {
    const rev = parseRevisionRow({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      content_id: liveRow.id,
      site_id: liveRow.site_id,
      title: "V1",
      slug: "v1",
      excerpt: "old",
      blocks: { version: 1, blocks: [{ id: "b1", type: "core.paragraph", version: 1, props: { text: "Hi" } }] },
      fields: { seoTitle: "V1" },
      version: 1,
      kind: "historical",
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
    });
    expect(serializeRevision(rev)).not.toHaveProperty("blocks");
    expect(serializeRevision(rev, { includeBody: true })).toHaveProperty("blocks", rev.blocks);
  });
});
