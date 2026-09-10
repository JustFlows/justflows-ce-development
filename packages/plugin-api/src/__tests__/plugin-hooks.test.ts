import { describe, it, expect, vi } from "vitest";
import { App, type AppConfig } from "@justflows/core";
import type { PluginModule, PluginContext } from "@justflows/sdk";
import { PluginLoader } from "../loader.js";

const CONFIG = {
  env: "test",
  url: "http://localhost:3000",
  logLevel: "error",
} as unknown as AppConfig;

function makePlugin(
  overrides: Partial<PluginModule["manifest"]>,
  activate: (ctx: PluginContext) => void | Promise<void>,
): PluginModule {
  return {
    manifest: {
      id: "justflows.test",
      name: "Acme Test",
      version: "1.0.0",
      license: "GPL-2.0-or-later",
      permissions: [],
      main: "index.js",
      ...overrides,
    } as PluginModule["manifest"],
    activate,
    deleteData: async () => undefined,
  };
}

async function activate(plugin: PluginModule): Promise<{ app: App; loader: PluginLoader }> {
  const app = new App(CONFIG);
  const loader = new PluginLoader(app);
  loader.register(plugin);
  await loader.activate(plugin.manifest.id, "site-1");
  return { app, loader };
}

describe("plugin hook context", () => {
  it("exposes host, SDK package, and SDK API versions without changing plugin version", async () => {
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { justflowsVersion: "0.1.8-dev.1" });
    let seen: PluginContext | undefined;
    const plugin = makePlugin({}, (ctx) => {
      seen = ctx;
    });
    loader.register(plugin);
    await loader.activate(plugin.manifest.id, "site-1");

    expect(seen?.version).toBe("1.0.0");
    expect(seen?.runtime).toEqual({ justflows: "0.1.8-dev.1", sdk: "0.1.6", sdkApi: 1 });
  });

  it("attributes a plugin's registrations to the plugin", async () => {
    const { app } = await activate(
      makePlugin({}, (ctx) => {
        ctx.hooks.action("content.published", () => {}, { id: "reindex" });
      }),
    );

    expect(app.hooks.inspect("content.published")).toEqual([
      expect.objectContaining({ pluginId: "justflows.test", handlerId: "reindex" }),
    ]);
  });

  it("removes every registration on deactivation", async () => {
    const fn = vi.fn();
    const { app, loader } = await activate(
      makePlugin({}, (ctx) => {
        // Deliberately drop the dispose handles — the runtime must still clean up.
        ctx.hooks.action("content.published", fn);
        ctx.hooks.filter("content.render", (html) => html);
      }),
    );

    expect(app.hooks.count("content.published")).toBe(1);
    await loader.deactivate("justflows.test", "site-1");

    await app.hooks.dispatchAction("content.published", { contentId: "c1", siteId: "site-1" });
    expect(fn).not.toHaveBeenCalled();
    expect(app.hooks.count("content.published")).toBe(0);
    expect(app.hooks.count("content.render")).toBe(0);
  });

  it("registers editable patterns and removes them on deactivation", async () => {
    const { loader } = await activate(
      makePlugin({}, (ctx) => {
        ctx.patterns.register({
          id: "hero",
          title: "Plugin hero",
          category: "hero",
          blocks: [{ id: "heading", type: "core.heading", version: 1, props: { text: "Hello" } }],
        });
      }),
    );

    expect(loader.patternRegistry.get("justflows.test:hero")?.title).toBe("Plugin hero");
    await loader.deactivate("justflows.test", "site-1");
    expect(loader.patternRegistry.all()).toEqual([]);
  });

  it("requires content:read for a search backend and cleans up on deactivation", async () => {
    await expect(activate(makePlugin({}, ctx => {
      ctx.hooks.filter("search.backend", current => current);
    }))).rejects.toThrow(/content:read/);
    const engine = { id: "example", search: async () => [], upsert: async () => {}, remove: async () => {} };
    const { app, loader } = await activate(makePlugin({ permissions: ["content:read"] }, ctx => {
      ctx.hooks.filter("search.backend", () => engine);
    }));
    expect(await app.hooks.applyFilter("search.backend", null, { siteId: "site-1" })).toBe(engine);
    await loader.deactivate("justflows.test", "site-1");
    expect(await app.hooks.applyFilter("search.backend", null, { siteId: "site-1" })).toBeNull();
  });

  it("refuses a sensitive hook without the declared permission", async () => {
    await expect(
      activate(
        makePlugin({}, (ctx) => {
          ctx.hooks.action("auth.login", () => {});
        }),
      ),
    ).rejects.toThrow(/auth:hook/);
  });

  it("refuses admin.menu without admin:extend", async () => {
    await expect(
      activate(
        makePlugin({}, (ctx) => {
          ctx.hooks.filter("admin.menu", (items) => items);
        }),
      ),
    ).rejects.toThrow(/admin:extend/);
  });

  it("allows admin.menu once admin:extend is declared", async () => {
    const { app } = await activate(
      makePlugin({ permissions: ["admin:extend"] }, (ctx) => {
        ctx.hooks.filter("admin.menu", (items) => [
          ...items,
          {
            pluginId: ctx.pluginId,
            id: "reports",
            label: "Reports",
            path: "/admin/reports",
          },
        ]);
      }),
    );
    expect(app.hooks.count("admin.menu")).toBe(1);
  });

  it("allows a sensitive hook once the permission is declared", async () => {
    const { app } = await activate(
      makePlugin({ permissions: ["auth:hook"] }, (ctx) => {
        ctx.hooks.action("auth.login", () => {});
      }),
    );
    expect(app.hooks.count("auth.login")).toBe(1);
  });

  it("lets a plugin emit hooks in its own namespace", async () => {
    const seen: unknown[] = [];
    const { app } = await activate(
      makePlugin({}, (ctx) => {
        ctx.hooks.action("justflows.test.scored", (event) => {
          seen.push(event);
        });
        void ctx.hooks.emit("justflows.test.scored", { score: 42 } as never);
      }),
    );
    await app.hooks.dispatchAction("app.started", { version: "0.1.0" });
    expect(seen).toEqual([{ score: 42 }]);
  });

  it("refuses to let a plugin emit a core hook", async () => {
    let error: unknown;
    await activate(
      makePlugin({}, async (ctx) => {
        error = await ctx.hooks.emit("content.published", {} as never).catch((e: unknown) => e);
      }),
    );
    expect(String(error)).toMatch(/own namespace/);
  });

  it("gates registered by a plugin can block a core operation", async () => {
    const { app } = await activate(
      makePlugin({}, (ctx) => {
        ctx.hooks.gate("media.beforeUpload", (event) => {
          if (event.sizeBytes > 10) event.cancel("File too large");
        });
      }),
    );

    await expect(
      app.hooks.dispatchGate("media.beforeUpload", {
        siteId: "site-1",
        filename: "big.png",
        mimeType: "image/png",
        sizeBytes: 99,
      }),
    ).rejects.toMatchObject({ reason: "File too large", pluginId: "justflows.test" });
  });

  it("refuses ensureType without content:create", async () => {
    await expect(
      activate(
        makePlugin({}, async (ctx) => {
          await ctx.content.ensureType({ slug: "product", label: "Product" });
        }),
      ),
    ).rejects.toThrow(/content:create/);
  });

  it("refuses published ensurePage without content:publish", async () => {
    await expect(
      activate(
        makePlugin({ permissions: ["content:create"] }, async (ctx) => {
          await ctx.content.ensurePage({
            type: "shop",
            title: "Shop",
            slug: "shop",
            status: "published",
          });
        }),
      ),
    ).rejects.toThrow(/content:publish/);
  });

  it("allows ensureType and published ensurePage when both permissions are declared", async () => {
    const ensureType = vi.fn().mockResolvedValue({ created: true, id: "t", slug: "shop" });
    const ensurePage = vi.fn().mockResolvedValue({ created: true, id: "p", slug: "shop" });
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      contentFactory: () => ({ ensureType, ensurePage, deleteType: vi.fn() }),
    });
    loader.register(
      makePlugin({ permissions: ["content:create", "content:publish"] }, async (ctx) => {
        await ctx.content.ensureType({ slug: "shop", label: "Shop" });
        await ctx.content.ensurePage({
          type: "shop",
          title: "Shop",
          slug: "shop",
          status: "published",
        });
      }),
    );
    await loader.activate("justflows.test", "site-1");
    expect(ensureType).toHaveBeenCalledWith({ slug: "shop", label: "Shop" });
    expect(ensurePage).toHaveBeenCalledWith({
      type: "shop",
      title: "Shop",
      slug: "shop",
      status: "published",
    });
  });

  it("refuses deleteType without content:delete", async () => {
    await expect(
      activate(
        makePlugin({ permissions: ["content:create"] }, async (ctx) => {
          await ctx.content.deleteType("shop");
        }),
      ),
    ).rejects.toThrow(/content:delete/);
  });

  it("allows deleteType when content:delete is declared", async () => {
    const deleteType = vi.fn().mockResolvedValue({ pages: 2, typeDeleted: true });
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      contentFactory: () => ({
        ensureType: vi.fn(),
        ensurePage: vi.fn(),
        deleteType,
      }),
    });
    loader.register(
      makePlugin({ permissions: ["content:delete"] }, async (ctx) => {
        await ctx.content.deleteType("product");
      }),
    );
    await loader.activate("justflows.test", "site-1");
    expect(deleteType).toHaveBeenCalledWith("product");
  });

  it("collects cookie declarations, applies overrides, and drops them on deactivate", async () => {
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      coreCookies: [
        { name: "jf_session", category: "necessary", purpose: "auth", duration: "session" },
      ],
      cookieOverrides: async () => ({ _ga: "marketing" }),
    });
    let list: Awaited<ReturnType<PluginContext["cookies"]["list"]>> = [];
    const plugin = makePlugin({}, async (ctx) => {
      ctx.cookies.declare({ name: "_ga", category: "analytics", purpose: "Google Analytics" });
      list = await ctx.cookies.list();
    });
    loader.register(plugin);
    await loader.activate(plugin.manifest.id, "site-1");

    expect(list.map((c) => c.name).sort()).toEqual(["_ga", "jf_session"]);
    const ga = list.find((c) => c.name === "_ga")!;
    expect(ga.declaredBy).toBe("justflows.test");
    expect(ga.effectiveCategory).toBe("marketing"); // operator override wins
    expect(loader.cookieRegistry.all()).toHaveLength(1);

    await loader.deactivate("justflows.test", "site-1");
    expect(loader.cookieRegistry.all()).toHaveLength(0);
  });

  it("rejects an invalid cookie declaration at declare time", async () => {
    const app = new App(CONFIG);
    const loader = new PluginLoader(app);
    const plugin = makePlugin({}, (ctx) => {
      ctx.cookies.declare({ name: "bad name", category: "analytics", purpose: "x" } as never);
    });
    loader.register(plugin);
    await expect(loader.activate(plugin.manifest.id, "site-1")).rejects.toThrow(/invalid cookie/i);
  });

  it("runs deleteData and then the plugin.deleteData action", async () => {
    const deleteData = vi.fn();
    const seen: unknown[] = [];
    const plugin = makePlugin({}, () => {});
    plugin.deleteData = deleteData;
    const app = new App(CONFIG);
    const loader = new PluginLoader(app);
    loader.register(plugin);
    app.hooks.action("plugin.deleteData", (event) => {
      seen.push(event);
    });
    await loader.deleteData("justflows.test", "site-1");
    expect(deleteData).toHaveBeenCalledOnce();
    expect(seen).toEqual([
      expect.objectContaining({ pluginId: "justflows.test", version: "1.0.0", siteId: "site-1" }),
    ]);
  });
});
