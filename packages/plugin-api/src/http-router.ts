// SPDX-License-Identifier: MIT

import { pluginApiUrl } from "@justflows/sdk";
import type {
  PluginHttpHandler,
  PluginHttpMethod,
  PluginHttpRateLimit,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginHttpRouteOptions,
} from "@justflows/sdk";

export interface RegisteredPluginRoute {
  pluginId: string;
  method: PluginHttpMethod;
  path: string;
  handler: PluginHttpHandler;
  csrf?: false;
  rateLimit?: PluginHttpRateLimit;
  rawBody?: true;
  binaryBody?: { maxBytes: number };
}

/** The largest upload a plugin route may accept with `binaryBody`. */
export const MAX_PLUGIN_BINARY_BODY = 1024 * 1024 * 1024;

const RATE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Copy only the fields the host understands, and reject a limit that would not hold. */
export function normalizePluginHttpRouteOptions(
  pluginId: string,
  options?: PluginHttpRouteOptions,
): Pick<RegisteredPluginRoute, "csrf" | "rateLimit" | "rawBody" | "binaryBody"> {
  if (!options) return {};
  const normalized: Pick<RegisteredPluginRoute, "csrf" | "rateLimit" | "rawBody" | "binaryBody"> = {};
  if (options.csrf !== undefined && options.csrf !== false) {
    throw new Error(`Plugin "${pluginId}" can only set csrf to false`);
  }
  if (options.csrf === false) normalized.csrf = false;
  if (options.rawBody !== undefined && options.rawBody !== true) {
    throw new Error(`Plugin "${pluginId}" can only set rawBody to true`);
  }
  if (options.rawBody === true) normalized.rawBody = true;
  if (options.binaryBody !== undefined) {
    const max = options.binaryBody?.maxBytes;
    if (!Number.isInteger(max) || max < 1 || max > MAX_PLUGIN_BINARY_BODY) {
      throw new Error(`Plugin "${pluginId}" binaryBody.maxBytes must be an integer from 1 to ${MAX_PLUGIN_BINARY_BODY}`);
    }
    if (normalized.rawBody) throw new Error(`Plugin "${pluginId}" cannot combine rawBody and binaryBody`);
    normalized.binaryBody = { maxBytes: max };
  }
  if (options.rateLimit) {
    const { limit, windowMs, key } = options.rateLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error(`Plugin "${pluginId}" rate limit must be an integer from 1 to 10000`);
    }
    if (!Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) {
      throw new Error(`Plugin "${pluginId}" rate-limit window must be from 1000 to 3600000 milliseconds`);
    }
    if (key !== undefined && !RATE_KEY.test(key)) {
      throw new Error(`Plugin "${pluginId}" rate-limit key must be 1–40 letters, digits, or hyphens`);
    }
    normalized.rateLimit = key === undefined ? { limit, windowMs } : { limit, windowMs, key };
  }
  return normalized;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("Plugin HTTP path must not be empty");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/{2,}/g, "/");
}

function pathParts(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

function staticScore(pattern: string): number {
  return pathParts(pattern).reduce((score, part) => score + (part.startsWith(":") ? 0 : 1), 0);
}

export function matchPathParams(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pathParts(pattern);
  const actualParts = pathParts(path);
  if (patternParts.length !== actualParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i]!;
    const actual = actualParts[i]!;
    if (expected.startsWith(":")) {
      const key = expected.slice(1);
      if (!key) return null;
      try {
        params[key] = decodeURIComponent(actual);
      } catch {
        params[key] = actual;
      }
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export class PluginHttpRouter {
  private readonly routes: RegisteredPluginRoute[] = [];
  private readonly namespaces = new Map<string, string>();
  private readonly namespaceByPlugin = new Map<string, string>();

  setApiNamespace(pluginId: string, namespace: string): void {
    const base = pluginApiUrl(namespace);
    const existing = this.namespaceByPlugin.get(pluginId);
    if (existing && existing !== namespace) throw new Error(`Plugin "${pluginId}" already has API namespace "${existing}"`);
    const owner = this.namespaces.get(namespace);
    if (owner && owner !== pluginId) throw new Error(`API namespace "${namespace}" is already claimed by "${owner}"`);
    if (this.routes.some(route => route.pluginId !== pluginId && (route.path === base || route.path.startsWith(`${base}/`) || route.path === `/ext/${pluginId}` || route.path.startsWith(`/ext/${pluginId}/`)))) {
      throw new Error(`API namespace "${namespace}" conflicts with an existing route`);
    }
    this.namespaces.set(namespace, pluginId);
    this.namespaceByPlugin.set(pluginId, namespace);
  }

  isPublicApiPath(path: string): boolean {
    const namespace = /^\/api\/([^/]+)(?:\/|$)/.exec(path)?.[1];
    return !!namespace && this.namespaces.has(namespace);
  }

  url(pluginId: string, path = ""): string {
    const namespace = this.namespaceByPlugin.get(pluginId);
    return namespace ? pluginApiUrl(namespace, path) : `/ext/${pluginId}${path ? `/${path}` : ""}`;
  }

  register(
    pluginId: string,
    method: PluginHttpMethod,
    rawPath: string,
    handler: PluginHttpHandler,
    options?: PluginHttpRouteOptions,
  ): void {
    let path = rawPath.startsWith("/")
      ? normalizePath(rawPath)
      : normalizePath(`/ext/${pluginId}/${rawPath}`);

    const namespace = /^\/api\/([^/]+)(?:\/|$)/.exec(path)?.[1];
    const owner = namespace ? this.namespaces.get(namespace) : undefined;
    if (owner && owner !== pluginId) throw new Error(`API namespace "${namespace}" is already claimed by "${owner}"`);
    if (owner === pluginId && namespace) path = `/ext/${pluginId}${path.slice(`/api/${namespace}`.length)}`;
    const conflict = this.routes.find((route) => route.method === method && route.path === path);
    if (conflict) {
      throw new Error(
        `Plugin "${pluginId}" cannot claim ${method} ${path} — already claimed by "${conflict.pluginId}"`,
      );
    }

    this.routes.push({
      pluginId,
      method,
      path,
      handler,
      ...normalizePluginHttpRouteOptions(pluginId, options),
    });
  }

  removePlugin(pluginId: string): void {
    const namespace = this.namespaceByPlugin.get(pluginId);
    if (namespace) this.namespaces.delete(namespace);
    this.namespaceByPlugin.delete(pluginId);
    for (let i = this.routes.length - 1; i >= 0; i--) {
      if (this.routes[i]?.pluginId === pluginId) this.routes.splice(i, 1);
    }
  }

  match(
    method: string,
    path: string,
  ): { route: RegisteredPluginRoute; params: Record<string, string> } | undefined {
    let normalized = normalizePath(path);
    const namespace = /^\/api\/([^/]+)(?:\/|$)/.exec(normalized)?.[1];
    const owner = namespace ? this.namespaces.get(namespace) : undefined;
    if (owner && namespace) normalized = `/ext/${owner}${normalized.slice(`/api/${namespace}`.length)}`;
    const candidates = this.routes.filter((route) => route.method === method && (!owner || route.pluginId === owner));
    const exact = candidates.find((route) => route.path === normalized);
    if (exact) return { route: exact, params: {} };

    const parametric = candidates
      .filter((route) => route.path.includes(":"))
      .map((route) => ({ route, params: matchPathParams(route.path, normalized) }))
      .filter((entry): entry is { route: RegisteredPluginRoute; params: Record<string, string> } =>
        entry.params !== null,
      )
      .sort((a, b) => staticScore(b.route.path) - staticScore(a.route.path));

    return parametric[0];
  }

  list(): RegisteredPluginRoute[] {
    return [...this.routes];
  }
}

export type { PluginHttpRequest, PluginHttpResponse, PluginHttpMethod };
