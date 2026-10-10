import { describe, it, expect } from "vitest";
import { SYNC_FILTERS } from "../../src/hooks.js";

describe("SYNC_FILTERS", () => {
  it("marks analytics.head as a synchronous render-path filter", () => {
    expect(SYNC_FILTERS).toContain("analytics.head");
  });

  it("keeps the existing sync filters", () => {
    expect(SYNC_FILTERS).toEqual(
      expect.arrayContaining([
        "http.responseHeaders",
        "html.head",
        "site.underConstruction.render",
      ]),
    );
  });
});

describe("hook listen permissions", () => {
  it("keeps the workspace admin's email behind platform:tenancy", async () => {
    const { requiredPermissionForHook } = await import("../../src/hooks.js");
    expect(requiredPermissionForHook("tenancy.workspaceCreated")).toBe("platform:tenancy");
    expect(requiredPermissionForHook("workspace.created")).toBeNull();
    expect(requiredPermissionForHook("account.sections")).toBe("users:read");
  });
});
