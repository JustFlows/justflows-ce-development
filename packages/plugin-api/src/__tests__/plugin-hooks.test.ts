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
      id: "acme.test",
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
  it("attributes a plugin's registrations to the plugin", async () => {
    const { app } = await activate(
      makePlugin({}, (ctx) => {
        ctx.hooks.action("content.published", () => {}, { id: "reindex" });
      }),
    );

    expect(app.hooks.inspect("content.published")).toEqual([
      expect.objectContaining({ pluginId: "acme.test", handlerId: "reindex" }),
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
    await loader.deactivate("acme.test", "site-1");

    await app.hooks.dispatchAction("content.published", { contentId: "c1", siteId: "site-1" });
    expect(fn).not.toHaveBeenCalled();
    expect(app.hooks.count("content.published")).toBe(0);
    expect(app.hooks.count("content.render")).toBe(0);
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
        ctx.hooks.action("acme.test.scored", (event) => { seen.push(event); });
        void ctx.hooks.emit("acme.test.scored", { score: 42 } as never);
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
    ).rejects.toMatchObject({ reason: "File too large", pluginId: "acme.test" });
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
    await loader.activate("acme.test", "site-1");
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
    await loader.activate("acme.test", "site-1");
    expect(deleteType).toHaveBeenCalledWith("product");
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
    await loader.deleteData("acme.test", "site-1");
    expect(deleteData).toHaveBeenCalledOnce();
    expect(seen).toEqual([
      expect.objectContaining({ pluginId: "acme.test", version: "1.0.0", siteId: "site-1" }),
    ]);
  });
});
