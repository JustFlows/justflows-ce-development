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

  it("adds only a role the plugin registered, and only with users:manage", async () => {
    const addRole = vi.fn(async () => ({
      ok: true as const,
      user: { id: "u1", email: "ada@example.com", username: "ada", displayName: "Ada", role: "subscriber", roles: ["subscriber", "customer"] },
    }));
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      usersFactory: () => ({ create: vi.fn(), addRole }),
    });
    let shop: PluginContext | undefined;
    let other: PluginContext | undefined;
    let unprivileged: PluginContext | undefined;
    loader.register(
      plugin("justflows.shop", ["users:manage"], (ctx) => {
        shop = ctx;
        ctx.roles.register({ id: "customer", label: "Customer", capabilities: [] });
      }),
    );
    loader.register(plugin("justflows.other", ["users:manage"], (ctx) => { other = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { unprivileged = ctx; }));
    await loader.activate("justflows.shop", "site-1");
    await loader.activate("justflows.other", "site-1");
    await loader.activate("justflows.plain", "site-1");
    const actor = { userId: "admin", role: "administrator" };

    await expect(shop!.users.addRole!({ email: "ada@example.com" }, "customer", actor)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(addRole).toHaveBeenCalledWith({ email: "ada@example.com" }, "customer", actor);

    const refused = { ok: false, status: 400, error: "Plugins can only add a role they registered." };
    await expect(other!.users.addRole!({ userId: "u1" }, "customer", actor)).resolves.toEqual(refused);
    await expect(shop!.users.addRole!({ userId: "u1" }, "editor", actor)).resolves.toEqual(refused);
    await expect(unprivileged!.users.addRole!({ userId: "u1" }, "customer", actor)).rejects.toThrow(/users:manage/);
    expect(addRole).toHaveBeenCalledTimes(1);
  });

  it("reads a user only with users:manage", async () => {
    const user = { id: "u1", email: "ada@example.com", username: "ada", displayName: "Ada", role: "subscriber", roles: ["subscriber"] };
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { usersFactory: () => ({ create: vi.fn(), get: async () => user }) });
    let shop: PluginContext | undefined;
    let plain: PluginContext | undefined;
    loader.register(plugin("justflows.shop", ["users:manage"], (ctx) => { shop = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { plain = ctx; }));
    await loader.activate("justflows.shop", "site-1");
    await loader.activate("justflows.plain", "site-1");

    await expect(shop!.users.get!("u1")).resolves.toEqual(user);
    await expect(plain!.users.get!("u1")).rejects.toThrow(/users:manage/);
  });

  it("removes only a role the plugin registered, and only with users:manage", async () => {
    const removeRole = vi.fn(async () => ({
      ok: true as const,
      user: { id: "u1", email: "ada@example.com", username: "ada", displayName: "Ada", role: "subscriber", roles: ["subscriber"] },
    }));
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, {
      usersFactory: () => ({ create: vi.fn(), removeRole }),
    });
    let shop: PluginContext | undefined;
    let other: PluginContext | undefined;
    let unprivileged: PluginContext | undefined;
    loader.register(
      plugin("justflows.shop", ["users:manage"], (ctx) => {
        shop = ctx;
        ctx.roles.register({ id: "member", label: "Member", capabilities: [] });
      }),
    );
    loader.register(plugin("justflows.other", ["users:manage"], (ctx) => { other = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { unprivileged = ctx; }));
    await loader.activate("justflows.shop", "site-1");
    await loader.activate("justflows.other", "site-1");
    await loader.activate("justflows.plain", "site-1");
    const actor = { userId: "", role: "member" };
    await expect(shop!.users.removeRole!({ userId: "u1" }, "member", actor)).resolves.toMatchObject({ ok: true });
    expect(removeRole).toHaveBeenCalledWith({ userId: "u1" }, "member", actor);
    await expect(other!.users.removeRole!({ userId: "u1" }, "member", actor)).resolves.toEqual({
      ok: false,
      status: 400,
      error: "Plugins can only remove a role they registered.",
    });
    await expect(shop!.users.removeRole!({ userId: "u1" }, "editor", actor)).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(unprivileged!.users.removeRole!({ userId: "u1" }, "member", actor)).rejects.toThrow(/users:manage/);
    expect(removeRole).toHaveBeenCalledTimes(1);
  });
});
