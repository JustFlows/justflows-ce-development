// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";

const runs: Array<{ sql: string; params: unknown[] }> = [];
const setup = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ ok: true, expiresAt: "2026-11-27T00:00:00.000Z" })));

vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({
    query: async () => [],
    run: async (sql: string, params: unknown[] = []) => void runs.push({ sql, params }),
  }),
}));
vi.mock("../../../src/lib/settings/general-settings.js", () => ({ getGeneralSettings: async () => ({ defaultRole: "subscriber" }) }));
vi.mock("../../../src/lib/auth/assignable-roles.js", () => ({ isAssignableRole: async () => true, listAssignableRoles: async () => [] }));
vi.mock("../../../src/lib/auth/delegation.js", () => ({
  delegationAuthority: async () => ({ unrestricted: true }),
  exceedsAuthority: () => false,
  roleCapabilitiesToDelegate: async () => [],
  customRoleCapabilities: async () => [],
}));
vi.mock("../../../src/lib/tenancy/quotas.js", () => ({ enforceQuota: async () => null }));
vi.mock("../../../src/lib/auth/password.js", () => ({ hashPassword: async (value: string) => `hash:${value}` }));
vi.mock("../../../src/lib/security/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({ dispatchAction: async () => undefined }) }));
vi.mock("../../../src/lib/auth/password-reset.js", () => ({ sendPasswordSetup: setup }));

const { createManagedUser, ManageCreateUserSchema } = await import("../../../src/lib/auth/users-admin.js");

const actor = { siteId: "site-1", userId: "admin", role: "administrator" };
const account = { email: "sam@example.com", username: "sam", displayName: "Sam" };

beforeEach(() => {
  runs.length = 0;
  setup.mockClear();
});

describe("createManagedUser", () => {
  it("emails a set-password link instead of taking a password, and never returns one", async () => {
    const result = await createManagedUser(account, actor);
    expect(result).toMatchObject({ status: 201, body: { email: "sam@example.com", setupEmail: { sent: true } } });
    expect(setup).toHaveBeenCalledWith("site-1", expect.any(String), { userId: "admin", role: "administrator" });
    const hash = String(runs[0]!.params.find((value) => String(value).startsWith("hash:")));
    expect(hash.length).toBeGreaterThan(40);
    expect(JSON.stringify(result.body)).not.toContain(hash.slice(5));
  });

  it("reports a mail that could not be sent on the created user", async () => {
    setup.mockResolvedValueOnce({ ok: false, status: 502, error: "The email could not be sent." });
    expect(await createManagedUser(account, actor)).toMatchObject({ status: 201, body: { setupEmail: { sent: false, error: "The email could not be sent." } } });
  });

  it("still takes a password from API clients, under the same policy", async () => {
    expect(await createManagedUser({ ...account, password: "a-Long-passw0rd!" }, actor)).toMatchObject({ status: 201 });
    expect(setup).not.toHaveBeenCalled();
    expect(ManageCreateUserSchema.safeParse({ ...account, password: "x" }).success).toBe(false);
    expect(ManageCreateUserSchema.safeParse(account).success).toBe(true);
  });
});
