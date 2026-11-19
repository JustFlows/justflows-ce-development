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
      plugin("justflows.store", ["users:manage"], (ctx) => {
        shop = ctx;
        ctx.roles.register({ id: "customer", label: "Customer", capabilities: [] });
      }),
    );
    loader.register(
      plugin("justflows.other", ["users:manage"], (ctx) => {
        other = ctx;
      }),
    );
    await loader.activate("justflows.store", "site-1");
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
      plugin("justflows.store", [], (context) => {
        ctx = context;
        context.roles.register({ id: "customer", label: "Customer", capabilities: [] });
      }),
    );
    await loader.activate("justflows.store", "site-1");
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
      plugin("justflows.store", ["users:manage"], (ctx) => {
        shop = ctx;
        ctx.roles.register({ id: "customer", label: "Customer", capabilities: [] });
      }),
    );
    loader.register(plugin("justflows.other", ["users:manage"], (ctx) => { other = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { unprivileged = ctx; }));
    await loader.activate("justflows.store", "site-1");
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
    loader.register(plugin("justflows.store", ["users:manage"], (ctx) => { shop = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { plain = ctx; }));
    await loader.activate("justflows.store", "site-1");
    await loader.activate("justflows.plain", "site-1");

    await expect(shop!.users.get!("u1")).resolves.toEqual(user);
    await expect(plain!.users.get!("u1")).rejects.toThrow(/users:manage/);
  });

  it("finds and searches users with users:read, and refuses without it", async () => {
    const user = { id: "u1", email: "ada@example.com", username: "ada", displayName: "Ada", role: "subscriber", roles: ["subscriber"] };
    const find = vi.fn(async () => user);
    const search = vi.fn(async () => [user]);
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { usersFactory: () => ({ create: vi.fn(), find, search }) });
    let reader: PluginContext | undefined;
    let plain: PluginContext | undefined;
    loader.register(plugin("justflows.reader", ["users:read"], (ctx) => { reader = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { plain = ctx; }));
    await loader.activate("justflows.reader", "site-1");
    await loader.activate("justflows.plain", "site-1");

    await expect(reader!.users.find!({ email: "ada@example.com" })).resolves.toEqual(user);
    await expect(reader!.users.search!({ query: "ada" })).resolves.toEqual([user]);
    expect(search).toHaveBeenCalledWith({ query: "ada" });
    await expect(plain!.users.find!({ email: "ada@example.com" })).rejects.toThrow(/users:read/);
    await expect(plain!.users.search!({ query: "ada" })).rejects.toThrow(/users:read/);
  });

  it("reads an account's second factors with users:read, and refuses without it", async () => {
    const secondFactors = vi.fn(async (userId: string) => (userId === "u1" ? { totp: false, passkeys: 2 } : null));
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { usersFactory: () => ({ create: vi.fn(), secondFactors }) });
    let reader: PluginContext | undefined;
    let plain: PluginContext | undefined;
    loader.register(plugin("justflows.reader", ["users:read"], (ctx) => { reader = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { plain = ctx; }));
    await loader.activate("justflows.reader", "site-1");
    await loader.activate("justflows.plain", "site-1");

    await expect(reader!.users.secondFactors!("u1")).resolves.toEqual({ totp: false, passkeys: 2 });
    await expect(reader!.users.secondFactors!("elsewhere")).resolves.toBeNull();
    await expect(plain!.users.secondFactors!("u1")).rejects.toThrow(/users:read/);
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
      plugin("justflows.store", ["users:manage"], (ctx) => {
        shop = ctx;
        ctx.roles.register({ id: "member", label: "Member", capabilities: [] });
      }),
    );
    loader.register(plugin("justflows.other", ["users:manage"], (ctx) => { other = ctx; }));
    loader.register(plugin("justflows.plain", [], (ctx) => { unprivileged = ctx; }));
    await loader.activate("justflows.store", "site-1");
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

describe("plugin password setup links", () => {
  it("invites only users holding a role the plugin registered, and needs users:manage", async () => {
    const people: Record<string, { roles: string[] }> = { "u-staff": { roles: ["staff-member"] }, "u-admin": { roles: ["administrator"] } };
    const sendPasswordSetup = vi.fn(async () => ({ ok: true as const, expiresAt: "2026-11-20T00:00:00.000Z" }));
    const find = vi.fn(async (target: { userId?: string; email?: string }) => {
      const id = target.userId ?? "";
      return people[id] ? { id, email: `${id}@example.com`, username: id, displayName: id, role: people[id]!.roles[0]!, roles: people[id]!.roles } : null;
    });
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { usersFactory: () => ({ create: vi.fn(), find, sendPasswordSetup }) as never });
    let owner: PluginContext | undefined;
    let reader: PluginContext | undefined;
    loader.register(
      plugin("justflows.team", ["users:manage"], (ctx) => {
        owner = ctx;
        ctx.roles.register({ id: "staff-member", label: "Staff member", capabilities: [] });
      }),
    );
    loader.register(plugin("justflows.reader", ["users:read"], (ctx) => { reader = ctx; }));
    await loader.activate("justflows.team", "site-1");
    await loader.activate("justflows.reader", "site-1");
    const actor = { userId: "admin", role: "administrator" };

    await expect(owner!.users.sendPasswordSetup!({ userId: "u-staff" }, actor)).resolves.toEqual({ ok: true, expiresAt: "2026-11-20T00:00:00.000Z" });
    await expect(owner!.users.sendPasswordSetup!({ userId: "u-admin" }, actor)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(owner!.users.sendPasswordSetup!({ userId: "nobody" }, actor)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(reader!.users.sendPasswordSetup!({ userId: "u-staff" }, actor)).rejects.toThrow(/users:manage/);
    expect(sendPasswordSetup).toHaveBeenCalledTimes(1);
  });
});

describe("plugin user deletion", () => {
  it("deletes only users whose every role the plugin registered, and needs users:manage", async () => {
    const people: Record<string, { roles: string[] }> = {
      "u-demo": { roles: ["demo-customer"] },
      "u-mixed": { roles: ["subscriber", "demo-customer"] },
      "u-admin": { roles: ["administrator"] },
    };
    const remove = vi.fn(async () => ({ ok: true as const }));
    const find = vi.fn(async (target: { userId?: string; email?: string }) => {
      const id = target.userId ?? "";
      return people[id] ? { id, email: `${id}@example.com`, username: id, displayName: id, role: people[id]!.roles[0]!, roles: people[id]!.roles } : null;
    });
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { usersFactory: () => ({ create: vi.fn(), find, delete: remove }) as never });
    let owner: PluginContext | undefined;
    let reader: PluginContext | undefined;
    loader.register(
      plugin("justflows.demo", ["users:manage"], (ctx) => {
        owner = ctx;
        ctx.roles.register({ id: "demo-customer", label: "Demo customer", capabilities: [] });
      }),
    );
    loader.register(plugin("justflows.reader", ["users:read"], (ctx) => { reader = ctx; }));
    await loader.activate("justflows.demo", "site-1");
    await loader.activate("justflows.reader", "site-1");
    const actor = { userId: "admin", role: "administrator" };

    await expect(owner!.users.delete!({ userId: "u-demo" }, actor)).resolves.toEqual({ ok: true });
    /** Someone who also holds a role the plugin did not register, or a core role, is not the plugin's to delete. */
    await expect(owner!.users.delete!({ userId: "u-mixed" }, actor)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(owner!.users.delete!({ userId: "u-admin" }, actor)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(owner!.users.delete!({ userId: "nobody" }, actor)).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(reader!.users.delete!({ userId: "u-demo" }, actor)).rejects.toThrow(/users:manage/);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("plugin profile updates", () => {
  it("updates only the acting member's own account or an account wholly the plugin's, and needs users:manage", async () => {
    const people: Record<string, { roles: string[] }> = { "u-demo": { roles: ["demo-customer"] }, "u-member": { roles: ["subscriber"] }, "u-admin": { roles: ["administrator"] } };
    const updateProfile = vi.fn(async () => ({ ok: true as const }));
    const find = vi.fn(async (target: { userId?: string; email?: string }) => {
      const id = target.userId ?? "";
      return people[id] ? { id, email: `${id}@example.com`, username: id, displayName: id, role: people[id]!.roles[0]!, roles: people[id]!.roles } : null;
    });
    const app = new App(CONFIG);
    const loader = new PluginLoader(app, { usersFactory: () => ({ create: vi.fn(), find, updateProfile }) as never });
    let owner: PluginContext | undefined;
    let reader: PluginContext | undefined;
    loader.register(plugin("justflows.demo", ["users:manage"], (ctx) => { owner = ctx; ctx.roles.register({ id: "demo-customer", label: "Demo customer", capabilities: [] }); }));
    loader.register(plugin("justflows.reader", ["users:read"], (ctx) => { reader = ctx; }));
    await loader.activate("justflows.demo", "site-1");
    await loader.activate("justflows.reader", "site-1");
    const admin = { userId: "u-admin", role: "administrator" };
    await expect(owner!.users.updateProfile!({ userId: "u-demo" }, { birthDate: "2014-08-12" }, admin)).resolves.toEqual({ ok: true });
    /** A member's own account, when they are the one acting. */
    await expect(owner!.users.updateProfile!({ userId: "u-member" }, { birthDate: "2014-08-12" }, { userId: "u-member", role: "subscriber" })).resolves.toEqual({ ok: true });
    await expect(owner!.users.updateProfile!({ userId: "u-member" }, { birthDate: "2014-08-12" }, admin)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(owner!.users.updateProfile!({ userId: "u-admin" }, { birthDate: null }, { userId: "u-member", role: "subscriber" })).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(reader!.users.updateProfile!({ userId: "u-demo" }, { birthDate: null }, admin)).rejects.toThrow(/users:manage/);
    expect(updateProfile).toHaveBeenCalledTimes(2);
  });
});
