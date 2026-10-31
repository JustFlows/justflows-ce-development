// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const limits = new Map<string, number>();
let rootId: string | null = "root-site";

vi.mock("../../../src/lib/tenancy/quotas.js", () => ({
  quotaLimitMap: async () => limits,
  enforceQuota: async () => null,
}));
vi.mock("../../../src/lib/tenancy/registry.js", () => ({
  installationRootSiteId: async () => rootId,
}));
vi.mock("../../../src/lib/domains/domain-settings.js", () => ({
  cachedDomainSettings: async () => ({ enabled: true }),
}));

import { disabledAdminPaths } from "../../../src/lib/tenancy/site-features.js";

describe("Settings → Storage and the own-storage switch", () => {
  beforeEach(() => {
    limits.clear();
    rootId = "root-site";
  });

  it("is removed from a website whose plan turns own storage off", async () => {
    limits.set("feature.ownStorage", 0);
    expect(await disabledAdminPaths("customer-site")).toContain("/admin/settings/storage");
  });

  it("stays when the switch is on or not set", async () => {
    expect(await disabledAdminPaths("customer-site")).not.toContain("/admin/settings/storage");
    limits.set("feature.ownStorage", 1);
    expect(await disabledAdminPaths("customer-site")).not.toContain("/admin/settings/storage");
  });

  it("always stays on the root site, which sets the platform's storage", async () => {
    limits.set("feature.ownStorage", 0);
    expect(await disabledAdminPaths("root-site")).not.toContain("/admin/settings/storage");
  });

  it("hides a plugin's pages on a website whose plugin switch is turned off", async () => {
    expect(await disabledAdminPaths("customer-site")).not.toContain("/admin/plugins/justflows.example");
    limits.set("justflows.example.enabled", 1);
    expect(await disabledAdminPaths("customer-site")).not.toContain("/admin/plugins/justflows.example");
    limits.set("justflows.example.enabled", 0);
    expect(await disabledAdminPaths("customer-site")).toContain("/admin/plugins/justflows.example");
  });

  it("ignores an off switch whose key is not a plugin id", async () => {
    limits.set("../evil.enabled", 0);
    limits.set("feature.enabled", 0);
    expect((await disabledAdminPaths("customer-site")).some((path) => path.startsWith("/admin/plugins/"))).toBe(false);
  });
});
