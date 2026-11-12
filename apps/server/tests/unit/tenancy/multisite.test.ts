// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn(async () => [{ user_id: "u-1" }]));
vi.mock("../../../src/lib/database/db.js", () => ({ getControlDb: async () => ({ query }), getDb: async () => ({ query }) }));

const multisite = await import("../../../src/lib/tenancy/multisite.js");
const { isPlatformOperator } = await import("../../../src/lib/tenancy/access.js");

const original = process.env.JF_MULTISITE;
afterEach(() => {
  if (original === undefined) delete process.env.JF_MULTISITE;
  else process.env.JF_MULTISITE = original;
});

describe("multisite switch", () => {
  it("is on only for an explicit true value", () => {
    expect(multisite.multisiteEnvFlag(undefined)).toBe(false);
    expect(multisite.multisiteEnvFlag("")).toBe(false);
    expect(multisite.multisiteEnvFlag("maybe")).toBe(false);
    expect(multisite.multisiteEnvFlag("false")).toBe(false);
    expect(multisite.multisiteEnvFlag("0")).toBe(false);
    expect(multisite.multisiteEnvFlag(" TRUE ")).toBe(true);
    expect(multisite.multisiteEnvFlag("1")).toBe(true);
  });

  it("warns at boot when other sites exist while off", async () => {
    delete process.env.JF_MULTISITE;
    query.mockResolvedValueOnce([{ count: "2" }] as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await multisite.warnIfMultisiteDataDisabled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("makes nobody a platform operator while off", async () => {
    delete process.env.JF_MULTISITE;
    expect(await isPlatformOperator("u-1")).toBe(false);
    process.env.JF_MULTISITE = "true";
    expect(await isPlatformOperator("u-1")).toBe(true);
  });
});

describe("requireMultisite", () => {
  let server: Server;
  let endpoint: string;
  beforeAll(async () => {
    const app = express();
    app.use("/api/platform", multisite.requireMultisite, (_req, res) => {
      res.json({ ok: true });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform/tenants`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("hides platform routes while off and passes through when on", async () => {
    delete process.env.JF_MULTISITE;
    expect((await fetch(endpoint)).status).toBe(404);
    process.env.JF_MULTISITE = "true";
    expect((await fetch(endpoint)).status).toBe(200);
  });
});
