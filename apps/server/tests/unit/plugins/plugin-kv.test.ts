// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const list = vi.fn();
vi.mock("../../../src/lib/database/db.js", () => ({ getDb: async () => ({ query }) }));
vi.mock("../../../src/lib/plugins/plugin-data.js", () => ({
  createPluginDataApi: (pluginId: string, siteId: string) => ({
    list: (collection: string) => list(pluginId, siteId, collection),
  }),
}));
import { getSiteSettings } from "../../../src/lib/settings/site-settings.js";
import { getPluginSettings } from "../../../src/lib/plugins/plugin-kv.js";
import { getSeoSettings } from "../../../src/lib/rendering/seo-public.js";
vi.mock("../../../src/lib/i18n/languages-db.js", () => ({ getDefaultLocale: async () => "en" }));

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  list.mockReset().mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe("related plugin settings", () => {
  it.each(["postgres", "mysql", "mariadb"])("preserves stored false/zero/null and legacy fallback on %s", async (driver) => {
    vi.stubEnv("DB_DRIVER", driver);
    list.mockResolvedValue([{ id: "enabled", data: false }, { id: "limit", data: 0 }, { id: "nil", data: null }]);
    query.mockResolvedValue([{ setting_key: "plugin.demo:old", value: '{"en":"Legacy"}' }]);
    const values = await getPluginSettings("demo", "site-a", ["enabled", "limit", "nil", "old", "missing"]);
    expect(values).toEqual({ enabled: false, limit: 0, nil: null, old: { en: "Legacy" }, missing: undefined });
    expect(list).toHaveBeenCalledExactlyOnceWith("demo", "site-a", "settings");
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![1]).toEqual(["site-a", "plugin.demo:old", "plugin.demo:missing"]);
    expect(query.mock.calls[0]![0]).toContain(driver === "postgres" ? "SELECT key AS" : "SELECT `key` AS");
  });

  it("loads all SEO values once and retains localized defaults", async () => {
    list.mockResolvedValue([
      { id: "siteTitle", data: { en: "English", nl: "Nederlands" } },
      { id: "titleTemplate", data: { en: "%s | Site" } },
      { id: "defaultDescription", data: "Shared" },
      { id: "twitterHandle", data: "@site" },
      { id: "extraSitemapPaths", data: " /extra\n\n /other " },
    ]);
    expect(await getSeoSettings("site-a", "nl")).toEqual({
      siteTitle: "Nederlands", titleTemplate: "%s | Site", defaultDescription: "Shared",
      twitterHandle: "@site", extraSitemapPaths: ["/extra", "/other"],
    });
    expect(list).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  });

  it("deduplicates and bounds large groups of site settings", async () => {
    const keys = Array.from({ length: 401 }, (_, i) => `key-${i}`);
    query.mockImplementation(async (_sql: string, params: string[]) =>
      params.slice(1).map((key) => ({ setting_key: key, value: JSON.stringify(key) })),
    );
    const values = await getSiteSettings("site-a", [...keys, keys[0]!]);
    expect(Object.keys(values)).toHaveLength(401);
    expect(values["key-400"]).toBe("key-400");
    expect(query).toHaveBeenCalledTimes(3);
    for (const [, params] of query.mock.calls) {
      expect(params[0]).toBe("site-a");
      expect(params.length).toBeLessThanOrEqual(201);
    }
  });

  it("does not read settings for an empty key list", async () => {
    expect(await getPluginSettings("demo", "site-a", [])).toEqual({});
    expect(list).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
