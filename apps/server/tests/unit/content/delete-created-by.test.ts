// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const run = vi.fn();
const dispatchAction = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({ query, run }),
}));

vi.mock("../../../src/lib/content/home-page.js", () => ({
  clearHomePagesIfMatch: vi.fn(),
}));

vi.mock("../../../src/lib/content/blog-page.js", () => ({
  clearBlogPagesIfMatch: vi.fn(),
}));

vi.mock("../../../src/lib/rendering/error-pages.js", () => ({
  clearErrorPagesIfMatch: vi.fn(),
}));

vi.mock("../../../src/lib/content/content-public.js", () => ({
  invalidateContentCache: vi.fn(),
}));

vi.mock("../../../src/lib/search/search-db.js", () => ({
  indexSearchContent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/lib/media/media-responsive.js", () => ({
  removeVariantDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/lib/security/safe-path.js", () => ({
  resolvePathUnderBase: () => null,
}));

vi.mock("../../../src/lib/runtime/jf-root.js", () => ({
  uploadsDir: () => "/tmp/justflows-uploads",
}));

vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({ dispatchAction }),
}));

import { clearHomePagesIfMatch } from "../../../src/lib/content/home-page.js";
import { deleteRecordsCreatedBy } from "../../../src/lib/content/delete-created-by.js";

function sqlOf(call: unknown[]): string {
  return String(call[0]);
}

describe("deleteRecordsCreatedBy", () => {
  beforeEach(() => {
    query.mockReset();
    run.mockReset();
    dispatchAction.mockReset();
    vi.mocked(clearHomePagesIfMatch).mockReset();
  });

  it("refuses an administrator before deleting anything", async () => {
    query.mockResolvedValueOnce([{ role: "administrator" }]);
    await expect(deleteRecordsCreatedBy("site-1", "admin-1")).resolves.toEqual({
      ok: false,
      error: "Refusing to delete records created by an administrator.",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("deletes only rows that user created", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users")) return [{ role: "demo" }];
      if (sql.includes("FROM content")) return [{ id: "post-1", type: "post" }];
      if (sql.includes("FROM comments")) return [{ id: "comment-1" }];
      if (sql.includes("FROM media")) return [{ id: "media-1", storage_key: "2026/a.jpg" }];
      return [];
    });

    await expect(deleteRecordsCreatedBy("site-1", "demo-1")).resolves.toEqual({
      ok: true,
      content: 1,
      media: 1,
      comments: 1,
    });

    const statements = run.mock.calls.map(sqlOf);
    expect(statements.some((sql) => sql.includes("DELETE FROM users"))).toBe(false);
    expect(statements).toContain(
      "DELETE FROM revisions WHERE site_id = ? AND created_by = ? AND kind IN ('working', 'autosave')",
    );
    expect(run).toHaveBeenCalledWith("DELETE FROM comments WHERE site_id = ? AND user_id = ?", [
      "site-1",
      "demo-1",
    ]);
    expect(run).toHaveBeenCalledWith("DELETE FROM content WHERE site_id = ? AND author_id = ?", [
      "site-1",
      "demo-1",
    ]);
    expect(run).toHaveBeenCalledWith("DELETE FROM media WHERE site_id = ? AND uploaded_by = ?", [
      "site-1",
      "demo-1",
    ]);
    expect(clearHomePagesIfMatch).toHaveBeenCalledWith("site-1", new Set(["post-1"]));
    expect(dispatchAction).toHaveBeenCalledWith(
      "content.deleted",
      { contentId: "post-1", siteId: "site-1", type: "post" },
      { siteId: "site-1", source: "system" },
    );
    expect(dispatchAction).toHaveBeenCalledWith(
      "media.deleted",
      { siteId: "site-1", mediaId: "media-1" },
      { siteId: "site-1", source: "system" },
    );
  });
});
