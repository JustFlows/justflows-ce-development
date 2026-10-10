// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ensure: vi.fn(), filter: vi.fn() }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ ensurePluginRuntime: mocks.ensure, getRuntimeHooks: () => ({ applyFilter: mocks.filter }) }));
vi.mock("../../../src/lib/account/profile.js", () => ({ accountProfile: async () => ({ username: "owner", display_name: "Owner" }) }));
import { accountSections, sanitizeAccountSections } from "../../../src/lib/account/sections.js";

describe("account sections", () => {
  it("scopes every dispatch to its authenticated site and user without caching", async () => {
    mocks.filter.mockImplementation((_hook, value) => value);
    const context = { siteId: "site-a", userId: "user-a", email: "a@example.com", role: "customer", installationRoot: false };
    expect((await accountSections(context))[0]?.cards[0]?.fields?.[0]?.value).toBe("a@example.com");
    await accountSections({ ...context, userId: "user-b", email: "b@example.com" });
    expect(mocks.filter).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(mocks.filter.mock.calls[0]?.[2])).toBe(true);
    expect(mocks.filter).toHaveBeenCalledWith("account.sections", expect.any(Array), context,
      { siteId: "site-a", source: "http", actor: { userId: "user-a", role: "customer" } });
  });
  it("bounds contributions, drops duplicates and rejects executable URLs", () => {
    const raw = [{ id: "orders", title: "Orders", cards: [{ title: "One", links: [
      { label: "Bad", href: "javascript:alert(1)" }, { label: "Bad", href: "//evil.example" },
      { label: "Bad", href: "/\\evil.example" }, { label: "Good", href: "/customer-account" },
    ], actions: [{ label: "Bad", endpoint: "/api/users/1/delete" }, { label: "Traversal", endpoint: "/ext/example/account/../../../api/users/1/delete" }, { label: "Good", endpoint: "/api/shop/account/order/1/cancel" }] }] },
      { id: "orders", title: "Duplicate", cards: [] }, { id: "workspace-select", title: "Reserved", cards: [] }];
    const result = sanitizeAccountSections(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.cards[0]?.links).toEqual([{ label: "Good", href: "/customer-account" }]);
    expect(result[0]?.cards[0]?.actions).toEqual([{ label: "Good", endpoint: "/api/shop/account/order/1/cancel", confirm: "" }]);
    expect(sanitizeAccountSections(null)).toEqual([]);
    expect(sanitizeAccountSections(Array.from({ length: 70 }, (_, i) => ({ id: `section${i}`, title: "Section", cards: [] })))).toHaveLength(50);
  });
});
