// SPDX-License-Identifier: MIT
import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), resolve: vi.fn(), factory: vi.fn(), state: vi.fn() }));
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query: mocks.query }) }));
vi.mock("../../../src/lib/navigation/permalinks-db.js", () => ({ createContentPermalinkResolver: mocks.factory, getPermalinkState: mocks.state }));
import { accountPages, accountHomeUrl } from "../../../src/lib/account/pages.js";
beforeEach(() => { vi.clearAllMocks(); mocks.state.mockResolvedValue({ redirects: {} }); mocks.factory.mockResolvedValue(mocks.resolve); mocks.resolve.mockImplementation(content => `/members/${content.slug}`); });
describe("account page URL resolution", () => {
  it("resolves renamed pages and batched metadata without queries inside the loop", async () => {
    mocks.query.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, site_id: "site-a", type: "account", slug: `custom-${i}`, status: "published", locale: "en", created_at: "2026-01-01" })));
    const pages = await accountPages("site-a");
    expect(pages).toHaveLength(100); expect(pages[0]?.url).toBe("/members/custom-0");
    expect(mocks.query).toHaveBeenCalledOnce(); expect(mocks.factory).toHaveBeenCalledExactlyOnceWith("site-a", { state: { redirects: {} } });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("type = 'account'"), ["site-a"]);
  });
  it("does not pick a draft page for the login landing URL", async () => {
    mocks.query.mockResolvedValue([{ id: "draft", site_id: "site-a", type: "account", slug: "draft", status: "draft" }, { id: "live", site_id: "site-a", type: "account", slug: "dashboard", status: "published" }]);
    expect(await accountHomeUrl("site-a")).toBe("/members/dashboard");
  });
  it("uses bounded keyset batches for more than 200 account pages", async () => {
    mocks.query.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}`, site_id: "site-a", type: "account", slug: `page-${i}`, status: "published" }))).mockResolvedValueOnce([]);
    expect(await accountPages("site-a")).toHaveLength(200); expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining("AND id > ?"), ["site-a", "id-199"]);
  });
});


it("retains prior account URLs as private aliases when a page is renamed", async () => {
  mocks.state.mockResolvedValue({ redirects: { "/old-account": "page-a" } });
  mocks.query.mockResolvedValue([{ id: "page-a", site_id: "site-a", type: "account", slug: "new-account", status: "published" }]);
  expect((await accountPages("site-a"))[0]?.aliases).toEqual(["/old-account"]);
});
