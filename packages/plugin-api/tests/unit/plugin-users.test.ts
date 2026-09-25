import { describe, expect, it, vi } from "vitest";
import { App, type AppConfig } from "@justflows/core";
import type { PluginContext, PluginModule, PluginUserCreateResult } from "@justflows/sdk";
import { PluginLoader } from "../../src/loader.js";

const CONFIG = {
  env: "test",
  url: "http://localhost:3000",
  logLevel: "error",
} as unknown as AppConfig;

function plugin(
  id: string,
  permissions: string[],
  activate: (ctx: PluginContext) => void,
): PluginModule {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      license: "GPL-2.0-or-later",
      permissions,
      main: "index.js",
    } as PluginModule["manifest"],
    activate,
    deleteData: async () => undefined,
  };
}

describe("plugin user creation", () => {
  it("creates a user only in a role the plugin registered", async () => {
    const create = vi.fn(
      async (): Promise<PluginUserCreateResult> => ({
        ok: true,
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "ada@example.com",
          username: "ada",
          displayName: "Ada",
          role: "customer",
        },
      }),
    );
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      usersFactory: () => ({ create }),
    });
    let shop: PluginContext | undefined;
    let other: PluginContext | undefined;
    loader.register(
      plugin("justflows.shop", ["users:manage"], (ctx) => {
        shop = ctx;
        ctx.roles.register({ id: "customer", label: "Customer", capabilities: [] });
      }),
    );
    loader.register(
      plugin("justflows.other", ["users:manage"], (ctx) => {
        other = ctx;
      }),
    );
    await loader.activate("justflows.shop", "site-1");
    await loader.activate("justflows.other", "site-1");

    const input = {
      email: "ada@example.com",
      username: "ada",
      displayName: "Ada",
      password: "correct-horse-battery",
      role: "customer",
    };
    const actor = { userId: "admin", role: "administrator" };
    await expect(shop!.users.create(input, actor)).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(create).toHaveBeenCalledTimes(1);

    await expect(other!.users.create(input, actor)).resolves.toEqual({
      ok: false,
      status: 400,
      error: "Plugins can only create users in a role they registered.",
    });
    await expect(shop!.users.create({ ...input, role: "administrator" }, actor)).resolves.toEqual({
      ok: false,
      status: 400,
      error: "Plugins can only create users in a role they registered.",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects user creation without users:manage", async () => {
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      usersFactory: () => ({ create: vi.fn() }),
    });
    let ctx: PluginContext | undefined;
    loader.register(
      plugin("justflows.shop", [], (context) => {
        ctx = context;
        context.roles.register({ id: "customer", label: "Customer", capabilities: [] });
      }),
    );
    await loader.activate("justflows.shop", "site-1");
    await expect(
      ctx!.users.create(
        {
          email: "ada@example.com",
          username: "ada",
          displayName: "Ada",
          password: "correct-horse-battery",
          role: "customer",
        },
        { userId: "admin", role: "administrator" },
      ),
    ).rejects.toThrow(/users:manage/);
  });
});
