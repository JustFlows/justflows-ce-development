// SPDX-License-Identifier: MIT

import type { Request, Response, NextFunction } from "express";
import type { PluginHttpMethod } from "@justflows/sdk";
import { isProtectedHeaderName, SECURITY_HEADER_DEFS } from "./security-headers.js";
import { resolveSession } from "./auth-session.js";

/**
 * Headers a plugin may not set on the response.
 *
 * Plugin output used to be copied over the response verbatim, so a handler
 * could replace the Content-Security-Policy the platform had just set, widen
 * Access-Control-Allow-Origin, or plant a Set-Cookie. Plugins already run
 * in-process — this is not a sandbox — but silently disarming a site-wide
 * security header is a different thing from running code, and nothing about it
 * would be visible to the operator.
 */
const RESERVED_RESPONSE_HEADERS = new Set<string>([
  ...SECURITY_HEADER_DEFS.map((def) => def.header.toLowerCase()),
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "set-cookie",
]);

/** Request headers never forwarded to plugin code. */
const STRIPPED_REQUEST_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

export function isReservedPluginResponseHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return RESERVED_RESPONSE_HEADERS.has(lower) || isProtectedHeaderName(lower);
}

export async function dispatchPluginHttp(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { ensurePluginRuntime, getPluginLoader } = await import("./plugin-runtime.js");
  await ensurePluginRuntime();
  const loader = getPluginLoader();
  if (!loader) {
    next();
    return;
  }

  const method: PluginHttpMethod | null =
    req.method === "GET" ||
    req.method === "POST" ||
    req.method === "PUT" ||
    req.method === "PATCH" ||
    req.method === "DELETE"
      ? req.method
      : null;
  if (!method) {
    next();
    return;
  }

  const matched = loader.httpRouter.match(method, req.path);
  if (!matched) {
    next();
    return;
  }
  const { route: match, params } = matched;

  // These routes are mounted at the application root, not under /api, so the
  // csrfProtection middleware never sees them — every plugin mutation was
  // cross-site forgeable. Checked here, on the one path that reaches them.
  if (method !== "GET") {
    const { csrfProtection } = await import("../middleware/csrf.js");
    // Synchronous: it either calls next() or answers 403 itself, so the flag
    // is settled by the time the call returns.
    let passed = false;
    csrfProtection(req, res, () => {
      passed = true;
    });
    if (!passed) return;
  }

  try {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") query[key] = value;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") continue;
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }

    const session = await resolveSession(req, res).catch(() => null);

    const result = await match.handler({
      method,
      path: req.path,
      query,
      params,
      body: req.body,
      headers,
      session: session
        ? {
            userId: session.userId,
            siteId: session.siteId,
            role: session.role,
            email: session.email,
          }
        : null,
    });

    res.status(result.status ?? 200);
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        if (isReservedPluginResponseHeader(key)) {
          console.warn(
            `[justflows] plugin "${match.pluginId}" tried to set the reserved header "${key}"`,
          );
          continue;
        }
        res.setHeader(key, value);
      }
    }
    if (result.type) res.type(result.type);
    if (Buffer.isBuffer(result.body) || typeof result.body === "string") {
      res.send(result.body);
      return;
    }
    if (result.body !== undefined) {
      res.json(result.body);
      return;
    }
    res.end();
  } catch (err) {
    const routeLabel = `${match.pluginId}${req.path}`.replace(/\r/g, "").replace(/\n/g, "");
    console.error("[justflows] plugin route failed: %s", JSON.stringify(routeLabel), err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
}
