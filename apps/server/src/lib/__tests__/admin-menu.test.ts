// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { finalizeAdminMenu, stampSetupPaths } from "../admin-menu.js";

describe("finalizeAdminMenu", () => {
  it("keeps valid plugin pages and drops the rest", () => {
    const items = finalizeAdminMenu([
      { pluginId: "acme.seo", id: "reports", label: "Reports", path: "/admin/reports", icon: "📊", domain: "extensions" },
      { pluginId: "acme.seo", id: "dup", label: "Dup", path: "/admin/reports" },
      { id: "no-owner", label: "Nope", path: "/admin/nope" },
      { pluginId: "acme.seo", id: "escape", label: "Escape", path: "/admin/../secret" },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ pluginId: "acme.seo", path: "/admin/reports", label: "Reports" }),
    ]);
  });

  it("keeps a commerce domain page", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.shop",
        id: "shop",
        label: "Shop",
        path: "/admin/shop",
        icon: "🛍",
        domain: "commerce",
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ pluginId: "justflows.shop", path: "/admin/shop", domain: "commerce" }),
    ]);
  });

  it("keeps setupPath so nested pages can skip the wizard", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.shop",
        id: "products",
        label: "Products",
        path: "/admin/shop/products",
        domain: "commerce",
        setupPath: "/admin/shop",
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ path: "/admin/shop/products", setupPath: "/admin/shop" }),
    ]);
  });

  it("keeps a valid contentType so the host can list those CMS entries", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.shop",
        id: "products",
        label: "Products",
        path: "/admin/shop/products",
        domain: "commerce",
        contentType: "product",
      },
      {
        pluginId: "acme.seo",
        id: "reports",
        label: "Reports",
        path: "/admin/reports",
        contentType: "Not Valid!",
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ path: "/admin/shop/products", contentType: "product" }),
      expect.objectContaining({ path: "/admin/reports", contentType: undefined }),
    ]);
  });
});

describe("stampSetupPaths", () => {
  it("fills setupPath from the plugin manifest when the item omitted it", () => {
    const stamped = stampSetupPaths(
      [
        {
          pluginId: "justflows.shop",
          id: "products",
          label: "Products",
          path: "/admin/shop/products",
          icon: "📦",
          domain: "commerce",
        },
      ],
      new Map([["justflows.shop", "/admin/shop"]]),
    );
    expect(stamped[0]?.setupPath).toBe("/admin/shop");
  });
});
