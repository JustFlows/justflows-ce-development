// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), run: vi.fn(), clear: vi.fn(), purge: vi.fn() }));
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query: mocks.query, run: mocks.run }) }));
vi.mock("../../../src/lib/database/run-migrations.js", () => ({ runAllMigrations: async () => undefined }));
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ getDefaultLocale: async () => "en-US" }));
vi.mock("../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateSelected: mocks.clear }));
vi.mock("../../../src/lib/cdn/cdn-purge.js", () => ({ purgeCdnCache: mocks.purge }));
import { updateContentType } from "../../../src/lib/content/content-types-db.js";

describe("content-type cache settings", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.purge.mockResolvedValue(undefined); mocks.clear.mockResolvedValue(undefined);
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("SELECT slug")) return [{ slug: "page" }, { slug: "post" }, { slug: "account" }];
      if (sql.startsWith("SELECT * FROM content_types")) return [{ id: "type", site_id: params[0], slug: params[1], fields: [], is_builtin: 1, cache_control: null }];
      return [{ id: "existing-account" }]; // seed is already present
    });
  });
  it.each([null, "public, max-age=60", "private, no-store"])("rejects every account override, including %s", async cacheControl => {
    await expect(updateContentType("site-a", "account", { cacheControl })).rejects.toThrow("locked");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("persists validated headers in the selected site and forces invalidation", async () => {
    await updateContentType("site-a", "page", { cacheControl: "PUBLIC, max-age=60" });
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining("WHERE site_id = ? AND slug = ?"), expect.arrayContaining(["public, max-age=60", "site-a", "page"]));
    expect(mocks.clear).toHaveBeenCalledWith(["pages", "content"]);
    expect(mocks.purge).toHaveBeenCalledWith({ siteId: "site-a" });
  });
});
