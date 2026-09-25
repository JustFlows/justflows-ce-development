// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PluginManifestSchema, resolvePluginAdminPath, SENSITIVE_PERMISSIONS } from "../../src/plugin.js";

const base = {
  id: "justflows.widget",
  name: "Acme Widget",
  version: "1.0.0",
  license: "GPL-2.0-or-later",
};

describe("PluginManifestSchema — mail sending", () => {
  it("accepts mail:send and treats it as sensitive", () => {
    const parsed = PluginManifestSchema.parse({ ...base, permissions: ["mail:send"] });
    expect(parsed.permissions).toContain("mail:send");
    expect(SENSITIVE_PERMISSIONS).toContain("mail:send");
  });
});

describe("PluginManifestSchema — assets", () => {
  it("accepts a scripts-only assets block and defaults dir handling to the host", () => {
    const parsed = PluginManifestSchema.parse({
      ...base,
      assets: { scripts: ["widget.js"] },
    });
    expect(parsed.assets?.scripts).toEqual(["widget.js"]);
    expect(parsed.assets?.dir).toBeUndefined();
  });

  it("accepts a nested dir and .css/.mjs entries", () => {
    const parsed = PluginManifestSchema.parse({
      ...base,
      assets: { dir: "dist/public", scripts: ["a/b.mjs"], styles: ["w.css"] },
    });
    expect(parsed.assets?.dir).toBe("dist/public");
  });

  it("rejects traversal in dir or asset paths", () => {
    expect(() => PluginManifestSchema.parse({ ...base, assets: { dir: "../etc" } })).toThrow();
    expect(() =>
      PluginManifestSchema.parse({ ...base, assets: { scripts: ["../x.js"] } }),
    ).toThrow();
  });

  it("rejects non-js/css asset extensions", () => {
    expect(() =>
      PluginManifestSchema.parse({ ...base, assets: { scripts: ["payload.sh"] } }),
    ).toThrow();
  });

  it("leaves manifests without an assets block untouched", () => {
    const parsed = PluginManifestSchema.parse(base);
    expect(parsed.assets).toBeUndefined();
  });
});

describe("PluginManifestSchema — adminApp", () => {
  const withPerm = { ...base, permissions: ["admin:extend"] };

  it("accepts routes with a default dir and an optional title, resolving each path", () => {
    const parsed = PluginManifestSchema.parse({
      ...withPerm,
      adminApp: {
        locales: { en: "locales/en.json" },
        routes: [
          { entry: "index.html", title: "Forms" },
          { path: "submissions", entry: "index.html" },
        ],
      },
    });
    expect(parsed.adminApp?.dir).toBeUndefined();
    expect(parsed.adminApp?.routes).toHaveLength(2);
    expect(parsed.adminApp?.routes[0]?.path).toBe("/admin/plugins/justflows.widget");
    expect(parsed.adminApp?.routes[1]?.path).toBe("/admin/plugins/justflows.widget/submissions");
  });

  it("accepts a nested build dir", () => {
    const parsed = PluginManifestSchema.parse({
      ...withPerm,
      adminApp: { dir: "dist/admin", locales: { en: "locales/en.json" }, routes: [{ path: "board", entry: "app/index.html" }] },
    });
    expect(parsed.adminApp?.dir).toBe("dist/admin");
  });

  it("requires an English catalog", () => {
    const result = PluginManifestSchema.safeParse({
      ...withPerm,
      adminApp: { routes: [{ entry: "index.html" }] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "adminApp.locales.en")).toBe(true);
  });

  it("requires the admin:extend permission", () => {
    const result = PluginManifestSchema.safeParse({
      ...base,
      adminApp: { routes: [{ path: "/admin/x", entry: "index.html" }] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "adminApp")).toBe(true);
  });

  it("rejects an absolute route path, a non-html entry, and traversal", () => {
    expect(() =>
      PluginManifestSchema.parse({
        ...withPerm,
        adminApp: { routes: [{ path: "/admin/plugins/justflows.widget/x", entry: "index.html" }] },
      }),
    ).toThrow();
    expect(() =>
      PluginManifestSchema.parse({
        ...withPerm,
        adminApp: { routes: [{ path: "x", entry: "app.js" }] },
      }),
    ).toThrow();
    expect(() =>
      PluginManifestSchema.parse({
        ...withPerm,
        adminApp: { routes: [{ path: "x", entry: "../evil.html" }] },
      }),
    ).toThrow();
  });

  it("requires at least one route", () => {
    expect(() => PluginManifestSchema.parse({ ...withPerm, adminApp: { routes: [] } })).toThrow();
  });

  it("leaves manifests without an adminApp block untouched", () => {
    expect(PluginManifestSchema.parse(base).adminApp).toBeUndefined();
  });
});

describe("PluginManifestSchema — plugin-relative admin paths", () => {
  const withPerm = { ...base, permissions: ["admin:extend"] };

  it("resolves relative paths against /admin/plugins/<id>", () => {
    const parsed = PluginManifestSchema.parse({
      ...withPerm,
      setupPath: "",
      adminMenu: [
        { id: "home", label: "Widget", icon: "🧩" },
        { id: "board", label: "Board", path: "board" },
        { id: "nested", label: "Nested", path: "board/archive" },
      ],
      adminApp: { locales: { en: "locales/en.json" }, routes: [{ path: "board", entry: "index.html" }] },
    });
    expect(parsed.adminMenu?.map((m) => m.path)).toEqual([
      "/admin/plugins/justflows.widget",
      "/admin/plugins/justflows.widget/board",
      "/admin/plugins/justflows.widget/board/archive",
    ]);
    expect(parsed.setupPath).toBe("/admin/plugins/justflows.widget");
    expect(parsed.adminApp?.routes[0]?.path).toBe("/admin/plugins/justflows.widget/board");
  });

  it("trims arbitrary runs of leading/trailing slashes from a relative path", () => {
    expect(resolvePluginAdminPath("justflows.widget", "///board///")).toBe(
      "/admin/plugins/justflows.widget/board",
    );
    expect(resolvePluginAdminPath("justflows.widget", "/".repeat(500))).toBe(
      "/admin/plugins/justflows.widget",
    );
    expect(resolvePluginAdminPath("justflows.widget", null)).toBe(
      "/admin/plugins/justflows.widget",
    );
  });

  it('keeps "no setup wizard" distinct from a root-page wizard', () => {
    expect(PluginManifestSchema.parse(withPerm).setupPath).toBeUndefined();
    expect(PluginManifestSchema.parse({ ...withPerm, setupPath: "" }).setupPath).toBe(
      "/admin/plugins/justflows.widget",
    );
  });

  it("rejects an absolute path, a leading slash, and the plugin id or a dot", () => {
    for (const path of [
      "/admin/plugins/justflows.widget/board",
      "/board",
      "justflows.widget",
      "justflows.widget/board",
      "board/../secret",
    ]) {
      expect(
        PluginManifestSchema.safeParse({
          ...withPerm,
          adminMenu: [{ id: "x", label: "X", path }],
        }).success,
        path,
      ).toBe(false);
    }
  });
});
