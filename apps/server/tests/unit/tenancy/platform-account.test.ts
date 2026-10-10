// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/database/db.js", () => ({ getControlDb: async () => ({ query }) }));
import { ownerAccount, ownedWorkspace } from "../../../src/lib/tenancy/platform-account.js";
beforeEach(() => query.mockReset());
describe("workspace owner account data", () => {
  it("batches sites for multiple workspaces and strips unsafe navigation URLs", async () => {
    query.mockResolvedValueOnce([{ id: "a", name: "A", status: "active", user_mode: "isolated" }, { id: "b", name: "B", status: "active", user_mode: "isolated" }]);
    query.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: String(i), tenant_id: i < 50 ? "a" : "b", name: `Site ${i}`, url: i === 0 ? "javascript:alert(1)" : "https://site.example.com/", status: "active" })));
    const result = await ownerAccount("owner");
    expect(result[0]?.sites).toHaveLength(50); expect(result[1]?.sites).toHaveLength(50);
    expect(result[0]?.sites[0]?.url).toBeNull(); expect(result[1]?.sites[0]?.url).toBe("https://site.example.com");
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) { expect(sql).toContain("owner_user_id = ?"); expect(params).toEqual(["owner"]); }
  });
  it("scopes detail lookups to both workspace and owner", async () => {
    query.mockResolvedValue([]);
    expect(await ownedWorkspace("owner", "workspace")).toBeNull();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("owner_user_id = ?"), ["workspace", "owner"]);
  });
});
