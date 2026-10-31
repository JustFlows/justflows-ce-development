// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finalizeAdminMenu,
  stampCatalogLabels,
  stampSections,
  stampSetupPaths,
} from "../../../src/lib/admin/admin-menu.js";

describe("finalizeAdminMenu", () => {
  it("resolves plugin-relative paths and drops the rest", () => {
    const items = finalizeAdminMenu([
      { pluginId: "acme.seo", id: "reports", label: "Reports", path: "reports", icon: "📊", domain: "extensions" },
      { pluginId: "acme.seo", id: "dup", label: "Dup", path: "reports" },
      { id: "no-owner", label: "Nope", path: "nope" },
      { pluginId: "acme.seo", id: "escape", label: "Escape", path: "../secret" },
      { pluginId: "acme.seo", id: "absolute", label: "Absolute", path: "/admin/other" },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        pluginId: "acme.seo",
        path: "/admin/plugins/acme.seo/reports",
        label: "Reports",
      }),
    ]);
  });

  it("keeps Shared files on its own sidebar domain", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.shared-files",
        id: "files",
        label: "Shared files",
        icon: "files",
        domain: "files",
        end: true,
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        path: "/admin/plugins/justflows.shared-files",
        domain: "files",
      }),
    ]);
  });

  it("keeps Helpdesk on its own sidebar domain", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.helpdesk",
        id: "inbox",
        label: "Helpdesk",
        icon: "💬",
        domain: "helpdesk",
        end: true,
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        path: "/admin/plugins/justflows.helpdesk",
        domain: "helpdesk",
      }),
    ]);
  });

  it("treats an omitted path as the plugin's namespace root", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.shop",
        id: "shop",
        label: "Shop",
        icon: "🛍",
        domain: "commerce",
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        pluginId: "justflows.shop",
        path: "/admin/plugins/justflows.shop",
        domain: "commerce",
      }),
    ]);
  });

  it("keeps setupPath so nested pages can skip the wizard", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.shop",
        id: "products",
        label: "Products",
        path: "products",
        domain: "commerce",
        setupPath: "",
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        path: "/admin/plugins/justflows.shop/products",
        setupPath: "/admin/plugins/justflows.shop",
      }),
    ]);
  });

  it("keeps a valid contentType and drops an invalid one", () => {
    const items = finalizeAdminMenu([
      {
        pluginId: "justflows.shop",
        id: "products",
        label: "Products",
        path: "products",
        domain: "commerce",
        contentType: "product",
      },
      {
        pluginId: "acme.seo",
        id: "reports",
        label: "Reports",
        path: "reports",
        contentType: "Not Valid!",
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        path: "/admin/plugins/justflows.shop/products",
        contentType: "product",
      }),
      expect.objectContaining({
        path: "/admin/plugins/acme.seo/reports",
        contentType: undefined,
      }),
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
          path: "/admin/plugins/justflows.shop/products",
          icon: "📦",
          domain: "commerce",
        },
      ],
      new Map([["justflows.shop", "/admin/plugins/justflows.shop"]]),
    );
    expect(stamped[0]?.setupPath).toBe("/admin/plugins/justflows.shop");
  });
});

describe("menu labels", () => {
  it("keeps valid per-locale labels and drops the rest", () => {
    const [item] = finalizeAdminMenu([
      {
        pluginId: "justflows.forms",
        id: "forms",
        label: "Forms",
        labels: { nl: " Formulieren ", "de-DE": "Formulare", "../x": "Bad", fr: "   ", es: 7 },
      },
    ]);
    expect(item?.labels).toEqual({ nl: "Formulieren", "de-DE": "Formulare" });
  });

  it("translates labelKey from the plugin's own catalogs, keeping declared labels", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-menu-labels-"));
    const nl = path.join(dir, "nl.json");
    const de = path.join(dir, "de.json");
    fs.writeFileSync(nl, JSON.stringify({ "menu.forms": "Formulieren" }));
    fs.writeFileSync(de, JSON.stringify({ "menu.forms": "Formulare" }));
    try {
      const [forms, other] = stampCatalogLabels(
        [
          {
            pluginId: "justflows.forms",
            id: "forms",
            label: "Forms",
            labelKey: "menu.forms",
            labels: { de: "Eigene Formulare" },
            path: "/admin/plugins/justflows.forms",
            icon: "✉",
            domain: "extensions",
          },
          {
            pluginId: "justflows.other",
            id: "other",
            label: "Other",
            labelKey: "menu.forms",
            path: "/admin/plugins/justflows.other",
            icon: "🔌",
            domain: "extensions",
          },
        ],
        new Map([["justflows.forms", { nl, de, fr: path.join(dir, "missing.json") }]]),
      );
      expect(forms?.labels).toEqual({ nl: "Formulieren", de: "Eigene Formulare" });
      expect(other?.labels).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stampSections", () => {
  it("gives plugin domain items their section, translated from the plugin catalogs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-menu-section-"));
    const nl = path.join(dir, "nl.json");
    fs.writeFileSync(nl, JSON.stringify({ "menu.section": "Acme NL" }));
    try {
      const [own, shared] = stampSections(
        [
          { pluginId: "justflows.acme", id: "home", label: "Acme", path: "/admin/plugins/justflows.acme", icon: "⚡", domain: "plugin" },
          { pluginId: "justflows.acme", id: "tool", label: "Tool", path: "/admin/plugins/justflows.acme/tool", icon: "⚡", domain: "tools" },
        ],
        new Map([["justflows.acme", { label: "Acme", labelKey: "menu.section", icon: "/ext/justflows.acme/admin/logo.png" }]]),
        new Map([["justflows.acme", { nl }]]),
      );
      expect(own?.section).toEqual({
        label: "Acme",
        labelKey: "menu.section",
        labels: { nl: "Acme NL" },
        icon: "/ext/justflows.acme/admin/logo.png",
      });
      expect(shared?.section).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("menu roles", () => {
  it("keeps valid, distinct role ids and drops the rest", () => {
    const [item] = finalizeAdminMenu([
      {
        pluginId: "justflows.helpdesk",
        id: "inbox",
        label: "Helpdesk",
        roles: ["administrator", "support-agent", "support-agent", "Bad Role", 7],
      },
    ]);
    expect(item?.roles).toEqual(["administrator", "support-agent"]);
  });
});
