import { describe, expect, it } from "vitest";
import {
  extensionIdNamespaceIssue,
  extensionNamespace,
  isApiNamespaceAllowedForExtension,
  isAssignablePublisherNamespace,
  isOfficialExtensionId,
  PLUGIN_ID_RE,
  PluginManifestSchema,
} from "../../src/index.js";

const base = {
  id: "acme.forms",
  name: "Acme Forms",
  version: "1.0.0",
  publisher: "Acme",
  license: "GPL-2.0-or-later",
};

describe("publisher namespaces", () => {
  it("accepts official and third-party ids and refuses malformed ones", () => {
    for (const id of ["justflows.forms", "justflows.theme.dark", "acme.forms", "acme-labs.forms-pro"]) {
      expect(PLUGIN_ID_RE.test(id), id).toBe(true);
    }
    for (const id of ["forms", "Acme.forms", "acme..forms", "acme.forms.", "-acme.forms", "acme--x.forms", "1acme.forms", `a.${"b".repeat(130)}`]) {
      expect(PLUGIN_ID_RE.test(id), id).toBe(false);
    }
  });

  it("tells official ids from third-party ids", () => {
    expect(extensionNamespace("acme.forms")).toBe("acme");
    expect(isOfficialExtensionId("justflows.forms")).toBe(true);
    expect(isOfficialExtensionId("acme.forms")).toBe(false);
    expect(isOfficialExtensionId("justflowsx.forms")).toBe(false);
  });

  it("refuses reserved namespaces except the official one", () => {
    expect(extensionIdNamespaceIssue("justflows.forms")).toBeNull();
    expect(extensionIdNamespaceIssue("acme.forms")).toBeNull();
    expect(extensionIdNamespaceIssue("jf.forms")).toMatch(/reserved/);
    expect(extensionIdNamespaceIssue("official.forms")).toMatch(/reserved/);
    expect(isAssignablePublisherNamespace("justflows")).toBe(false);
    expect(isAssignablePublisherNamespace("acme")).toBe(true);
    expect(isAssignablePublisherNamespace("a")).toBe(false);
  });

  it("keeps a third-party API namespace inside the publisher namespace", () => {
    expect(isApiNamespaceAllowedForExtension("justflows.shop", "shop")).toBe(true);
    expect(isApiNamespaceAllowedForExtension("acme.forms", "acme")).toBe(true);
    expect(isApiNamespaceAllowedForExtension("acme.forms", "acme-forms")).toBe(true);
    expect(isApiNamespaceAllowedForExtension("acme.forms", "shop")).toBe(false);
    expect(isApiNamespaceAllowedForExtension("acme.forms", "acmeforms")).toBe(false);
  });
});

describe("PluginManifestSchema — publisher namespaces", () => {
  it("accepts a third-party plugin and resolves its admin paths", () => {
    const parsed = PluginManifestSchema.parse({ ...base, permissions: ["admin:extend"], setupPath: "setup" });
    expect(parsed.setupPath).toBe("/admin/plugins/acme.forms/setup");
  });

  it("refuses a reserved namespace and an API namespace outside the publisher's", () => {
    expect(() => PluginManifestSchema.parse({ ...base, id: "jf.forms" })).toThrow(/reserved/);
    expect(() => PluginManifestSchema.parse({ ...base, apiNamespace: "shop" })).toThrow(/API namespace must be/);
    expect(PluginManifestSchema.parse({ ...base, apiNamespace: "acme-forms" }).apiNamespace).toBe("acme-forms");
  });

  it("accepts a third-party required plugin id", () => {
    expect(PluginManifestSchema.parse({ ...base, requires: ["justflows.ecommerce", "acme.core"] }).requires).toEqual([
      "justflows.ecommerce",
      "acme.core",
    ]);
  });
});
