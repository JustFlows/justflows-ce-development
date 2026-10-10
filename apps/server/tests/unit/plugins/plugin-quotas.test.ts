import { beforeEach, describe, expect, it, vi } from "vitest";

const setQuotaLimit = vi.fn(async () => undefined);
const listQuotaMeters = vi.fn(async () => [
  { key: "users", scope: "site", label: "Users", unit: "count", limit: 5, used: 2 },
]);
let root: string | null = "root-site";

vi.mock("../../../src/lib/tenancy/registry.js", () => ({
  installationRootSiteId: async () => root,
}));
vi.mock("../../../src/lib/database/db.js", () => ({
  getControlDb: async () => ({
    query: async (_sql: string, params: unknown[]) => (params[0] === "tenant-site" ? [{ tenant_id: "tenant-1" }] : []),
  }),
}));
vi.mock("../../../src/lib/tenancy/quotas.js", () => ({
  checkQuota: vi.fn(),
  listMeterDefinitions: () => [
    { key: "sites", scope: "workspace", label: "Sites", unit: "count", owner: "core" },
    { key: "users", scope: "site", label: "Users", unit: "count", owner: "core" },
  ],
  listQuotaMeters,
  registerPluginMeter: vi.fn(),
  scopeIdForMeter: async () => "own-scope",
  setQuotaLimit,
}));

const { createPluginQuotasApi } = await import("../../../src/lib/plugins/plugin-quotas.js");

describe("plugin quotas for another workspace", () => {
  beforeEach(() => {
    root = "root-site";
    setQuotaLimit.mockClear();
  });

  it("sets a site meter on the target site and a workspace meter on that site's workspace", async () => {
    const api = createPluginQuotasApi("justflows.shop", new Set(["platform:tenancy"]), "root-site");
    await api.set("users", 10, { siteId: "tenant-site" });
    await api.set("sites", 3, { siteId: "tenant-site" });
    await api.set("sites", 4, { tenantId: "tenant-1" });
    expect(setQuotaLimit.mock.calls).toEqual([
      ["site", "tenant-site", "users", 10, null],
      ["workspace", "tenant-1", "sites", 3, null],
      ["workspace", "tenant-1", "sites", 4, null],
    ]);
    await expect(api.set("users", 1, { tenantId: "tenant-1" })).rejects.toThrow(/per site/);
    await expect(api.get("users", { siteId: "tenant-site" })).resolves.toMatchObject({ limit: 5, used: 2 });
  });

  it("refuses a target from a site that is not the root site", async () => {
    root = "root-site";
    const api = createPluginQuotasApi("justflows.shop", new Set(["platform:tenancy"]), "hosted-site");
    await expect(api.set("users", 1000, { siteId: "hosted-site" })).rejects.toThrow(/root site/);
    expect(setQuotaLimit).not.toHaveBeenCalled();
  });

  it("needs platform:tenancy", async () => {
    const api = createPluginQuotasApi("justflows.shop", new Set(), "root-site");
    await expect(api.set("users", 1, { siteId: "tenant-site" })).rejects.toThrow(/platform:tenancy/);
  });

  it("lists every meter with its owner", async () => {
    const api = createPluginQuotasApi("justflows.shop", new Set(), "root-site");
    await expect(api.meters!()).resolves.toEqual([
      { key: "sites", scope: "workspace", label: "Sites", unit: "count", owner: "core" },
      { key: "users", scope: "site", label: "Users", unit: "count", owner: "core" },
    ]);
  });
});
