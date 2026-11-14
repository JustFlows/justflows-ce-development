// SPDX-License-Identifier: MIT

import { getDb, runWithDatabase, type DbClient } from "../../database/db.js";
import { sessionMatchesRequestSite } from "../../tenancy/access.js";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { duplexPair } from "node:stream";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { runWithAgentOrigin } from "../agent-origin.js";
import { runAsDelegate } from "../../security/delegated-call.js";
import { getTenantContext, runWithTenant, type TenantRequestContext } from "../../tenancy/context.js";
import type { AgentPrincipal } from "./principal.js";

/**
 * Run a management API operation in-process, as an agent principal.
 *
 * Agent tools do not reimplement anything: each one is a call into the real
 * `/api/manage/v1` router, through the same handler, the same `ensureKeyCan`
 * capability and scope check and the same shared service layer as the HTTP
 * route.
 *
 * The call is a genuine HTTP request carried over an in-memory socket pair
 * (`duplexPair`) into an `http.Server` that never listens on a port, so body
 * parsing, multer uploads, per-route rate limiters and ETags behave exactly as
 * they do over the network, and nothing outside this process can reach it.
 * (A mock request/response library was ruled out: the one tried rewrites
 * Express's shared prototypes for the whole process.)
 *
 * The principal is looked up by a one-time random token held in memory for
 * the duration of the call — nothing on the wire can claim to be one.
 */

const DISPATCH_HEADER = "x-jf-agent-dispatch";

interface PendingDispatch {
  principal: AgentPrincipal;
  database: DbClient;
  /** Captured from the outer request. The in-memory hop does not keep it. */
  tenant?: TenantRequestContext;
}

/** Site id for `getSiteId()`, using the key's site when the outer request had no tenant. */
function tenantFor(siteId: string, captured: TenantRequestContext | undefined): TenantRequestContext {
  if (captured?.siteId === siteId) return captured;
  return {
    tenantId: captured?.tenantId ?? "",
    siteId,
    hostname: captured?.hostname ?? "",
    userMode: captured?.userMode ?? "isolated",
    databaseMode: captured?.databaseMode ?? "current",
    rootSite: captured?.rootSite,
    activePluginIds: captured?.activePluginIds ?? null,
  };
}

const pending = new Map<string, PendingDispatch>();

let serverPromise: Promise<http.Server> | null = null;

async function buildInternalServer(): Promise<http.Server> {
  const { default: manageApiRoutes } = await import("../../../routes/manage-api/index.js");
  const app: Express = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const token = req.get(DISPATCH_HEADER);
    const entry = token ? pending.get(token) : undefined;
    if (!entry) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { principal } = entry;
    req.apiKey = principal.key;
    req.apiKeyOwner = principal.owner;
    req.session = {
      userId: principal.owner.userId,
      siteId: principal.owner.siteId,
      role: "api-key",
      email: "",
      iat: Math.floor(Date.now() / 1000),
    };
    // The socket hop loses the outer async context. Restore the exact database
    // captured on the authenticated request, never a fallback connection.
    void (async () => {
      await runWithDatabase(entry.database, () =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          res.once("finish", done);
          res.once("close", done);
          runWithTenant(tenantFor(principal.owner.siteId, entry.tenant), () => {
            // A new async turn: mark the delegated call again for everything the route runs.
            const delegate = { kind: principal.kind === "assistant" ? "assistant" : "mcp", client: principal.clientName } as const;
            void runAsDelegate(delegate, () =>
              runWithAgentOrigin({ via: principal.via, client: principal.clientName }, async () => next()),
            ).catch(reject);
          });
        }),
      );
    })().catch(() => {
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  });
  app.use(express.json({ limit: "2mb" }));
  /** Same document limits as the public management API (justflows-ce#309). */
  const { rejectOversizedDocuments } = await import("../../rendering/block-document-limits.js");
  app.use("/api/manage/v1", rejectOversizedDocuments, manageApiRoutes);
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });
  // Never surface a stack or driver message to a model.
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  });
  return http.createServer(app);
}

function internalServer(): Promise<http.Server> {
  serverPromise ??= buildInternalServer().catch((err) => {
    serverPromise = null;
    throw err;
  });
  return serverPromise;
}

/** Test seam: drop the cached internal server. */
export function resetDispatchApp(): void {
  serverPromise = null;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface DispatchRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below `/api/manage/v1`, already URL-encoded, e.g. `/content/abc`. */
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON body. */
  body?: unknown;
  /** Raw body (multipart uploads); takes precedence over `body`. */
  payload?: Buffer;
  headers?: Record<string, string>;
  /** The real client's IP, so per-route limiters key on it. */
  ip?: string;
  userAgent?: string;
}

export interface DispatchResponse {
  status: number;
  body: unknown;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DISPATCH_TIMEOUT_MS = 120_000;

export async function dispatchManageApi(
  principal: AgentPrincipal,
  request: DispatchRequest,
): Promise<DispatchResponse> {
  if (principal.key.siteId !== principal.owner.siteId || !sessionMatchesRequestSite(principal.owner.siteId)) {
    return { status: 403, body: { error: "Cross-site agent access is forbidden." } };
  }
  const database = await getDb();
  const server = await internalServer();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const path = `/api/manage/v1${request.path}${search.size ? `?${search.toString()}` : ""}`;

  let payload: Buffer | undefined;
  const headers: Record<string, string> = {
    host: "justflows.internal",
    connection: "close",
    "user-agent": request.userAgent?.replace(/[\r\n]/g, "").slice(0, 255) || `justflows-${principal.via}`,
    ...(request.headers ?? {}),
  };
  if (request.payload) {
    payload = request.payload;
  } else if (request.body !== undefined) {
    payload = Buffer.from(JSON.stringify(request.body));
    headers["content-type"] = "application/json";
  }
  if (payload) headers["content-length"] = String(payload.length);

  const token = randomBytes(24).toString("base64url");
  headers[DISPATCH_HEADER] = token;
  pending.set(token, { principal, database, tenant: getTenantContext() });

  try {
    const [clientSide, serverSide] = duplexPair();
    // Express derives req.ip from the socket; give the limiters the real client.
    Object.defineProperty(serverSide, "remoteAddress", { value: request.ip ?? "127.0.0.1" });
    server.emit("connection", serverSide);

    return await new Promise<DispatchResponse>((resolve, reject) => {
      const outgoing = http.request(
        { method: request.method, path, headers, createConnection: () => clientSide as never, timeout: DISPATCH_TIMEOUT_MS },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          });
          incoming.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = null;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch {
                body = text.slice(0, 2_000);
              }
            }
            resolve({ status: incoming.statusCode ?? 500, body });
          });
          incoming.on("error", reject);
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error("Dispatch timed out")));
      outgoing.on("error", reject);
      if (payload) outgoing.write(payload);
      outgoing.end();
    });
  } finally {
    pending.delete(token);
  }
}
