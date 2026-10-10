// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ working: vi.fn(), save: vi.fn(), apply: vi.fn(), invalidate: vi.fn(), purge: vi.fn(), query: vi.fn() }));
vi.mock("../../../src/lib/content/content-revisions.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/lib/content/content-revisions.js")>(),
  getWorkingRevision: mocks.working, upsertWorkingRevision: mocks.save, applySnapshotToContent: mocks.apply,
  insertHistoricalIfChanged: async () => null, archiveThenDeleteWorking: async () => undefined, pruneHistoricalForContent: async () => undefined,
}));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({ dispatchGate: async () => undefined, dispatchAction: async () => undefined, applyFilter: async (_key: string, value: unknown) => value }) }));
vi.mock("../../../src/lib/navigation/permalinks-db.js", () => ({ uniquePermalinkSlug: async (value: { slug: string }) => value.slug, rememberContentPermalink: async () => undefined, PermalinkConflictError: class extends Error {} }));
vi.mock("../../../src/lib/content/content-public.js", () => ({ invalidateContentCache: mocks.invalidate }));
vi.mock("../../../src/lib/cdn/cdn-purge.js", () => ({ purgeCdnCache: mocks.purge }));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog: async () => undefined }));
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query: mocks.query }) }));
import { CreateContentSchema, PatchContentSchema, createContentEntry, publishRow, saveWorkingRow } from "../../../src/lib/content/content-write.js";
const actor = { siteId: "site-a", userId: "owner", role: "administrator" };
const row = { id: "1", site_id: "site-a", type: "post", title: "Post", slug: "post", status: "published", version: 1, fields: {}, blocks: { version: 1, blocks: [] } };
function response() { const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res); return res; }

describe("per-post cache writes", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.working.mockResolvedValue(null); mocks.apply.mockResolvedValue(true);
    mocks.save.mockResolvedValue(null); mocks.purge.mockResolvedValue(undefined); mocks.query.mockResolvedValue([row]);
  });
  it("validates cache fields for admin and management input schemas", () => {
    expect(CreateContentSchema.safeParse({ title: "Post", fields: { cacheControl: "public\r\nHeader: unsafe" } }).success).toBe(false);
    expect(PatchContentSchema.parse({ fields: { cacheControl: "PUBLIC, max-age=60" } }).fields).toEqual({ cacheControl: "public, max-age=60" });
  });
  it("keeps draft overrides in working revisions without changing live caches", async () => {
    const res = response();
    await saveWorkingRow(row, { fields: { cacheControl: "private, no-store" } }, actor, res);
    expect(mocks.save).toHaveBeenCalledWith(row, expect.objectContaining({ snapshot: expect.objectContaining({ fields: { cacheControl: "private, no-store" } }) }));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("forces invalidation and CDN purge when publishing a changed policy", async () => {
    await publishRow(row, { fields: { cacheControl: "private, no-store" } }, actor, response());
    expect(mocks.apply).toHaveBeenCalledWith("1", "site-a", expect.objectContaining({ fields: { cacheControl: "private, no-store" } }), expect.objectContaining({ status: "published" }));
    expect(mocks.invalidate).toHaveBeenCalledWith(true, "site-a");
    expect(mocks.purge).toHaveBeenCalledWith({ siteId: "site-a" });
  });
  it("rejects account overrides in create, draft and publish paths", async () => {
    expect(await createContentEntry({ type: "account", title: "Account", fields: { cacheControl: "public, max-age=60" } }, actor)).toMatchObject({ status: 400 });
    for (const write of [saveWorkingRow, publishRow]) {
      const res = response();
      await write({ ...row, type: "account" }, { fields: { cacheControl: "public, max-age=60" } }, actor, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  });
});
