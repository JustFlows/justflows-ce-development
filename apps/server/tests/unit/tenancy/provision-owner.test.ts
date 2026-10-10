import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { query: vi.fn(async () => []), run: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  return { db, owner: vi.fn(), emit: vi.fn(), action: vi.fn() };
});
vi.mock("../../../src/lib/database/db.js", () => ({
  getControlDb: async () => mocks.db,
  createDbClient: async () => mocks.db,
  runWithDatabase: async (_db: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../../../src/lib/database/run-migrations.js", () => ({ runAllMigrations: vi.fn() }));
vi.mock("../../../src/lib/auth/password.js", () => ({ hashPassword: async () => "password-hash" }));
vi.mock("../../../src/lib/auth/users-admin.js", () => ({ emitUserEvent: mocks.emit }));
vi.mock("../../../src/lib/security/secret-box.js", () => ({ encryptSecret: () => "encrypted", decryptSecret: () => "" }));
vi.mock("../../../src/lib/tenancy/saas-settings.js", () => ({ platformBaseDomain: async () => "example.com" }));
vi.mock("../../../src/lib/tenancy/quotas.js", () => ({ applyQuotaDefaults: vi.fn() }));
vi.mock("../../../src/lib/themes/themes-db.js", () => ({ ensureDefaultTheme: vi.fn() }));
vi.mock("../../../src/lib/tenancy/workspace-owner.js", () => ({ ensureWorkspaceOwnerAccount: mocks.owner }));
vi.mock("../../../src/lib/plugins/plugin-runtime.js", () => ({
  getRuntimeHooks: () => ({ dispatchGate: vi.fn(), dispatchAction: mocks.action }),
}));

import { createWorkspace } from "../../../src/lib/tenancy/provision.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DB_DRIVER", "mariadb");
  mocks.owner.mockResolvedValue({ siteId: "root-site", userId: "root-owner", created: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("workspace provisioning root owner", () => {
  it.each(["current", "separate"] as const)("creates the root account before workspace events with a %s database", async (databaseMode) => {
    const result = await createWorkspace({
      name: "Demo", siteName: "Demo", hostname: "demo.example.com", userMode: "isolated", databaseMode,
      admin: { email: "owner@example.com", username: "owner", displayName: "Owner", password: "new-password" },
      database: { host: "localhost", port: 3306, database: "demo", username: "demo", password: "database-password" },
      actorId: null,
    });
    expect(result.ok).toBe(true);
    expect(mocks.owner).toHaveBeenCalledWith(mocks.db, {
      email: "owner@example.com", username: "owner", displayName: "Owner", passwordHash: "password-hash",
    }, expect.any(String));
    expect(mocks.emit).toHaveBeenCalledWith("user.created", "root-owner", "root-site");
    expect(mocks.db.run).toHaveBeenCalledWith("UPDATE tenants SET owner_user_id = ? WHERE id = ?", ["root-owner", expect.any(String)]);
    expect(mocks.owner.mock.invocationCallOrder[0]).toBeLessThan(mocks.action.mock.invocationCallOrder[0]!);
    expect(mocks.action).toHaveBeenCalledWith("tenancy.workspaceCreated", expect.objectContaining({ adminEmail: "owner@example.com" }), { source: "system" });
  });
});
