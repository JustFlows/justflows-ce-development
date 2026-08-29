// SPDX-License-Identifier: MIT

import type {
  PluginHttpHandler,
  PluginHttpMethod,
  PluginHttpRequest,
  PluginHttpResponse,
} from "@justflows/sdk";

export interface RegisteredPluginRoute {
  pluginId: string;
  method: PluginHttpMethod;
  path: string;
  handler: PluginHttpHandler;
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

  register(
    pluginId: string,
    method: PluginHttpMethod,
    rawPath: string,
    handler: PluginHttpHandler,
  ): void {
    const path = rawPath.startsWith("/")
      ? normalizePath(rawPath)
      : normalizePath(`/ext/${pluginId}/${rawPath}`);

    const conflict = this.routes.find((route) => route.method === method && route.path === path);
    if (conflict) {
      throw new Error(
        `Plugin "${pluginId}" cannot claim ${method} ${path} — already claimed by "${conflict.pluginId}"`,
      );
    }

    this.routes.push({ pluginId, method, path, handler });
  }

  removePlugin(pluginId: string): void {
    for (let i = this.routes.length - 1; i >= 0; i--) {
      if (this.routes[i]?.pluginId === pluginId) this.routes.splice(i, 1);
    }
  }

  match(
    method: string,
    path: string,
  ): { route: RegisteredPluginRoute; params: Record<string, string> } | undefined {
    const normalized = normalizePath(path);
    const candidates = this.routes.filter((route) => route.method === method);
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
