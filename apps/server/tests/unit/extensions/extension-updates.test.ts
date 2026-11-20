// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCompatibleCatalog, findExtensionUpdates } from "../../../src/lib/extensions/extension-updates.js";
import {
  assertMarketplaceUpgrade,
  MarketplaceRequestError,
} from "../../../src/lib/extensions/marketplace-package.js";

type Item = Record<string, unknown>;

function catalog(...items: Item[]): Map<string, Item> {
  return new Map(items.map((item) => [`${String(item.type)}:${String(item.id)}`, item]));
}

const free = { listed: true, free: true };
const noAuto = { plugin: [] as string[], theme: [] as string[] };

describe("findExtensionUpdates", () => {
  it("reports a newer listing for an installed plugin or theme", () => {
    const updates = findExtensionUpdates(
      [
        { type: "plugin", id: "acme.forms", name: "Forms", version: "1.2.0" },
        { type: "theme", id: "acme.dark", name: "Dark", version: "2.0.0" },
      ],
      catalog(
        { type: "plugin", id: "acme.forms", version: "1.3.0", registry: free },
        { type: "theme", id: "acme.dark", version: "2.0.1", registry: free },
      ),
      { plugin: ["acme.forms"], theme: [] },
    );
    expect(updates).toEqual([
      expect.objectContaining({
        type: "plugin",
        id: "acme.forms",
        installedVersion: "1.2.0",
        availableVersion: "1.3.0",
        autoUpdatable: true,
        autoUpdate: true,
      }),
      expect.objectContaining({ type: "theme", id: "acme.dark", autoUpdate: false }),
    ]);
  });

  it("ignores equal, older, unparsable, and unlisted versions", () => {
    const installed = [
      { type: "plugin" as const, id: "same", name: "Same", version: "1.0.0" },
      { type: "plugin" as const, id: "older", name: "Older", version: "2.0.0" },
      { type: "plugin" as const, id: "weird", name: "Weird", version: "latest" },
      { type: "plugin" as const, id: "local-only", name: "Local", version: "0.1.0" },
    ];
    const updates = findExtensionUpdates(
      installed,
      catalog(
        { type: "plugin", id: "same", version: "1.0.0", registry: free },
        { type: "plugin", id: "older", version: "1.9.9", registry: free },
        { type: "plugin", id: "weird", version: "1.0.0", registry: free },
      ),
      noAuto,
    );
    expect(updates).toEqual([]);
  });

  it("does not match a theme listing to a plugin with the same id", () => {
    const updates = findExtensionUpdates(
      [{ type: "plugin", id: "acme.x", name: "X", version: "1.0.0" }],
      catalog({ type: "theme", id: "acme.x", version: "9.0.0", registry: free }),
      noAuto,
    );
    expect(updates).toEqual([]);
  });

  it("marks major bumps as not auto-updatable", () => {
    const [update] = findExtensionUpdates(
      [{ type: "plugin", id: "acme.forms", name: "Forms", version: "1.9.0" }],
      catalog({ type: "plugin", id: "acme.forms", version: "2.0.0", registry: free }),
      noAuto,
    );
    expect(update?.autoUpdatable).toBe(false);
  });

  it("skips hidden, coming-soon, and commercial listings", () => {
    const installed = ["hidden", "soon", "paid"].map((id) => ({
      type: "plugin" as const,
      id,
      name: id,
      version: "1.0.0",
    }));
    const updates = findExtensionUpdates(
      installed,
      catalog(
        { type: "plugin", id: "hidden", version: "1.1.0", registry: { listed: false, free: true } },
        { type: "plugin", id: "soon", version: "1.1.0", registry: { ...free, comingSoon: true } },
        { type: "plugin", id: "paid", version: "1.1.0", registry: { listed: true, free: false } },
      ),
      noAuto,
    );
    expect(updates).toEqual([]);
  });

  it("only offers beta builds when the site allows beta installs", () => {
    const installed = [
      { type: "plugin" as const, id: "acme.beta", name: "Beta", version: "0.1.0" },
    ];
    const items = catalog({
      type: "plugin",
      id: "acme.beta",
      version: "0.2.0",
      registry: { ...free, beta: true },
    });
    expect(findExtensionUpdates(installed, items, noAuto)).toEqual([]);
    expect(findExtensionUpdates(installed, items, noAuto, true)).toEqual([
      expect.objectContaining({ id: "acme.beta", beta: true }),
    ]);
  });
});

describe("assertMarketplaceUpgrade", () => {
  it("accepts only a newer semantic version", () => {
    expect(() => assertMarketplaceUpgrade("1.2.3", "1.2.4")).not.toThrow();
    expect(() => assertMarketplaceUpgrade("1.2.3", "2.0.0")).not.toThrow();
  });

  it.each(["1.2.3", "1.2.2", "0.9.0"])("blocks equal or older version %s", (incoming) => {
    expect(() => assertMarketplaceUpgrade("1.2.3", incoming)).toThrow(
      expect.objectContaining<Partial<MarketplaceRequestError>>({
        status: 409,
        body: expect.objectContaining({ code: "extension_downgrade_blocked" }),
      }),
    );
  });

  it("fails closed when either version is not semantic", () => {
    expect(() => assertMarketplaceUpgrade("development", "1.2.3")).toThrow(
      expect.objectContaining<Partial<MarketplaceRequestError>>({
        status: 409,
        body: expect.objectContaining({ code: "invalid_update_version" }),
      }),
    );
  });
});

describe("updates of platform-only packages", () => {
  const platformOnly = { commercialMarketplace: true, listed: false, free: true, comingSoon: false };
  const saved = process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved === undefined) delete process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
    else process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN = saved;
  });

  it("asks the catalogue with the platform headers, so unlisted platform packages are included", async () => {
    process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN = "platform-test-token";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [{ type: "plugin", id: "justflows.partners", version: "0.2.3", registry: platformOnly }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const found = await fetchCompatibleCatalog();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ "x-justflows-platform-token": "platform-test-token", "x-justflows-site-domain": "justflows.com" });
    expect(
      findExtensionUpdates([{ type: "plugin", id: "justflows.partners", name: "Partners", version: "0.2.2" }], found, noAuto),
    ).toEqual([expect.objectContaining({ id: "justflows.partners", installedVersion: "0.2.2", availableVersion: "0.2.3" })]);
  });

  it("sends no platform headers on other sites", async () => {
    delete process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await fetchCompatibleCatalog();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({});
  });
});
