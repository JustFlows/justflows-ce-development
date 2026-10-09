// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = {
  query: vi.fn(async (_sql: string, _params?: readonly unknown[]): Promise<Array<Record<string, unknown>>> => []),
  run: vi.fn(async (_sql: string, _params?: readonly unknown[]): Promise<void> => undefined),
  transaction: vi.fn(async (fn: (tx: { run: typeof control.run; query: typeof control.query }) => Promise<void>) => {
    await fn(control);
  }),
};

vi.mock("../../../src/lib/database/db.js", () => ({
  getControlDb: async () => control,
  runWithControlDatabase: async (_client: unknown, work: () => Promise<unknown>) => work(),
  getDb: async () => control,
  runWithDatabase: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({
    applyFilter: async (_name: string, value: unknown) => value,
    dispatchAction: async () => undefined,
  }),
}));

vi.mock("../../../src/lib/tenancy/connections.js", () => ({
  separateDatabaseForSite: async () => null,
  borrowSeparateDatabase: async () => null,
}));

const TENANT = "155ca2c8-713b-4e65-a5da-7fd309f088fc";
const SITE = "5e291899-3229-49bb-bc32-bed27379ead6";

describe("quota decisions", () => {
  it("lets a filter tighten a limit and refuses to raise it", async () => {
    const { clampQuotaLimit, quotaDecision } = await import("../../../src/lib/tenancy/quotas.js");
    expect(clampQuotaLimit(10, 4)).toBe(4);
    expect(clampQuotaLimit(10, 20)).toBe(10);
    expect(clampQuotaLimit(10, null)).toBe(10);
    expect(clampQuotaLimit(null, 3)).toBe(3);
    expect(clampQuotaLimit(null, "nope")).toBeNull();
    expect(quotaDecision(2, 1, null)).toEqual({ ok: true, limit: null, used: 2, remaining: null });
    expect(quotaDecision(2, 1, 2).ok).toBe(false);
    expect(quotaDecision(1, 1, 2)).toMatchObject({ ok: true, remaining: 1 });
  });
});

describe("enforceQuota", () => {
  beforeEach(() => {
    control.query.mockReset();
    control.run.mockReset();
  });

  it("allows a create when no limit is stored", async () => {
    control.query.mockImplementation(async (sql: string) => {
      if (sql.includes("quota_limits")) return [];
      if (sql.includes("FROM sites WHERE tenant_id")) return [{ total: 9 }];
      return [];
    });
    const { enforceQuota } = await import("../../../src/lib/tenancy/quotas.js");
    expect(await enforceQuota("sites", TENANT, 1)).toBeNull();
  });

  it("refuses another site when the workspace is at its limit", async () => {
    control.query.mockImplementation(async (sql: string) => {
      if (sql.includes("quota_limits")) return [{ meter_key: "sites", limit_value: 2 }];
      if (sql.includes("FROM sites WHERE tenant_id")) return [{ total: 2 }];
      return [];
    });
    const { enforceQuota } = await import("../../../src/lib/tenancy/quotas.js");
    const block = await enforceQuota("sites", TENANT, 1);
    expect(block).toMatchObject({ status: 409, code: "quota_exceeded", meter: "sites" });
  });

  it("rejects a meter on the wrong scope and saves one the plugin registered", async () => {
    const { registerPluginMeter, replaceQuotaLimits, unregisterPluginMeters } = await import("../../../src/lib/tenancy/quotas.js");
    expect(() => registerPluginMeter("acme.shop", { key: "other.products", scope: "site", label: "Products", unit: "count" })).toThrow(/acme\.shop/);
    const dispose = registerPluginMeter("acme.shop", {
      key: "acme.shop.products",
      scope: "site",
      label: "Products",
      unit: "count",
    });
    const wrongScope = await replaceQuotaLimits("workspace", TENANT, { "acme.shop.products": 5 }, null);
    expect(wrongScope).toMatchObject({ ok: false, status: 400 });
    control.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM sites WHERE id")) return [{ id: SITE }];
      if (sql.includes("storage_quota_locks")) return [{ site_id: SITE }];
      if (sql.includes("quota_limits")) return [];
      if (sql.includes("user_mode")) return [{ user_mode: "isolated" }];
      if (sql.includes("COUNT(*)") || sql.includes("SUM(size_bytes)")) return [{ total: 0 }];
      return [];
    });
    const saved = await replaceQuotaLimits("site", SITE, { "acme.shop.products": 5 }, null);
    expect(saved.ok).toBe(true);
    expect(control.run).toHaveBeenCalled();
    dispose();
    unregisterPluginMeters("acme.shop");
  });
});

describe("quota defaults", () => {
  beforeEach(() => {
    control.query.mockReset();
    control.run.mockReset();
  });

  it("stores a workspace default and copies it onto a new workspace", async () => {
    let stored: unknown = null;
    control.query.mockImplementation(async (sql: string) => {
      if (sql.includes("platform_settings")) return stored == null ? [] : [{ value: stored }];
      if (sql.includes("quota_limits")) return [];
      return [];
    });
    control.run.mockImplementation(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("platform_settings")) stored = params?.[1];
    });
    const { applyQuotaDefaults, replaceQuotaDefaults } = await import("../../../src/lib/tenancy/quotas.js");
    const wrong = await replaceQuotaDefaults("workspace", { users: 3 }, null);
    expect(wrong).toMatchObject({ ok: false, status: 400 });
    const saved = await replaceQuotaDefaults("workspace", { sites: 4 }, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.meters.find((meter) => meter.key === "sites")?.limit).toBe(4);

    await applyQuotaDefaults("workspace", TENANT);
    const insert = control.run.mock.calls.find((call) => String(call[0]).includes("INSERT INTO quota_limits"));
    expect(insert?.[1]).toEqual([
      "workspace",
      TENANT,
      "sites",
      4,
      expect.any(String),
    ]);
  });

  it("clears a default back to unlimited and does not copy it", async () => {
    let stored: unknown = JSON.stringify({ workspace: { sites: 4 }, site: {} });
    control.query.mockImplementation(async (sql: string) => {
      if (sql.includes("platform_settings")) return [{ value: stored }];
      return [];
    });
    control.run.mockImplementation(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("platform_settings")) stored = params?.[1];
    });
    const { applyQuotaDefaults, replaceQuotaDefaults } = await import("../../../src/lib/tenancy/quotas.js");
    const saved = await replaceQuotaDefaults("workspace", { sites: null }, null);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.meters.find((meter) => meter.key === "sites")?.limit).toBeNull();
    control.run.mockClear();
    await applyQuotaDefaults("workspace", TENANT);
    expect(control.run.mock.calls.some((call) => String(call[0]).includes("quota_limits"))).toBe(false);
  });

  it("lists a plugin content type on website defaults and copies that limit", async () => {
    let stored: unknown = null;
    control.query.mockImplementation(async (sql: string) => {
      if (sql.includes("platform_settings")) return stored == null ? [] : [{ value: stored }];
      if (sql.includes("FROM sites WHERE status")) return [{ id: SITE }];
      if (sql.includes("JOIN tenants")) return [{ tenant_id: TENANT, database_choice: "current", database_mode: "current" }];
      if (sql.includes("FROM content_types")) return [{ slug: "product", label: "Product" }, { slug: "post", label: "Post" }];
      if (sql.includes("quota_limits")) return [];
      return [];
    });
    control.run.mockImplementation(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("platform_settings")) stored = params?.[1];
    });
    const { applyQuotaDefaults, listQuotaDefaultMeters, replaceQuotaDefaults } = await import("../../../src/lib/tenancy/quotas.js");
    const listed = await listQuotaDefaultMeters("site");
    expect(listed.some((meter) => meter.key === "content.product" && meter.label === "Product")).toBe(true);
    expect(listed.filter((meter) => meter.key === "content.post")).toHaveLength(1);

    const saved = await replaceQuotaDefaults("site", { "content.product": 12 }, null);
    expect(saved.ok).toBe(true);
    await applyQuotaDefaults("site", SITE);
    const insert = control.run.mock.calls.find((call) => String(call[0]).includes("INSERT INTO quota_limits") && String(call[1]).includes("content.product"));
    expect(insert?.[1]).toEqual(["site", SITE, "content.product", 12, expect.any(String)]);
  });

  it("treats a feature left unset as on and a stored zero as off", async () => {
    control.query.mockImplementation(async (sql: string) => {
      if (sql.includes("quota_limits") && sql.includes("feature.comments")) return [];
      if (sql.includes("quota_limits")) return [{ meter_key: "feature.comments", limit_value: 0 }];
      return [];
    });
    const { enforceQuota } = await import("../../../src/lib/tenancy/quotas.js");
    control.query.mockImplementation(async (sql: string) => (sql.includes("quota_limits") ? [] : []));
    expect(await enforceQuota("feature.comments", SITE, 0)).toBeNull();
    control.query.mockImplementation(async (sql: string) => (
      sql.includes("quota_limits") ? [{ meter_key: "feature.comments", limit_value: 0 }] : []
    ));
    expect(await enforceQuota("feature.comments", SITE, 0)).toMatchObject({ status: 403, code: "feature_disabled" });
  });
});
