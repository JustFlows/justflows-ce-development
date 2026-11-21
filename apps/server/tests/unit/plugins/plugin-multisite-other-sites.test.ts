// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activePluginsOnOtherSites, otherSitesHaveActivePlugin } from "../../../src/lib/plugins/plugin-multisite.js";

/**
 * Two databases: the installation database, and the partners site's own one.
 * `eachActiveSite` switches `current` to the site's database while it runs.
 */
const state = vi.hoisted(() => ({
  current: "main" as "main" | "partners",
  rows: {
    main: [] as Array<{ site_id: string; plugin_id: string; status: string }>,
    partners: [] as Array<{ site_id: string; plugin_id: string; status: string }>,
  },
}));

vi.mock("../../../src/lib/database/db.js", () => ({
  getControlDb: vi.fn(),
  getDb: async () => ({
    query: async (sql: string, params: string[]) => {
      const rows = state.rows[state.current].filter((row) => row.status === "active");
      if (sql.includes("site_id <> ?")) {
        const [pluginId, siteId] = params;
        return rows.filter((row) => row.plugin_id === pluginId && row.site_id !== siteId);
      }
      return rows.filter((row) => row.site_id === params[0]);
    },
  }),
}));

vi.mock("../../../src/lib/tenancy/connections.js", () => ({
  eachActiveSite: async (fn: (siteId: string) => Promise<void>) => {
    for (const [siteId, database] of [["platform", "main"], ["blog", "main"], ["partners", "partners"]] as const) {
      state.current = database;
      await fn(siteId);
    }
    state.current = "main";
  },
}));

beforeEach(() => {
  state.current = "main";
  state.rows.main = [{ site_id: "platform", plugin_id: "justflows.partners", status: "inactive" }];
  state.rows.partners = [{ site_id: "partners", plugin_id: "justflows.partners", status: "active" }];
});

describe("plugins on other sites", () => {
  it("sees a plugin turned on at a site that keeps its own database", async () => {
    expect(await otherSitesHaveActivePlugin("justflows.partners", "platform")).toBe(true);
    expect(await activePluginsOnOtherSites("platform")).toEqual(new Map([["partners", ["justflows.partners"]]]));
  });

  it("does not count the asking site, or plugins no other site has on", async () => {
    expect(await otherSitesHaveActivePlugin("justflows.partners", "partners")).toBe(false);
    expect(await otherSitesHaveActivePlugin("justflows.forms", "platform")).toBe(false);
  });

  it("still sees another site in the same database", async () => {
    state.rows.partners = [];
    state.rows.main.push({ site_id: "blog", plugin_id: "justflows.partners", status: "active" });
    expect(await otherSitesHaveActivePlugin("justflows.partners", "platform")).toBe(true);
  });
});
