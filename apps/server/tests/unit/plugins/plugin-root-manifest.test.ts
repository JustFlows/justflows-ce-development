// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

let root: string | null = "root-site";
const rootRows = [
  {
    plugin_id: "justflows.shop",
    version: "0.3.3",
    manifest: JSON.stringify({ id: "justflows.shop", installedPath: "/jf/packages-installed/plugins/justflows.shop/0.3.3/new" }),
  },
];
const query = vi.fn(async () => rootRows);

vi.mock("../../../src/lib/tenancy/registry.js", () => ({
  installationRootSiteId: async () => root,
}));
vi.mock("../../../src/lib/database/db.js", () => ({
  getControlDb: async () => ({ query }),
}));

const { clearRootPluginCache, withRootPluginManifests } = await import(
  "../../../src/lib/plugins/plugin-root-manifest.js"
);

const staleShop = {
  plugin_id: "justflows.shop",
  version: "0.1.2",
  manifest: { id: "justflows.shop", installedPath: "/jf/packages-installed/plugins/justflows.shop/0.1.2/old" },
};

describe("withRootPluginManifests", () => {
  beforeEach(() => {
    root = "root-site";
    query.mockClear();
    clearRootPluginCache();
  });

  it("gives another site the main site's version and install path", async () => {
    const [row] = await withRootPluginManifests("tenant-site", [staleShop]);
    expect(row?.version).toBe("0.3.3");
    expect(row?.manifest).toEqual({
      id: "justflows.shop",
      installedPath: "/jf/packages-installed/plugins/justflows.shop/0.3.3/new",
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM plugins WHERE site_id = ?"), ["root-site"]);
  });

  it("leaves the main site's own rows alone", async () => {
    const rows = [staleShop];
    expect(await withRootPluginManifests("root-site", rows)).toBe(rows);
  });

  it("keeps a row the main site has no row for", async () => {
    const helpdesk = { plugin_id: "justflows.helpdesk", manifest: "{\"id\":\"justflows.helpdesk\"}" };
    expect(await withRootPluginManifests("tenant-site", [helpdesk])).toEqual([helpdesk]);
  });

  it("reads the main site's rows once for several sites until cleared", async () => {
    await withRootPluginManifests("tenant-a", [staleShop]);
    await withRootPluginManifests("tenant-b", [staleShop]);
    expect(query).toHaveBeenCalledTimes(1);
    clearRootPluginCache();
    await withRootPluginManifests("tenant-a", [staleShop]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps the site's rows when there is no installation root", async () => {
    root = null;
    expect(await withRootPluginManifests("tenant-site", [staleShop])).toEqual([staleShop]);
  });
});
