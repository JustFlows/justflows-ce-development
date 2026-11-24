// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MCP_HUB_HOST = "127.0.0.1";
process.env.MCP_HUB_SECRET = "hub-test-secret-that-is-at-least-32-characters";

const store = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));

vi.mock("../../../../src/lib/database/db.js", () => ({
  getControlDb: async () => ({
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("SELECT")) {
        const row = store.rows.get(String(params[0]));
        return row ? [row] : [];
      }
      return [];
    },
    run: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("DELETE")) store.rows.delete(String(params[0]));
      if (sql.startsWith("INSERT")) {
        const [origin, client_id, authorization_endpoint, token_endpoint, revocation_endpoint, resource] = params;
        store.rows.set(String(origin), { origin, client_id, authorization_endpoint, token_endpoint, revocation_endpoint, resource });
      }
    },
  }),
}));

const { mcpHub } = await import("../../../../src/routes/ai/hub.js");
const { setHubFetchForTests, siteOriginFromInput, HubSiteError } = await import(
  "../../../../src/lib/ai/hub/hub-sites.js"
);

const SITE = "https://mysite.example.com";
const HUB = "https://127.0.0.1";
const CLIENT_REDIRECT = "https://chatgpt.example/connector/oauth/callback";

/** A fake Justflows site that the hub talks to through the injected fetch. */
const site = {
  challenge: "",
  registrations: 0,
  mcpAuth: [] as string[],
  tokenRequests: [] as URLSearchParams[],
  issuer: SITE,
  /** What `/api/mcp` answers instead of echoing the request. */
  answer: null as null | (() => Response),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fakeSite(url: string, init: RequestInit): Promise<Response> {
  if (url === `${SITE}/.well-known/oauth-protected-resource/api/mcp`) {
    return json({ resource: `${SITE}/api/mcp`, authorization_servers: [SITE] });
  }
  if (url === `${SITE}/.well-known/oauth-authorization-server`) {
    return json({
      issuer: site.issuer,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/oauth/token`,
      registration_endpoint: `${SITE}/oauth/register`,
      revocation_endpoint: `${SITE}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (url === `${SITE}/oauth/register`) {
    site.registrations += 1;
    const body = JSON.parse(String(init.body)) as { redirect_uris: string[] };
    expect(body.redirect_uris).toEqual([`${HUB}/oauth/callback`]);
    return json({ client_id: "site-client" }, 201);
  }
  if (url === `${SITE}/oauth/token`) {
    const params = new URLSearchParams(String(init.body));
    site.tokenRequests.push(params);
    expect(params.get("client_id")).toBe("site-client");
    expect(params.get("resource")).toBe(`${SITE}/api/mcp`);
    if (params.get("grant_type") === "authorization_code") {
      const verifier = params.get("code_verifier") ?? "";
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (params.get("code") !== "site-code" || computed !== site.challenge) return json({ error: "invalid_grant" }, 400);
      expect(params.get("redirect_uri")).toBe(`${HUB}/oauth/callback`);
      return json({ access_token: "site-access", refresh_token: "site-refresh", expires_in: 3600, scope: "mcp" });
    }
    if (params.get("refresh_token") !== "site-refresh") return json({ error: "invalid_grant" }, 400);
    return json({ access_token: "site-access-2", refresh_token: "site-refresh", expires_in: 3600 });
  }
  if (url === `${SITE}/api/mcp`) {
    const headers = new Headers(init.headers);
    site.mcpAuth.push(headers.get("authorization") ?? "");
    if (headers.get("authorization") === "Bearer expired") return json({ error: "invalid_token" }, 401);
    if (site.answer) return site.answer();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echoed: JSON.parse(String(init.body)) } }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
    });
  }
  return new Response("not found", { status: 404 });
}

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(mcpHub);
  app.get("/", (_req, res) => res.send("hub homepage from the site"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setHubFetchForTests(fakeSite);
});

afterAll(async () => {
  setHubFetchForTests(null);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store.rows.clear();
  site.registrations = 0;
  site.mcpAuth = [];
  site.tokenRequests = [];
  site.issuer = SITE;
  site.answer = null;
});

async function register(): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [CLIENT_REDIRECT] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const verifier = "v".repeat(43) + "erifier-for-the-hub-test";

/** Walks the whole connection and returns the client's token response. */
async function connect(clientId: string): Promise<{ access_token: string; refresh_token: string }> {
  site.challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    response_type: "code",
    code_challenge: site.challenge,
    code_challenge_method: "S256",
    state: "client-state",
  }).toString();
  const page = await fetch(authorize, { redirect: "manual" });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Connect your Justflows site");
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  expect(request).toMatch(/^jfhq_/);

  const choose = await fetch(`${base}/oauth/authorize/site?request=${encodeURIComponent(request)}&site=mysite.example.com/admin`, {
    redirect: "manual",
  });
  expect(choose.status).toBe(302);
  const toSite = new URL(choose.headers.get("location") ?? "");
  expect(toSite.origin + toSite.pathname).toBe(`${SITE}/oauth/authorize`);
  expect(toSite.searchParams.get("client_id")).toBe("site-client");
  expect(toSite.searchParams.get("code_challenge")).toBe(site.challenge);
  expect(toSite.searchParams.get("redirect_uri")).toBe(`${HUB}/oauth/callback`);

  const callback = await fetch(
    `${base}/oauth/callback?code=site-code&iss=${encodeURIComponent(SITE)}&state=${encodeURIComponent(toSite.searchParams.get("state") ?? "")}`,
    { redirect: "manual" },
  );
  expect(callback.status).toBe(302);
  const back = new URL(callback.headers.get("location") ?? "");
  expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
  expect(back.searchParams.get("state")).toBe("client-state");
  expect(back.searchParams.get("iss")).toBe(HUB);

  const token = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: back.searchParams.get("code") ?? "",
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: verifier,
    }).toString(),
  });
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; refresh_token: string };
}

describe("MCP connection hub", () => {
  it("publishes its own OAuth metadata and leaves other paths to the site", async () => {
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(HUB);
    expect(meta.registration_endpoint).toBe(`${HUB}/oauth/register`);
    const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`)).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(`${HUB}/api/mcp`);
    expect(await (await fetch(`${base}/`)).text()).toBe("hub homepage from the site");
  });

  it("connects a site end to end and forwards MCP calls with the site's own token", async () => {
    const clientId = await register();
    const tokens = await connect(clientId);
    expect(tokens.access_token).toMatch(/^jfha_/);
    expect(tokens.access_token).not.toContain("site-access");
    expect(site.registrations).toBe(1);

    const call = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(call.status).toBe(200);
    expect(call.headers.get("mcp-session-id")).toBe("sess-1");
    expect(((await call.json()) as { result: { echoed: { method: string } } }).result.echoed.method).toBe("tools/list");
    expect(site.mcpAuth).toEqual(["Bearer site-access"]);

    const refreshed = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${next.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(site.mcpAuth.at(-1)).toBe("Bearer site-access-2");
  });

  it("reuses the stored site registration on the next connection", async () => {
    const clientId = await register();
    await connect(clientId);
    await connect(clientId);
    expect(site.registrations).toBe(1);
  });

  describe("credentials", () => {
    const tools = [
      { name: "users_list", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
      { name: "users_create", inputSchema: { type: "object", properties: { email: { type: "string" }, password: { type: "string" } } } },
      { name: "nested", inputSchema: { type: "object", properties: { options: { type: "object", properties: { api_key: { type: "string" } } } } } },
      { name: "themes_customize_update", inputSchema: { type: "object", properties: { designTokens: { type: "object" }, passwordResetEnabled: { type: "boolean" } } } },
    ];
    const list = { jsonrpc: "2.0", id: 1, result: { tools } };

    /** Connected once: each connection counts towards the sign-in rate limit. */
    let token = "";
    async function post(body: unknown) {
      token ||= (await connect(await register())).access_token;
      return fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      });
    }
    const listRequest = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const names = (answer: typeof list) => answer.result.tools.map((tool) => tool.name);

    it("leaves tools of an older site that ask for one out of the list", async () => {
      site.answer = () => json(list);
      expect(names((await (await post(listRequest)).json()) as typeof list)).toEqual(["users_list", "themes_customize_update"]);
    });

    it("does the same for a streamed list", async () => {
      site.answer = () => new Response(`event: message\ndata: ${JSON.stringify(list)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      const text = await (await post(listRequest)).text();
      expect(text).toMatch(/^event: message\ndata: /);
      expect(names(JSON.parse(text.split("data: ")[1]!) as typeof list)).toEqual(["users_list", "themes_customize_update"]);
    });

    it("fails instead of passing on a list it cannot read", async () => {
      site.answer = () => new Response("<html>", { headers: { "content-type": "text/html" } });
      expect((await post(listRequest)).status).toBe(502);
    });

    it("refuses a call that carries one without reaching the site", async () => {
      const call = (args: unknown) => post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "users_create", arguments: args } });
      const refused = (await (await call({ email: "sam@example.com", password: "a-Long-passw0rd!" })).json()) as { id: number; result: { isError: boolean } };
      expect(refused).toMatchObject({ id: 7, result: { isError: true } });
      expect(site.mcpAuth).toEqual([]);
      expect((await call({ email: "sam@example.com", designTokens: { a: "b" }, passwordResetEnabled: true })).status).toBe(200);
      expect(site.mcpAuth).toHaveLength(1);
    });
  });

  it("challenges MCP calls without a valid hub token", async () => {
    const none = await fetch(`${base}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain(`resource_metadata="${HUB}/.well-known/oauth-protected-resource/api/mcp"`);
    const forged = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer jfha_forged", "content-type": "application/json" },
      body: "{}",
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(site.mcpAuth).toEqual([]);
  });

  it("refuses a code exchanged by another client or with the wrong verifier", async () => {
    const clientId = await register();
    const other = await register();
    site.challenge = createHash("sha256").update(verifier).digest("base64url");
    const page = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        response_type: "code",
        code_challenge: site.challenge,
        code_challenge_method: "S256",
      })}`,
    );
    const request = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const choose = await fetch(`${base}/oauth/authorize/site?request=${encodeURIComponent(request)}&site=${SITE}`, { redirect: "manual" });
    const state = new URL(choose.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const callback = await fetch(`${base}/oauth/callback?code=site-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchange = (client: string, codeVerifier: string) =>
      fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: client, code, redirect_uri: CLIENT_REDIRECT, code_verifier: codeVerifier }).toString(),
      });
    expect((await exchange(other, verifier)).status).toBe(400);
    expect((await exchange(clientId, "w".repeat(43))).status).toBe(400);
  });

  it("rejects a callback whose issuer is a different site", async () => {
    const clientId = await register();
    site.challenge = createHash("sha256").update(verifier).digest("base64url");
    const page = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        response_type: "code",
        code_challenge: site.challenge,
        code_challenge_method: "S256",
      })}`,
    );
    const request = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const choose = await fetch(`${base}/oauth/authorize/site?request=${encodeURIComponent(request)}&site=${SITE}`, { redirect: "manual" });
    const state = new URL(choose.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const res = await fetch(`${base}/oauth/callback?code=site-code&iss=https%3A%2F%2Fevil.example&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a site whose issuer does not match its address", async () => {
    site.issuer = "https://elsewhere.example";
    const clientId = await register();
    const page = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        response_type: "code",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
    );
    const request = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const choose = await fetch(`${base}/oauth/authorize/site?request=${encodeURIComponent(request)}&site=${SITE}`, { redirect: "manual" });
    expect(choose.status).toBe(400);
    expect(await choose.text()).toContain("different address");
    expect(site.registrations).toBe(0);
  });

  it("rejects unregistered redirect URIs and clients", async () => {
    const clientId = await register();
    const wrong = await fetch(`${base}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=https%3A%2F%2Fevil.example%2Fcb`);
    expect(wrong.status).toBe(400);
    const unknown = await fetch(`${base}/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}`);
    expect(unknown.status).toBe(400);
    const badRegistration = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(badRegistration.status).toBe(400);
  });
});

describe("site address input", () => {
  it("normalizes Cloud, custom-domain and self-hosted addresses to an HTTPS origin", () => {
    expect(siteOriginFromInput("mysite.justflows.com")).toBe("https://mysite.justflows.com");
    expect(siteOriginFromInput("https://www.example.com/admin")).toBe("https://www.example.com");
    expect(siteOriginFromInput(" CMS.Example.NL. ")).toBe("https://cms.example.nl");
  });

  it("refuses insecure, private and malformed addresses", () => {
    for (const value of ["http://example.com", "localhost", "https://10.0.0.1", "intranet", "https://a.local", "https://user:pw@example.com", "https://example.com:8443", "127.0.0.1", ""]) {
      expect(() => siteOriginFromInput(value), value).toThrow(HubSiteError);
    }
  });
});

