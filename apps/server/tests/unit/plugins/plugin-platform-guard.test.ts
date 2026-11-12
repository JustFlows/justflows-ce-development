// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host's safety net for platform operations: whatever a plugin's code
 * does, workspaces and limits change only from the root site, only with
 * `platform:tenancy`, and never on behalf of an AI agent or API key.
 */

const state = vi.hoisted(() => ({ root: "root-site" as string | null, site: "root-site" }));
const provision = vi.hoisted(() => ({
  createWorkspace: vi.fn(async () => ({ ok: true, tenantId: "t-new", siteId: "s-new", hostname: "new.example" })),
  createAdditionalSite: vi.fn(async () => ({ ok: true, tenantId: "t-1", siteId: "s-2", hostname: "b.example" })),
  suspendTenant: vi.fn(async () => ({ ok: true, tenantId: "t-1", siteId: "", hostname: "" })),
  reactivateTenant: vi.fn(async () => ({ ok: true, tenantId: "t-1", siteId: "", hostname: "" })),
  deleteTenant: vi.fn(async () => ({ ok: true, tenantId: "t-1", siteId: "", hostname: "" })),
}));
const setQuotaLimit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../../src/lib/tenancy/registry.js", () => ({ installationRootSiteId: async () => state.root }));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => state.site }));
vi.mock("../../../src/lib/tenancy/provision.js", () => provision);
vi.mock("../../../src/lib/database/db.js", () => ({ getControlDb: async () => ({ query: async () => [] }) }));
vi.mock("../../../src/lib/tenancy/quotas.js", () => ({
  checkQuota: vi.fn(),
  listMeterDefinitions: () => [{ key: "users", scope: "site", label: "Users", unit: "count", owner: "core" }],
  listQuotaMeters: vi.fn(async () => []),
  registerPluginMeter: vi.fn(),
  scopeIdForMeter: async () => "own-scope",
  setQuotaLimit,
}));

process.env.JF_MULTISITE = "true";
const { createPluginTenancyApi } = await import("../../../src/lib/plugins/plugin-tenancy.js");
const { createPluginQuotasApi } = await import("../../../src/lib/plugins/plugin-quotas.js");
const { runAsDelegate, DelegatedCallRefused } = await import("../../../src/lib/security/delegated-call.js");

const TENANCY = new Set(["platform:tenancy"] as const);

beforeEach(() => {
  state.root = "root-site";
  state.site = "root-site";
  for (const fn of Object.values(provision)) fn.mockClear();
  setQuotaLimit.mockClear();
});

describe("workspace operations", () => {
  const api = () => createPluginTenancyApi("acme.platform", TENANCY);

  it("run on the root site for a person in the admin", async () => {
    await api().suspend("t-1");
    expect(provision.suspendTenant).toHaveBeenCalledWith("t-1", "plugin:acme.platform");
  });

  it("refuse without platform:tenancy", async () => {
    await expect(createPluginTenancyApi("acme.platform", new Set()).suspend("t-1")).rejects.toThrow(/platform:tenancy/);
    expect(provision.suspendTenant).not.toHaveBeenCalled();
  });

  it("refuse on a hosted site, even with the permission", async () => {
    state.site = "hosted-site";
    for (const call of [
      () => api().listWorkspaces(),
      () => api().listSites("t-1"),
      () => api().suspend("t-1"),
      () => api().reactivate("t-1"),
      () => api().deleteWorkspace("t-1"),
    ]) {
      await expect(call()).rejects.toThrow(/root site/);
    }
    expect(provision.suspendTenant).not.toHaveBeenCalled();
    expect(provision.deleteTenant).not.toHaveBeenCalled();
  });

  it.each(["mcp", "assistant", "api-key", "oauth"] as const)("refuse on behalf of %s, even on the root site", async (kind) => {
    const delegate = { kind, client: "Claude" };
    await expect(runAsDelegate(delegate, () => api().suspend("t-1"))).rejects.toBeInstanceOf(DelegatedCallRefused);
    await expect(runAsDelegate(delegate, () => api().deleteWorkspace("t-1"))).rejects.toBeInstanceOf(DelegatedCallRefused);
    await expect(runAsDelegate(delegate, () => api().listWorkspaces())).rejects.toBeInstanceOf(DelegatedCallRefused);
    expect(provision.suspendTenant).not.toHaveBeenCalled();
    expect(provision.deleteTenant).not.toHaveBeenCalled();
  });

  it("keep the refusal across awaits and timers inside the delegated call", async () => {
    const attempt = runAsDelegate({ kind: "mcp", client: "Claude" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return api().suspend("t-1");
    });
    await expect(attempt).rejects.toBeInstanceOf(DelegatedCallRefused);
  });

  it("still tell any plugin where it runs", async () => {
    state.site = "hosted-site";
    await expect(runAsDelegate({ kind: "mcp", client: "Claude" }, () => api().current())).resolves.toBeNull();
  });
});

describe("limits", () => {
  it("change on the root site for a person in the admin", async () => {
    await createPluginQuotasApi("acme.platform", TENANCY, "root-site").set("users", 5);
    expect(setQuotaLimit).toHaveBeenCalledOnce();
  });

  it("cannot be raised for its own workspace by a plugin on a hosted site", async () => {
    await expect(createPluginQuotasApi("acme.platform", TENANCY, "hosted-site").set("users", null)).rejects.toThrow(/root site/);
    expect(setQuotaLimit).not.toHaveBeenCalled();
  });

  it("never change on behalf of an agent or key", async () => {
    const api = createPluginQuotasApi("acme.platform", TENANCY, "root-site");
    await expect(runAsDelegate({ kind: "api-key", client: "Script" }, () => api.set("users", null))).rejects.toBeInstanceOf(DelegatedCallRefused);
    await expect(runAsDelegate({ kind: "mcp", client: "Claude" }, () => api.set("users", 99, { siteId: "other" }))).rejects.toBeInstanceOf(DelegatedCallRefused);
    expect(setQuotaLimit).not.toHaveBeenCalled();
  });
});

describe("multisite switch", () => {
  it("refuses workspace operations while multisite is off", async () => {
    process.env.JF_MULTISITE = "false";
    try {
      await expect(createPluginTenancyApi("acme.platform", TENANCY).suspend("t-1")).rejects.toThrow(/JF_MULTISITE/);
      expect(provision.suspendTenant).not.toHaveBeenCalled();
    } finally {
      process.env.JF_MULTISITE = "true";
    }
  });
});
