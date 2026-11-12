// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../../src/lib/database/db.js";
import { installationRootSiteId, resolveHost } from "../../../src/lib/tenancy/registry.js";

function failingClient(error: unknown, okUntil = 0): DbClient {
  let calls = 0;
  return {
    query: vi.fn(async (sql: string) => {
      calls += 1;
      if (calls <= okUntil) return sql.includes("COUNT") ? [{ count: 2 }] : [{ id: "root" }];
      throw error;
    }),
  } as unknown as DbClient;
}

const timeout = Object.assign(new Error("Connection terminated due to connection timeout"), { code: "ETIMEDOUT" });
const missingTable = Object.assign(new Error('relation "sites" does not exist'), { code: "42P01" });

describe("tenant registry failures", () => {
  it("reports a failed routing query as unavailable, never as single-site", async () => {
    await expect(resolveHost("a.example.com", failingClient(timeout))).resolves.toEqual({ kind: "unavailable" });
  });

  it("does not drop the active-domain filter when the domain query fails for another reason", async () => {
    await expect(resolveHost("a.example.com", failingClient(timeout, 2))).resolves.toEqual({ kind: "unavailable" });
  });

  it("treats a database without tenancy tables as a single-site install", async () => {
    await expect(resolveHost("a.example.com", failingClient(missingTable))).resolves.toEqual({ kind: "unconfigured" });
    await expect(installationRootSiteId(failingClient(missingTable))).resolves.toBeNull();
  });

  it("does not answer root identity when the lookup fails", async () => {
    await expect(installationRootSiteId(failingClient(timeout))).rejects.toThrow("timeout");
  });
});

describe("multisite switch", () => {
  const row = (hostname: string, siteId: string) => ({
    hostname, site_id: siteId, tenant_id: `t-${siteId}`, site_status: "active", tenant_status: "active",
    user_mode: "isolated", database_mode: "shared", database_choice: "current",
  });
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("COUNT")) return [{ count: 2 }];
      if (sql.includes("LIMIT 1")) return [{ id: "root" }];
      return [row("root.example.com", "root"), row("other.example.com", "other")];
    }),
  } as unknown as DbClient;

  it("serves only the root site while off and every site while on", async () => {
    const original = process.env.JF_MULTISITE;
    try {
      delete process.env.JF_MULTISITE;
      await expect(resolveHost("root.example.com", client)).resolves.toMatchObject({ kind: "ready", record: { siteId: "root" } });
      await expect(resolveHost("other.example.com", client)).resolves.toEqual({ kind: "unknown" });
      process.env.JF_MULTISITE = "true";
      await expect(resolveHost("other.example.com", client)).resolves.toMatchObject({ kind: "ready", record: { siteId: "other" } });
    } finally {
      if (original === undefined) delete process.env.JF_MULTISITE;
      else process.env.JF_MULTISITE = original;
    }
  });
});
