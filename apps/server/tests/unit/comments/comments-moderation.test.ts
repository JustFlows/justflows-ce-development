// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const run = vi.fn();
const audit = vi.fn();
const train = vi.fn().mockResolvedValue(undefined);
const notify = vi.fn().mockResolvedValue(undefined);
const invalidate = vi.fn();
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query, run }) }));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog: (...args: unknown[]) => audit(...args) }));
vi.mock("../../../src/lib/comments/comments-rules.js", () => ({ trainFromMark: (...args: unknown[]) => train(...args) }));
vi.mock("../../../src/lib/comments/comments-public.js", () => ({ notifyOnApproval: (...args: unknown[]) => notify(...args) }));
vi.mock("../../../src/lib/cache/public-cache.js", () => ({ invalidatePublicPages: () => invalidate() }));
import { purgeTrashedComments, setCommentStatuses } from "../../../src/lib/comments/comments-moderation.js";
const actor = { siteId: "site-a", userId: "editor" };

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset().mockResolvedValue([]);
  run.mockReset().mockResolvedValue(undefined);
});

describe("batch comment moderation", () => {
  it("trashes in bounded statements while preserving every audit and status guard", async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `comment-${i}`);
    expect(await setCommentStatuses(actor, ids, "trash")).toEqual({ status: 200, body: { ok: true, updated: 401 } });
    expect(query).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [sql, params] of run.mock.calls) {
      expect(sql).toContain("original_status = status");
      expect(sql).toContain("site_id = ?");
      expect(sql).toContain("status != 'trash'");
      expect(params[4]).toBe(actor.siteId);
      expect(params.length).toBeLessThanOrEqual(205);
    }
    expect(audit).toHaveBeenCalledTimes(ids.length);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ siteId: actor.siteId, target: ids[400] }));
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("preserves unspam training and approval notifications", async () => {
    query.mockResolvedValue([{ id: "spam", status: "spam" }, { id: "pending", status: "pending" }]);
    await setCommentStatuses(actor, ["spam", "pending"], "approve");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toContain("trashed_at = NULL, trashed_by = NULL");
    expect(train).toHaveBeenCalledExactlyOnceWith(actor.siteId, "spam", "unspam");
    expect(notify).toHaveBeenCalledExactlyOnceWith(actor.siteId, ["spam", "pending"]);
  });

  it("purges only trashed comments, in bounded batches", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `c${i}`);
    expect(await purgeTrashedComments(actor, ids)).toEqual({ status: 200, body: { ok: true, deleted: 201 } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual([expect.stringContaining("AND status = 'trash'"), [actor.siteId, ...ids.slice(0, 200)]]);
    expect(audit).toHaveBeenCalledTimes(201);
  });

  it("does not issue empty IN statements", async () => {
    await setCommentStatuses(actor, [], "pending");
    await purgeTrashedComments(actor, []);
    expect(query).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not audit a failed delete batch", async () => {
    run.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(purgeTrashedComments(actor, ["c1", "c2"])).rejects.toThrow("database unavailable");
    expect(audit).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
