// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const setting = vi.fn();
const overlay = vi.fn(async (row: Record<string, unknown>) => ({ ...row, title: "Working" }));
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query }) }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteSetting: () => setting() }));
vi.mock("../../../src/lib/content/content-revisions.js", () => ({ overlayWorkingOnRow: (...args: [Record<string, unknown>]) => overlay(...args) }));
import { getHomeContent } from "../../../src/lib/content/home-page.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = { id, site_id: "site-a", type: "page", title: "Home", slug: "home", status: "published", locale: "en", translation_group_id: "group" };
beforeEach(() => {
  vi.clearAllMocks();
  setting.mockResolvedValue(id);
  query.mockReset().mockResolvedValue([row]);
});

describe("home-page resolution", () => {
  it("reuses a usable page in the requested locale even when it belongs to a translation group", async () => {
    expect((await getHomeContent("site-a", "en"))?.id).toBe(id);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("WHERE id = ? AND site_id = ?"), [id, "site-a"]);
  });

  it("still selects a published translation and falls back when one is unavailable", async () => {
    query.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ ...row, id: "translated", locale: "nl" }]);
    expect((await getHomeContent("site-a", "nl"))?.id).toBe("translated");
    expect(query.mock.calls[1]![1]).toEqual(["site-a", "group", "nl"]);
    query.mockReset().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    expect((await getHomeContent("site-a", "nl"))?.id).toBe(id);
  });

  it("retains working overlays for preview but does not serve a draft as the live home", async () => {
    query.mockResolvedValue([{ ...row, status: "draft" }]);
    expect((await getHomeContent("site-a", "en", true))?.title).toBe("Working");
    expect(query).toHaveBeenCalledOnce();
    query.mockReset().mockResolvedValueOnce([{ ...row, status: "draft" }]).mockResolvedValueOnce([]);
    expect(await getHomeContent("site-a", "en", false)).toBeNull();
    expect(overlay).toHaveBeenCalledOnce();
  });
});
