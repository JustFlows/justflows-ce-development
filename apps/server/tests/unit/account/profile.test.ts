// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), shared: false }));
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query: mocks.query }) }));
vi.mock("../../../src/lib/tenancy/context.js", () => ({ getTenantContext: () => ({ userMode: mocks.shared ? "shared" : "isolated" }) }));
import { accountProfile } from "../../../src/lib/account/profile.js";
describe("own account profile", () => {
  it("reads safe fields only for the isolated site's user", async () => {
    mocks.shared = false; mocks.query.mockResolvedValue([{ username: "owner", display_name: "Owner" }]);
    expect(await accountProfile("site-a", "user-a")).toEqual({ username: "owner", display_name: "Owner" });
    expect(mocks.query).toHaveBeenLastCalledWith("SELECT username, display_name FROM users WHERE site_id = ? AND id = ? LIMIT 1", ["site-a", "user-a"]);
  });
  it("allows shared membership only within the user's workspace", async () => {
    mocks.shared = true; mocks.query.mockResolvedValue([]);
    expect(await accountProfile("site-b", "user-a")).toBeNull();
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining("current_site.tenant_id = home.tenant_id"), ["site-b", "user-a"]);
    expect(mocks.query.mock.lastCall?.[0]).toContain("m.user_id IS NOT NULL");
  });
});
