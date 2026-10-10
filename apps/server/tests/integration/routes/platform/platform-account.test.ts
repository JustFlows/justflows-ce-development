// SPDX-License-Identifier: MIT

import express from "express";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticated: true, root: true, owns: true,
  owned: vi.fn(), account: vi.fn(), createSite: vi.fn(), query: vi.fn(), run: vi.fn(), execute: vi.fn(), meters: vi.fn(), sections: vi.fn(), audit: vi.fn() }));
const WORKSPACE = "7b1f21b5-8650-4c6d-a48e-33e1f0bb5b40";
const SITE = "265dfc98-066f-4b2d-84b5-690a4cec450e";
vi.mock("../../../../src/middleware/auth.js", () => ({
  requireSession: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!mocks.authenticated) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.session = { userId: "root-owner", siteId: "root-site", email: "owner@example.com", role: "subscriber", iat: 0 }; next();
  },
  optionalSession: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (mocks.authenticated) req.session = { userId: "root-owner", siteId: "root-site", email: "owner@example.com", role: "subscriber", iat: 0 };
    next();
  },
  requireInstallationRoot: (_req: express.Request, res: express.Response, next: express.NextFunction) => { if (!mocks.root) res.status(403).json({ error: "Root only" }); else next(); },
}));
vi.mock("../../../../src/lib/tenancy/access.js", () => ({ isInstallationRootRequest: () => mocks.root }));
vi.mock("../../../../src/lib/tenancy/platform-account.js", () => ({ ownedWorkspace: mocks.owned, ownerAccount: mocks.account }));
vi.mock("../../../../src/lib/database/db.js", () => ({ getControlDb: async () => ({ query: mocks.query, run: mocks.run, execute: mocks.execute }), getDb: async () => ({ run: mocks.run }) }));
vi.mock("../../../../src/lib/tenancy/site-users.js", () => ({ withSiteUsers: async (_id: string, fn: (scope: { separateDatabase: boolean }) => Promise<void>) => { await fn({ separateDatabase: true }); return { ok: true }; } }));
vi.mock("../../../../src/lib/tenancy/provision.js", () => ({ createAdditionalSite: mocks.createSite }));
vi.mock("../../../../src/lib/tenancy/saas-settings.js", () => ({ platformBaseDomain: async () => "example.com" }));
vi.mock("../../../../src/lib/tenancy/quotas.js", () => ({ listQuotaMeters: mocks.meters }));
vi.mock("../../../../src/lib/security/audit-log.js", () => ({ auditLog: mocks.audit }));

vi.mock("../../../../src/lib/runtime/jf-root.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../../src/lib/runtime/jf-root.js")>(), viewsDir: () => fileURLToPath(new URL("../../../../src/views", import.meta.url)) }));
vi.mock("../../../../src/lib/content/content-types-db.js", () => ({ ensureBuiltinContentTypes: async () => undefined }));
vi.mock("../../../../src/lib/account/pages.js", () => ({ accountPages: async () => [{ url: "/account", aliases: [], content: { id: "account-page", siteId: "root-site", type: "account", slug: "account", locale: "en", status: "published" } }] }));
vi.mock("../../../../src/lib/auth/auth-session.js", () => ({ isPreviewAllowed: async () => false }));
vi.mock("../../../../src/middleware/security-headers.js", () => ({ securityHeaders: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../../../src/routes/public/public-site.js", () => ({ renderSinglePageHtml: async (req: express.Request) => {
  const { renderAccountBlocks } = await import("../../../../src/lib/account/render.js");
  const body = await renderAccountBlocks('<div class="jf-account" data-jf-account="all" data-section-id="" data-show-titles="true">Your account details</div>', req.session!);
  return `<html><head></head><body>${body}</body></html>`;
} }));
vi.mock("../../../../src/lib/account/sections.js", () => ({ accountSections: mocks.sections }));

import { accountCacheMiddleware } from "../../../../src/middleware/account-cache.js";
import { apiRouter, pageRouter } from "../../../../src/routes/public/account.js";
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express(); app.use(accountCacheMiddleware); app.use(express.json()); app.use("/api/account", apiRouter);
  app.set("view engine", "ejs");
  app.set("views", fileURLToPath(new URL("../../../../src/views", import.meta.url)));
  app.use("/account", pageRouter);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/account`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
beforeEach(() => {
  vi.clearAllMocks(); mocks.authenticated = true; mocks.root = true;
  mocks.owned.mockResolvedValue({ id: WORKSPACE, status: "active" }); mocks.account.mockResolvedValue([]);
  mocks.query.mockResolvedValue([]); mocks.execute.mockResolvedValue(1); mocks.meters.mockResolvedValue([]);
  mocks.createSite.mockResolvedValue({ ok: true });
  mocks.sections.mockResolvedValue([{ id: "workspaces", title: "Your workspaces", cards: [] }, { id: "profile", title: "Your profile", cards: [{ title: "Account details", fields: [{ label: "Email", value: "owner@example.com" }] }] }]);
});
const send = (path: string, method: string, body: object) => fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("public workspace owner API", () => {
  it("requires a signed-in root account, even for subscribers", async () => {
    mocks.authenticated = false; expect((await fetch(base)).status).toBe(401);
    mocks.authenticated = true; mocks.root = false; expect((await fetch(`${base}/workspaces/${WORKSPACE}/limits`)).status).toBe(403);
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it("lists only the authenticated owner's workspaces and prevents caching", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200); expect(mocks.account).toHaveBeenCalledWith("root-owner");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("refuses another owner's workspace without exposing its resources", async () => {
    mocks.owned.mockResolvedValue(null);
    expect((await fetch(`${base}/workspaces/${WORKSPACE}/limits`)).status).toBe(404);
    expect(mocks.meters).not.toHaveBeenCalled();
  });
  it("refuses a site outside the owner's workspace", async () => {
    expect((await fetch(`${base}/workspaces/${WORKSPACE}/sites/${SITE}/limits`)).status).toBe(404);
    expect(mocks.meters).not.toHaveBeenCalled();
  });
  it("guards workspace name writes with owner identity", async () => {
    const res = await send(`/workspaces/${WORKSPACE}`, "PATCH", { name: "My workspace" });
    expect(res.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining("owner_user_id = ?"), ["My workspace", WORKSPACE, "root-owner"]);
  });
  it("cannot rename a workspace owned by someone else", async () => {
    mocks.owned.mockResolvedValue(null);
    expect((await send(`/workspaces/${WORKSPACE}`, "PATCH", { name: "Taken" })).status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("keeps the site name in sync with an isolated separate database", async () => {
    expect((await send(`/workspaces/${WORKSPACE}/sites/${SITE}`, "PATCH", { name: "Renamed" })).status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(expect.stringContaining("owner_user_id = ?"), ["Renamed", SITE, WORKSPACE, "root-owner"]);
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining("UPDATE sites SET name"), ["Renamed", SITE]);
  });
  it("accepts saving an unchanged site name on MySQL while retaining ownership checks", async () => {
    mocks.execute.mockResolvedValue(0); mocks.query.mockResolvedValue([{ id: SITE }]);
    expect((await send(`/workspaces/${WORKSPACE}/sites/${SITE}`, "PATCH", { name: "Unchanged" })).status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("t.owner_user_id = ?"), [SITE, WORKSPACE, "root-owner"]);
  });
  it("does not let the client supply the admin identity, hostname or database", async () => {
    const res = await send(`/workspaces/${WORKSPACE}/sites`, "POST", { name: "New site", address: "new-site", password: "long-site-password", hostname: "evil.example", databaseChoice: "separate", admin: { email: "victim@example.com" } });
    expect(res.status).toBe(201);
    expect(mocks.createSite).toHaveBeenCalledWith(expect.objectContaining({ tenantId: WORKSPACE, hostname: "new-site.example.com", databaseChoice: "inherit", actorId: "root-owner", admin: expect.objectContaining({ email: "owner@example.com" }) }));
  });
  it("preserves site quota refusals and never creates sites in suspended workspaces", async () => {
    mocks.createSite.mockResolvedValue({ ok: false, status: 403, error: "Site allowance reached." });
    expect((await send(`/workspaces/${WORKSPACE}/sites`, "POST", { name: "New", address: "new-site", password: "long-site-password" })).status).toBe(403);
    mocks.createSite.mockClear(); mocks.owned.mockResolvedValue({ id: WORKSPACE, status: "suspended" });
    expect((await send(`/workspaces/${WORKSPACE}/sites`, "POST", { name: "New", address: "new-site", password: "long-site-password" })).status).toBe(409);
    expect(mocks.createSite).not.toHaveBeenCalled();
  });
});


describe("server-rendered cloud account", () => {
  const page = () => fetch(base.replace("/api/account", "/account"), { redirect: "manual" });
  it("renders owned workspace data and only the first workspace's meters in the initial HTML", async () => {
    const name = '</script><script>alert("unsafe")</script>';
    mocks.account.mockResolvedValue([
      { id: WORKSPACE, name, status: "active", sites: [{ id: SITE, name: "Demo site", status: "active", url: null }] },
      { id: "second-workspace", name: "Second", status: "active", sites: [] },
    ]);
    mocks.meters.mockResolvedValue([{ key: "sites", label: "Sites", unit: "count", used: 1, limit: 5 }]);
    const res = await page(); const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain("Demo site"); expect(html).toContain("1 / 5");
    expect(html).not.toContain(name);
    const initial = JSON.parse(html.match(/<script id="initial-account" type="application\/json">(.*?)<\/script>/s)![1]!);
    expect(initial.workspaces[0].name).toBe(name);
    expect(mocks.account).toHaveBeenCalledWith("root-owner");
    expect(mocks.meters).toHaveBeenCalledExactlyOnceWith("workspace", WORKSPACE);
  });
  it("renders an empty account without querying meters", async () => {
    const html = await (await page()).text();
    expect(html).toContain("Your profile");
    expect(html).not.toContain("No workspaces yet");
    expect(mocks.meters).not.toHaveBeenCalled();
  });
  it("keeps workspace content available when limits fail", async () => {
    mocks.account.mockResolvedValue([{ id: WORKSPACE, name: "Demo", status: "active", sites: [] }]);
    mocks.meters.mockRejectedValue(new Error("Measurement failed"));
    const res = await page(); expect(res.status).toBe(200);
    expect(await res.text()).toContain("Resources unavailable.");
  });
  it("does not load account data for anonymous visits and keeps tenant accounts available", async () => {
    mocks.authenticated = false; expect((await page()).status).toBe(302);
    mocks.authenticated = true; mocks.root = false;
    const res = await page(); expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your profile");
    expect(mocks.sections).toHaveBeenCalledWith(expect.objectContaining({ siteId: "root-site", userId: "root-owner", installationRoot: false }));
    expect(mocks.account).not.toHaveBeenCalled(); expect(mocks.meters).not.toHaveBeenCalled();
  });
});

it("renders plugin account sections and authenticated POST actions", async () => {
  mocks.sections.mockResolvedValue([{ id: "example.orders", title: "Your orders", cards: [{ title: "Order 1", fields: [{ label: "Total", value: "€10" }], actions: [{ label: "Cancel", endpoint: "/ext/example/account/orders/1/cancel" }] }] }]);
  const res = await fetch(base.replace("/api/account", "/account"));
  expect(await res.text()).toContain('data-account-action="/ext/example/account/orders/1/cancel"');
  expect(res.headers.get("surrogate-control")).toBe("no-store");
  expect(res.headers.get("vary")).toContain("Cookie");
});


it("serves a site account API without loading root workspace data", async () => {
  mocks.root = false;
  const res = await fetch(base); expect(res.status).toBe(200);
  const data = await res.json() as { workspaces: unknown[]; sections: unknown[] };
  expect(data.workspaces).toEqual([]); expect(data.sections).not.toHaveLength(0);
  expect(mocks.account).not.toHaveBeenCalled();
  expect(res.headers.get("cache-control")).toBe("private, no-store");
});
