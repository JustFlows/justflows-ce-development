import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../../src/lib/database/db.js";
import { ensureWorkspaceOwnerAccount } from "../../../src/lib/tenancy/workspace-owner.js";

const owner = { email: "Owner@Example.com", username: "owner", displayName: "Owner", passwordHash: "hashed-password" };
const stamp = "2026-10-09 12:00:00";

function database(existing: boolean, usernameTaken = false, root = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM sites")) return root ? [{ id: "root-site" }] : [];
    if (sql.includes("email =")) return existing ? [{ id: "existing-owner" }] : [];
    return usernameTaken ? [{ id: "someone-else" }] : [];
  });
  const run = vi.fn(async (_sql: string, _params?: unknown[]) => ({ changes: 1 }));
  const db = { query, run, transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ query, run }) };
  return { db: db as unknown as DbClient, query, run };
}

describe("workspace owner root account", () => {
  it("creates a subscriber on the root site with the workspace owner's credentials", async () => {
    const { db, query, run } = database(false);
    const result = await ensureWorkspaceOwnerAccount(db, owner, stamp);
    expect(result).toMatchObject({ siteId: "root-site", created: true });
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(run).toHaveBeenCalledWith(expect.stringContaining("'subscriber'"), [result.userId, "root-site", "owner@example.com", "owner", "Owner", "hashed-password", stamp, stamp]);
    expect(run.mock.calls).toHaveLength(1);
  });

  it("reuses an existing root user without replacing their password or privileges", async () => {
    const { db, run } = database(true);
    expect(await ensureWorkspaceOwnerAccount(db, owner, stamp)).toEqual({ siteId: "root-site", userId: "existing-owner", created: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("handles a root username belonging to another email within the schema limit", async () => {
    const { db, run } = database(false, true);
    const result = await ensureWorkspaceOwnerAccount(db, { ...owner, username: "a".repeat(60) }, stamp);
    const params = run.mock.calls[0]?.[1] as unknown as string[];
    expect(params[3]).toBe(`${"a".repeat(23)}-${result.userId}`);
    expect(params[3]?.length).toBe(60);
  });

  it("refuses to create an account without an installation root", async () => {
    const { db, run } = database(false, false, false);
    await expect(ensureWorkspaceOwnerAccount(db, owner, stamp)).rejects.toThrow("root site");
    expect(run).not.toHaveBeenCalled();
  });
});
