// SPDX-License-Identifier: MIT

import { Readable } from "node:stream";
import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { hubCallbackUrl, hubOrigin, hubResourceUrl, isHubHost } from "../../lib/ai/hub/hub-config.js";
import { filterToolList, listsTools, refusedCall } from "../../lib/ai/hub/hub-credentials.js";
import { open, seal } from "../../lib/ai/hub/hub-seal.js";
import {
  connectSite,
  findSite,
  forgetSite,
  HubSiteError,
  siteFetch,
  siteOriginFromInput,
  type HubSite,
} from "../../lib/ai/hub/hub-sites.js";
import { clientIp } from "../../lib/security/rate-limit.js";
import { logSafe } from "../../lib/security/log-safe.js";

/** The fetch API response, distinct from Express's `Response`. */
type FetchResponse = globalThis.Response;

/**
 * The MCP connection hub: one MCP URL for every Justflows site.
 *
 * An MCP client (ChatGPT, Codex, …) connects to `https://<hub>/api/mcp`. On
 * sign-in the hub asks which site to connect, sends the user to that site's
 * own login and consent screen, and wraps the site's tokens in sealed hub
 * tokens. Every MCP request is then forwarded to `https://<site>/api/mcp`
 * with the site's own token, so the site keeps enforcing its own users,
 * capabilities and rate limits. Tools that ask for a credential are left out
 * (see `hub-credentials.ts`).
 *
 * The client's PKCE challenge and verifier are passed straight through to the
 * site, which checks them. The hub stores only its own client registration
 * per site; codes and tokens live sealed in the client.
 *
 * Only requests for the hub hostname reach this router, and only the OAuth
 * and MCP paths below are handled. Everything else falls through to the site
 * that owns the hostname, so the hub's homepage is an ordinary page.
 */
const router = Router();

const REQUEST_TTL = 15 * 60;
const FLOW_TTL = 15 * 60;
const CODE_TTL = 10 * 60;

function limiter(name: string, limit: number, windowMs = 60_000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `hub-${name}:${clientIp(req)}`,
    handler: (_req, res) => {
      res.status(429).json({ error: "slow_down", error_description: "Too many requests" });
    },
  });
}

const metadataLimit = limiter("metadata", 240);
const registerLimit = limiter("register", 30, 60 * 60_000);
const authorizeLimit = limiter("authorize", 30);
const tokenLimit = limiter("token", 120);
const mcpLimit = limiter("mcp", 600);

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

/** Machine endpoints carry no cookies, so any origin may call them. */
function openCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

class HubOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "HubOAuthError";
  }
}

function oauthError(res: Response, err: unknown): void {
  if (err instanceof HubOAuthError) {
    res.status(err.status).json({ error: err.code, error_description: err.message });
    return;
  }
  console.error("[justflows] mcp hub error", JSON.stringify(logSafe(String(err))));
  res.status(500).json({ error: "server_error" });
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/* -------------------------------- metadata -------------------------------- */

function protectedResource(_req: Request, res: Response): void {
  res.json({
    resource: hubResourceUrl(),
    authorization_servers: [hubOrigin()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: "Justflows MCP",
    resource_documentation: "https://github.com/JustFlows/justflows-ce/blob/main/docs/AI.md",
  });
}

function authorizationServer(_req: Request, res: Response): void {
  const origin = hubOrigin();
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    authorization_response_iss_parameter_supported: true,
  });
}

const metadataChain = [metadataLimit, openCors, noStore];
router.all("/.well-known/oauth-protected-resource", ...metadataChain, protectedResource);
router.all("/.well-known/oauth-protected-resource/api/mcp", ...metadataChain, protectedResource);
router.all("/.well-known/oauth-authorization-server", ...metadataChain, authorizationServer);
router.all("/.well-known/oauth-authorization-server/api/mcp", ...metadataChain, authorizationServer);

/* ------------------------------ registration ------------------------------ */

interface ClientRecord extends Record<string, unknown> {
  n: string;
  r: string[];
}

/** Redirect URIs must be HTTPS, or loopback HTTP for desktop clients (RFC 8252). */
function validRedirectUri(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Dynamic client registration without storage: the client id is the sealed
 * registration itself. Every client is public and must use PKCE.
 */
router.post("/oauth/register", registerLimit, openCors, noStore, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((item): item is string => typeof item === "string")
      : [];
    if (redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(validRedirectUri)) {
      throw new HubOAuthError("invalid_redirect_uri", "Provide one to ten HTTPS (or loopback) redirect URIs");
    }
    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
    if (grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")) {
      throw new HubOAuthError("invalid_client_metadata", "Only authorization_code and refresh_token are supported");
    }
    const responseTypes = Array.isArray(body.response_types) ? body.response_types : ["code"];
    if (responseTypes.some((type) => type !== "code")) {
      throw new HubOAuthError("invalid_client_metadata", "Only the code response type is supported");
    }
    const name = (str(body.client_name) || "MCP client").slice(0, 120);
    const clientId = seal("client", { n: name, r: redirectUris } satisfies ClientRecord);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp",
    });
  } catch (err) {
    oauthError(res, err);
  }
});

/* ------------------------------ authorization ----------------------------- */

interface PendingRequest extends Record<string, unknown> {
  cid: string;
  ru: string;
  cc: string;
  st: string | null;
  sc: string | null;
  cn: string;
}

interface Flow extends Record<string, unknown> {
  o: string;
  cid: string;
  ru: string;
  st: string | null;
}

interface CodeRecord extends Record<string, unknown> {
  o: string;
  c: string;
  cid: string;
  ru: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The page that asks which Justflows site to connect. */
function renderSitePage(res: Response, input: { request: string; clientName: string; site?: string; error?: string }): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(input.error ? 400 : 200).type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your Justflows site</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--text:#0f172a;--muted:#475569;--line:#cbd5e1;--accent:#6366f1;--error:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--text:#f1f5f9;--muted:#94a3b8;--line:#334155;--accent:#8b5cf6;--error:#fca5a5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:1.35rem;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}label{display:block;font-weight:600;margin-bottom:6px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
button{margin-top:16px;width:100%;font:inherit;font-weight:600;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.error{color:var(--error);margin:12px 0 0}.hint{font-size:.875rem;margin:8px 0 0}
</style>
</head>
<body>
<main>
<h1>Connect your Justflows site</h1>
<p>${escapeHtml(input.clientName)} wants to work with a Justflows website. Enter your site's address. You'll sign in on your own site and choose what to allow.</p>
<form method="get" action="/oauth/authorize/site">
<input type="hidden" name="request" value="${escapeHtml(input.request)}">
<label for="site">Site address</label>
<input id="site" name="site" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" required placeholder="mysite.justflows.com" value="${escapeHtml(input.site ?? "")}">
<p class="hint">A Justflows Cloud address, your own domain, or your self-hosted Justflows site.</p>
${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ""}
<button type="submit">Continue</button>
</form>
</main>
</body>
</html>`);
}

function plainError(res: Response, message: string): void {
  res.status(400).type("text/plain").send(`Authorization request rejected: ${message}`);
}

function redirectWithError(res: Response, redirectUri: string, state: string | null, error: string, description: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", hubOrigin());
  res.redirect(302, url.toString());
}

router.get("/oauth/authorize", authorizeLimit, noStore, (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const client = open<ClientRecord>("client", q.client_id);
  if (!client) return plainError(res, "unknown client_id.");
  const redirectUri = str(q.redirect_uri);
  if (!redirectUri || !client.r.includes(redirectUri)) {
    return plainError(res, "redirect_uri does not exactly match a registered URI.");
  }
  const state = str(q.state) || null;
  if (str(q.response_type) !== "code") {
    return redirectWithError(res, redirectUri, state, "unsupported_response_type", "Only response_type=code is supported");
  }
  const challenge = str(q.code_challenge);
  if (!challenge || str(q.code_challenge_method) !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return redirectWithError(res, redirectUri, state, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const resource = str(q.resource);
  if (resource && resource !== hubResourceUrl()) {
    return redirectWithError(res, redirectUri, state, "invalid_target", "Unknown resource");
  }
  const pending: PendingRequest = {
    cid: str(q.client_id),
    ru: redirectUri,
    cc: challenge,
    st: state,
    sc: str(q.scope) || null,
    cn: client.n,
  };
  renderSitePage(res, { request: seal("request", pending, REQUEST_TTL), clientName: client.n });
});

router.get("/oauth/authorize/site", authorizeLimit, noStore, async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const pending = open<PendingRequest>("request", q.request);
  if (!pending) return plainError(res, "this sign-in link has expired. Start connecting again from your app.");
  const typed = str(q.site).slice(0, 300);
  let site: HubSite;
  try {
    site = await connectSite(siteOriginFromInput(typed));
  } catch (err) {
    if (!(err instanceof HubSiteError)) {
      console.error("[justflows] mcp hub site error", JSON.stringify(logSafe(String(err))));
    }
    return renderSitePage(res, {
      request: str(q.request),
      clientName: pending.cn,
      site: typed,
      error: err instanceof HubSiteError ? err.message : "Something went wrong. Try again in a moment.",
    });
  }
  const flow: Flow = { o: site.origin, cid: pending.cid, ru: pending.ru, st: pending.st };
  const target = new URL(site.authorizationEndpoint);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", site.clientId);
  target.searchParams.set("redirect_uri", hubCallbackUrl());
  target.searchParams.set("code_challenge", pending.cc);
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("state", seal("flow", flow, FLOW_TTL));
  target.searchParams.set("resource", site.resource);
  target.searchParams.set("scope", pending.sc ?? "mcp");
  res.redirect(302, target.toString());
});

/** The site sends the user back here; the client gets a sealed code that names the site. */
router.get("/oauth/callback", authorizeLimit, noStore, (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const flow = open<Flow>("flow", q.state);
  if (!flow) return plainError(res, "this sign-in has expired. Start connecting again from your app.");
  const iss = str(q.iss);
  if (iss && iss !== flow.o) return plainError(res, "the response came from a different site.");
  const error = str(q.error);
  if (error) {
    return redirectWithError(res, flow.ru, flow.st, error, str(q.error_description) || "The site did not authorize the connection");
  }
  const code = str(q.code);
  if (!code) return redirectWithError(res, flow.ru, flow.st, "server_error", "The site did not return a code");
  const url = new URL(flow.ru);
  url.searchParams.set("code", seal("code", { o: flow.o, c: code, cid: flow.cid, ru: flow.ru } satisfies CodeRecord, CODE_TTL));
  if (flow.st) url.searchParams.set("state", flow.st);
  url.searchParams.set("iss", hubOrigin());
  res.redirect(302, url.toString());
});

/* --------------------------------- tokens --------------------------------- */

interface AccessRecord extends Record<string, unknown> {
  o: string;
  t: string;
}

interface RefreshRecord extends Record<string, unknown> {
  o: string;
  t: string;
  cid: string;
}

async function siteToken(site: HubSite, params: Record<string, string>): Promise<Record<string, unknown>> {
  let response: FetchResponse;
  try {
    response = await siteFetch(site.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: site.clientId, resource: site.resource }).toString(),
    });
  } catch {
    throw new HubOAuthError("temporarily_unavailable", "The connected site could not be reached", 503);
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /** Handled below as a site failure. */
  }
  if (!response.ok) {
    const code = str(body.error) || "invalid_grant";
    if (code === "invalid_client") await forgetSite(site.origin);
    throw new HubOAuthError(code === "invalid_client" ? "invalid_grant" : code, str(body.error_description) || "The site refused the request");
  }
  if (typeof body.access_token !== "string") throw new HubOAuthError("server_error", "The site returned no access token", 502);
  return body;
}

function wrapTokens(origin: string, clientId: string, body: Record<string, unknown>): Record<string, unknown> {
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? Math.floor(body.expires_in) : 3600;
  return {
    access_token: seal("access", { o: origin, t: String(body.access_token) } satisfies AccessRecord, expiresIn),
    token_type: "Bearer",
    expires_in: expiresIn,
    ...(typeof body.refresh_token === "string"
      ? { refresh_token: seal("refresh", { o: origin, t: body.refresh_token, cid: clientId } satisfies RefreshRecord) }
      : {}),
    scope: str(body.scope) || "mcp",
  };
}

async function knownSite(origin: string): Promise<HubSite> {
  const site = await findSite(origin);
  if (!site) throw new HubOAuthError("invalid_grant", "The site is no longer connected. Connect it again.");
  return site;
}

router.post("/oauth/token", tokenLimit, openCors, noStore, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const clientId = str(body.client_id);
    if (!open<ClientRecord>("client", clientId)) throw new HubOAuthError("invalid_client", "Unknown client", 401);
    const resource = str(body.resource);
    if (resource && resource !== hubResourceUrl()) throw new HubOAuthError("invalid_target", "Unknown resource");
    if (body.grant_type === "authorization_code") {
      const code = open<CodeRecord>("code", body.code);
      if (!code || code.cid !== clientId || code.ru !== str(body.redirect_uri)) {
        throw new HubOAuthError("invalid_grant", "The authorization code is invalid or expired");
      }
      const verifier = str(body.code_verifier);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new HubOAuthError("invalid_grant", "A valid code_verifier is required");
      const site = await knownSite(code.o);
      const tokens = await siteToken(site, {
        grant_type: "authorization_code",
        code: code.c,
        redirect_uri: hubCallbackUrl(),
        code_verifier: verifier,
      });
      res.json(wrapTokens(site.origin, clientId, tokens));
      return;
    }
    if (body.grant_type === "refresh_token") {
      const refresh = open<RefreshRecord>("refresh", body.refresh_token);
      if (!refresh || refresh.cid !== clientId) throw new HubOAuthError("invalid_grant", "The refresh token is invalid");
      const site = await knownSite(refresh.o);
      const tokens = await siteToken(site, { grant_type: "refresh_token", refresh_token: refresh.t });
      res.json(wrapTokens(site.origin, clientId, tokens));
      return;
    }
    throw new HubOAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported");
  } catch (err) {
    oauthError(res, err);
  }
});

/** Forwards revocation to the site. Always answers 200, as RFC 7009 asks. */
router.post("/oauth/revoke", tokenLimit, openCors, noStore, async (req: Request, res: Response) => {
  const token = (req.body as Record<string, unknown> | undefined)?.token;
  const record = open<AccessRecord>("access", token) ?? open<RefreshRecord>("refresh", token);
  if (record) {
    const site = await findSite(record.o).catch(() => null);
    if (site?.revocationEndpoint) {
      await siteFetch(site.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: record.t, client_id: site.clientId }).toString(),
      }).catch(() => undefined);
    }
  }
  res.status(200).json({});
});

router.options(["/oauth/register", "/oauth/token", "/oauth/revoke"], openCors);

/* ----------------------------------- MCP ---------------------------------- */

function challenge(res: Response, error?: string): void {
  const params = [`resource_metadata="${hubOrigin()}/.well-known/oauth-protected-resource/api/mcp"`, 'scope="mcp"'];
  if (error) params.push(`error="${error}"`);
  res.setHeader("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  res.status(401).json({ error: error ?? "unauthorized", error_description: "Connect your Justflows site to continue" });
}

const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control", "retry-after"];

const MAX_TOOL_LIST_BYTES = 8 * 1024 * 1024;

/** A site's answer as text. Throws when it is larger than any real tool list. */
async function readLimited(response: FetchResponse): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_TOOL_LIST_BYTES) throw new Error("Tool list too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function forwardMcp(req: Request, res: Response): Promise<void> {
  const authorization = req.get("authorization") ?? "";
  const bearer = authorization.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7).trim() : "";
  const access = open<AccessRecord>("access", bearer);
  if (!access) return challenge(res, bearer ? "invalid_token" : undefined);
  const hasBody = req.method === "POST";
  const refused = hasBody ? refusedCall(req.body) : null;
  if (refused) {
    res.json({
      jsonrpc: "2.0",
      id: refused.id,
      result: {
        content: [{ type: "text", text: "Passwords, keys and other credentials can't be sent through this connection. Use your site's admin for that." }],
        isError: true,
      },
    });
    return;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${access.t}` };
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }
  if (hasBody) headers["content-type"] = "application/json";
  let upstream: FetchResponse;
  try {
    upstream = await siteFetch(
      `${access.o}/api/mcp`,
      { method: req.method, headers, body: hasBody ? JSON.stringify(req.body ?? {}) : undefined },
      req.method === "GET" ? 60 * 60_000 : 120_000,
    );
  } catch {
    res.status(502).json({ jsonrpc: "2.0", error: { code: -32603, message: "Your Justflows site could not be reached" }, id: null });
    return;
  }
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    return challenge(res, "invalid_token");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    res.status(502).json({ jsonrpc: "2.0", error: { code: -32603, message: "Your Justflows site redirected the request" }, id: null });
    return;
  }
  res.status(upstream.status);
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  if (hasBody && upstream.ok && listsTools(req.body)) {
    const filtered = await readLimited(upstream)
      .then((text) => filterToolList(text, upstream.headers.get("content-type") ?? ""))
      .catch(() => null);
    if (filtered === null) {
      res.setHeader("content-type", "application/json");
      res.status(502).json({ jsonrpc: "2.0", error: { code: -32603, message: "Your Justflows site returned an unreadable tool list" }, id: null });
      return;
    }
    res.end(filtered);
    return;
  }
  const stream = Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream);
  req.on("close", () => stream.destroy());
  stream.on("error", () => res.end());
  stream.pipe(res);
}

router.all("/api/mcp", mcpLimit, openCors, noStore, (req: Request, res: Response) => {
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  forwardMcp(req, res).catch((err) => {
    console.error("[justflows] mcp hub forward error", JSON.stringify(logSafe(String(err))));
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
    else res.end();
  });
});

/** Runs the hub router for the hub hostname only; every other request is untouched. */
export function mcpHub(req: Request, res: Response, next: NextFunction): void {
  if (!isHubHost(req.hostname)) return next();
  router(req, res, next);
}

export default router;
