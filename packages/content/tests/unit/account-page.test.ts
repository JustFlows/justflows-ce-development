// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_BLOCKS, seedAccountPage } from "../../src/service/account-page.js";
import { contentTypePolicy } from "../../src/service/content-types.js";

describe("core account page", () => {
  it("always enforces privacy by type", () => {
    expect(contentTypePolicy("account")).toEqual({ requiresAuthentication: true, cacheable: false, publiclyDiscoverable: false, exportable: false });
    expect(contentTypePolicy("page").cacheable).toBe(true);
  });
  it("seeds a default builder document for the site's locale", async () => {
    const db = { query: vi.fn().mockResolvedValue([]), run: vi.fn().mockResolvedValue(undefined) };
    await seedAccountPage(db, "site-a", "nl-NL");
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining("'account', 'published'"), [expect.any(String), "site-a", JSON.stringify(DEFAULT_ACCOUNT_BLOCKS), "nl-NL", expect.any(String), expect.any(String), expect.any(String)]);
  });
  it.each(["renamed", "draft", "trashed"])("never replaces an existing %s account page", async () => {
    const db = { query: vi.fn().mockResolvedValue([{ id: "existing" }]), run: vi.fn() };
    await seedAccountPage(db, "site-a", "en"); expect(db.run).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("type = 'account'"), ["site-a"]);
  });
});
