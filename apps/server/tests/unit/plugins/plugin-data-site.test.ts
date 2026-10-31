// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantRequestContext } from "../../../src/lib/tenancy/context.js";

const query = vi.fn();
vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({ query, run: vi.fn(), execute: vi.fn() }),
}));
vi.mock("../../../src/lib/database/run-migrations.js", () => ({
  runAllMigrations: async () => undefined,
}));

import { createPinnedPluginDataApi, createPluginDataApi } from "../../../src/lib/plugins/plugin-data.js";

const subsite: TenantRequestContext = {
  tenantId: "7b1f21b5-8650-4c6d-a48e-33e1f0bb5b40",
  siteId: "265dfc98-066f-4b2d-84b5-690a4cec450e",
  hostname: "demo-site.localhost",
  userMode: "isolated",
  databaseMode: "current",
  rootSite: false,
  activePluginIds: null,
};

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
});

describe("plugin data site selection", () => {
  it("keeps a pinned read on the main site during a subsite request", async () => {
    await runWithTenant(subsite, () =>
      createPinnedPluginDataApi("justflows.example", "b8cf5f2e-5cc1-46b7-829a-d7b34fb28b0c").get("settings", "connection"),
    );
    expect(query.mock.calls[0]?.[1]?.[0]).toBe("b8cf5f2e-5cc1-46b7-829a-d7b34fb28b0c");
  });

  it("follows the request site for the plugin data api", async () => {
    await runWithTenant(subsite, () =>
      createPluginDataApi("justflows.example", "b8cf5f2e-5cc1-46b7-829a-d7b34fb28b0c").get("settings", "connection"),
    );
    expect(query.mock.calls[0]?.[1]?.[0]).toBe("265dfc98-066f-4b2d-84b5-690a4cec450e");
  });
});
