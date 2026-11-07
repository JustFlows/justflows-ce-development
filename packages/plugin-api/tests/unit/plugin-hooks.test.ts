import { describe, it, expect, vi } from "vitest";
import { App, type AppConfig } from "@justflows/core";
import type { PluginModule, PluginContext } from "@justflows/sdk";
import { PluginLoader } from "../../src/loader.js";

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
    expect(seen?.runtime).toEqual({ justflows: "0.1.8-dev.1", sdk: "0.1.8", sdkApi: 1 });
  });

  it("refuses a network handler without platform:network", async () => {
    const app = new App(CONFIG);
    const loader = new PluginLoader(app);
    const plugin = makePlugin({ permissions: ["admin:extend"] }, (ctx) => {
      ctx.hooks.filter("admin.body", (html) => html, { network: true });
    });
    loader.register(plugin);
    await expect(loader.activate(plugin.manifest.id, "site-1")).rejects.toThrow(/platform:network/);
  });

  it("registers a network handler and exposes ctx.network with platform:network", async () => {
    const app = new App(CONFIG);
    const network = {
      mainSiteSettings: { get: vi.fn().mockResolvedValue("G-NET") },
      sites: vi.fn().mockResolvedValue([]),
    };
    const loader = new PluginLoader(app, { networkFactory: () => network });
    let seen: PluginContext | undefined;
    const plugin = makePlugin({ permissions: ["admin:extend", "platform:network"] }, (ctx) => {
      seen = ctx;
      ctx.hooks.filter("admin.body", (html) => `${html}tag`, { network: true });
    });
    loader.register(plugin);
    await loader.activate(plugin.manifest.id, "site-1");

    expect(seen?.network).toBe(network);
    const registration = app.hooks.inspect().find((hook) => hook.hook === "admin.body");
    expect(registration?.pluginId).toBe("justflows.test");
    expect(await app.hooks.applyFilter("admin.body", "", { siteId: "site-1" })).toBe("tag");
  });

  it("leaves ctx.network out without platform:network", async () => {
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { networkFactory: () => ({ mainSiteSettings: { get: vi.fn() }, sites: vi.fn() }) });
    let seen: PluginContext | undefined;
    const plugin = makePlugin({}, (ctx) => {
      seen = ctx;
    });
    loader.register(plugin);
    await loader.activate(plugin.manifest.id, "site-1");
    expect(seen?.network).toBeUndefined();
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

  it("registers a visibility rule only with content:read, and drops it on deactivate", async () => {
    const rule = { id: "sample", label: "Sample", evaluate: () => ({ effect: "allow" as const, reason: "ok" }) };
    const refused = makePlugin({ id: "justflows.refused", permissions: [] }, (ctx) => {
      expect(() => ctx.visibility.registerRule(rule)).toThrow(/content:read/);
    });
    await activate(refused);
    const { loader } = await activate(makePlugin({ permissions: ["content:read"] }, (ctx) => {
      ctx.visibility.registerRule(rule);
    }));
    const [registered] = loader.visibilityRuleRegistry.all();
    expect(registered?.registryId).toMatch(/:sample$/);
    await loader.deactivate(registered!.pluginId, "site-1");
    expect(loader.visibilityRuleRegistry.all()).toEqual([]);
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

  it("tags an emitted hook with the site the call is for", async () => {
    const app = new App(CONFIG);
    let current: string | undefined;
    const loader = new PluginLoader(app, { currentSiteId: () => current });
    let ctx: PluginContext | undefined;
    loader.register(makePlugin({}, (c) => { ctx = c; }));
    await loader.activate("justflows.test", "site-1");
    const sites: Array<string | undefined> = [];
    app.hooks.action("justflows.test.scored", (_event, context) => {
      sites.push(context.siteId);
    });
    // Outside a request or per-site job, the activated site.
    await ctx!.hooks.emit("justflows.test.scored", {} as never);
    // A per-site job running this context for another site.
    current = "site-2";
    await ctx!.hooks.emit("justflows.test.scored", {} as never);
    expect(sites).toEqual(["site-1", "site-2"]);
  });

  it("persists outbound events before isolated listeners and propagates a queue failure", async () => {
    const app = new App(CONFIG);
    let fail = true;
    const seen: string[] = [];
    const loader = new PluginLoader(app, { currentSiteId: () => "site-2", eventPublisher: async (_event, _payload, siteId) => {
      seen.push(`queue:${siteId}`);
      if (fail) throw new Error("database unavailable");
    } });
    let ctx: PluginContext | undefined;
    loader.register(makePlugin({}, c => { ctx = c; }));
    await loader.activate("justflows.test", "site-1");
    app.hooks.action("justflows.test.scored", (_event, context) => {
      expect(context.webhookQueued).toBe(true);
      seen.push("listener");
    });
    await expect(ctx!.hooks.emit("justflows.test.scored", {} as never, { durable: true })).rejects.toThrow("database unavailable");
    expect(seen).toEqual(["queue:site-2"]);
    fail = false;
    await ctx!.hooks.emit("justflows.test.scored", {} as never, { durable: true });
    expect(seen).toEqual(["queue:site-2", "queue:site-2", "listener"]);
  });

  it("keeps ordinary action semantics and fails closed when durable delivery is unavailable", async () => {
    const app = new App(CONFIG);
    const loader = new PluginLoader(app);
    let ctx: PluginContext | undefined;
    loader.register(makePlugin({}, c => { ctx = c; }));
    await loader.activate("justflows.test", "site-1");
    await expect(ctx!.hooks.emit("justflows.test.scored", {} as never)).resolves.toBeUndefined();
    await expect(ctx!.hooks.emit("justflows.test.scored", {} as never, { durable: true })).rejects.toThrow("not available");
  });

  it("lets a plugin apply operatorKey.ensure and stamps the caller's id", async () => {
    const app = new App(CONFIG);
    const seen: string[] = [];
    app.hooks.filter<{ name: string }, { pluginId: string }>("operatorKey.ensure", (value, context) => {
      seen.push(`${context.pluginId}:${value.name}`);
      return value;
    });
    const loader = new PluginLoader(app);
    loader.register(makePlugin({}, async (ctx) => {
      await ctx.hooks.apply("operatorKey.ensure", { name: "JUSTFLOWS_TEST_KEK" }, { pluginId: "justflows.other" });
    }));
    await loader.activate("justflows.test", "site-1");
    expect(seen).toEqual(["justflows.test:JUSTFLOWS_TEST_KEK"]);
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

  it("refuses private files without files:private and allows them with it", async () => {
    const put = vi.fn().mockResolvedValue({ key: "a.txt", size: 1, contentType: "text/plain", sha256: "", createdAt: "", updatedAt: "" });
    const filesFactory = () => ({ put, get: vi.fn(), read: vi.fn(), delete: vi.fn(), list: vi.fn() });
    const denied = new PluginLoader(new App(CONFIG), { filesFactory });
    denied.register(makePlugin({}, async (ctx) => {
      await ctx.files!.put("a.txt", Buffer.from("x"));
    }));
    await expect(denied.activate("justflows.test", "site-1")).rejects.toThrow(/files:private/);
    expect(put).not.toHaveBeenCalled();

    const allowed = new PluginLoader(new App(CONFIG), { filesFactory });
    allowed.register(makePlugin({ permissions: ["files:private"] }, async (ctx) => {
      await ctx.files!.put("a.txt", Buffer.from("x"), { contentType: "text/plain" });
    }));
    await allowed.activate("justflows.test", "site-1");
    expect(put).toHaveBeenCalledWith("a.txt", Buffer.from("x"), { contentType: "text/plain" });
  });

  it("refuses getPublished without content:read", async () => {
    const app = new App(CONFIG);
    const getPublished = vi.fn().mockResolvedValue(null);
    const loader = new PluginLoader(app, {
      contentFactory: () => ({
        getPublished,
        ensureType: vi.fn(),
        ensurePage: vi.fn(),
        listPublished: vi.fn().mockResolvedValue([]),
        deleteType: vi.fn(),
        deletePages: vi.fn(),
        deleteCreatedBy: vi.fn(),
      }),
    });
    loader.register(
      makePlugin({}, async (ctx) => {
        await ctx.content.getPublished!({ type: "shop", slug: "product" });
      }),
    );
    await expect(loader.activate("justflows.test", "site-1")).rejects.toThrow(/content:read/);
    expect(getPublished).not.toHaveBeenCalled();
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
      contentFactory: () => ({
        ensureType,
        ensurePage,
        listPublished: vi.fn().mockResolvedValue([]),
        deleteType: vi.fn(),
        deletePages: vi.fn(),
        deleteCreatedBy: vi.fn(),
      }),
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
        listPublished: vi.fn().mockResolvedValue([]),
        deleteType,
        deletePages: vi.fn(),
        deleteCreatedBy: vi.fn(),
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

  it("refuses deleteCreatedBy without content:delete", async () => {
    const deleteCreatedBy = vi.fn();
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      contentFactory: () => ({
        ensureType: vi.fn(),
        ensurePage: vi.fn(),
        listPublished: vi.fn().mockResolvedValue([]),
        deleteType: vi.fn(),
        deletePages: vi.fn(),
        deleteCreatedBy,
      }),
    });
    loader.register(
      makePlugin({ permissions: [] }, async (ctx) => {
        await ctx.content.deleteCreatedBy("user-1");
      }),
    );
    await expect(loader.activate("justflows.test", "site-1")).rejects.toThrow(/content:delete/);
    expect(deleteCreatedBy).not.toHaveBeenCalled();
  });

  it("allows deleteCreatedBy when content:delete is declared", async () => {
    const deleteCreatedBy = vi.fn().mockResolvedValue({ ok: true, content: 1, media: 0, comments: 0 });
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      contentFactory: () => ({
        ensureType: vi.fn(),
        ensurePage: vi.fn(),
        listPublished: vi.fn().mockResolvedValue([]),
        deleteType: vi.fn(),
        deletePages: vi.fn(),
        deleteCreatedBy,
      }),
    });
    loader.register(
      makePlugin({ permissions: ["content:delete"] }, async (ctx) => {
        await ctx.content.deleteCreatedBy("user-1");
      }),
    );
    await loader.activate("justflows.test", "site-1");
    expect(deleteCreatedBy).toHaveBeenCalledWith("user-1");
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


it("exposes neutral URLs through the host context and removes aliases on deactivation", async () => {
  let url = "";
  const plugin = makePlugin({ apiNamespace: "shop" }, ctx => {
    url = ctx.http.url("checkout"); ctx.http.get("checkout", async () => ({ body: {} }));
  });
  const { loader } = await activate(plugin);
  expect(url).toBe("/api/shop/checkout");
  expect(loader.httpRouter.match("GET", url)?.route.pluginId).toBe(plugin.manifest.id);
  await loader.deactivate(plugin.manifest.id, "site-1");
  expect(loader.httpRouter.match("GET", url)).toBeUndefined();
});

it("calls another active plugin route with the caller's session", async () => {
  const app = new App(CONFIG);
  const loader = new PluginLoader(app);
  let caller: PluginContext | undefined;
  loader.register(makePlugin({ id: "justflows.caller" }, (ctx) => {
    caller = ctx;
  }));
  loader.register(makePlugin({ id: "justflows.target" }, (ctx) => {
    ctx.http.get("orders", async (req) => ({ status: 200, body: { email: req.session?.email ?? "" } }));
  }));
  await loader.activate("justflows.caller", "site-1");
  await loader.activate("justflows.target", "site-1");
  const result = await caller?.plugins?.call("justflows.target", {
    method: "GET",
    path: "orders",
    session: {
      userId: "user-1",
      siteId: "site-1",
      role: "admin",
      email: "a@b.c",
      capabilities: ["orders:read"],
      scopes: {},
    },
  });
  expect(result?.status).toBe(200);
  expect(result?.body).toEqual({ email: "a@b.c" });
  const missing = await caller?.plugins?.call("justflows.target", { method: "GET", path: "missing" });
  expect(missing?.status).toBe(404);
});
