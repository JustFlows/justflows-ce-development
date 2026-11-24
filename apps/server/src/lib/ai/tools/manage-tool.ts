// SPDX-License-Identifier: MIT

import { MANAGE_API_OPENAPI } from "../../http/openapi-manage.js";
import { dispatchManageApi, type DispatchRequest, type QueryValue } from "./dispatch.js";
import type { AgentPrincipal } from "./principal.js";

/**
 * Shared types and the generator that turns a management API operation into
 * an agent tool. Kept apart from the catalog so tests can import the helpers
 * without loading every service the tools reach.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export type ToolGroup =
  | "discovery"
  | "content"
  | "media"
  | "menus"
  | "comments"
  | "content-types"
  | "design"
  | "site"
  | "users"
  | "plugin";

export interface ToolCallContext {
  principal: AgentPrincipal;
  /** The real client IP, so per-route limiters key on it. */
  ip?: string;
  userAgent?: string;
}

/** What a tool returns. Errors are for the model to act on, not protocol failures. */
export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string; status?: number };

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations: ToolAnnotations;
  group: ToolGroup;
  /** Every capability needed to see the tool in `tools/list`. */
  capabilities: string[];
  /** The management API operation the tool is generated from, when it has one. */
  operation?: { method: HttpMethod; path: string };
  /** A tool that names a single resource: the argument holding its id, for audit. */
  targetArg?: string;
  run(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome>;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/**
 * Annotations as MCP clients and plugin directories read them:
 *
 * - `destructiveHint` is false only for a write that adds something and leaves
 *   everything else as it was. Replacing a value is destructive even when an
 *   older revision can be restored, and so is an email, which cannot be
 *   unsent.
 * - `openWorldHint` is true when the call can change what visitors of the
 *   public website see, or reaches a person or address outside it (see
 *   `publicFacing`). Drafts, accounts and settings only staff see are a closed
 *   workspace.
 */
export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds something. */
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Replaces what is stored. */
export const OVERWRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
/** Removes something. */
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/**
 * Whether a call takes something away, for the assistant's red confirmation.
 * Narrower than `destructiveHint`, which an ordinary edit carries as well.
 */
export function removesSomething(tool: Pick<AgentTool, "name" | "group" | "annotations" | "operation">): boolean {
  if (!tool.annotations.destructiveHint || tool.group === "plugin") return tool.annotations.destructiveHint;
  return tool.operation?.method === "DELETE" || /_(?:delete|purge|clear|reset|discard|discard_draft|deactivate)$/.test(tool.name);
}

/** The same write, where the public website or someone outside it can see the result. */
export function publicFacing(annotations: ToolAnnotations): ToolAnnotations {
  return { ...annotations, openWorldHint: true };
}

type OpenApiOperation = { "x-required-capability"?: string };

/**
 * The capability an operation requires, read from the management API's own
 * OpenAPI document — the single source the HTTP surface advertises — rather
 * than restated here. "(none)" / "(any key)" mean no capability.
 */
export function operationCapability(method: HttpMethod, path: string): string[] {
  const paths = MANAGE_API_OPENAPI.paths as unknown as Record<string, Record<string, OpenApiOperation>>;
  const operation = paths[path]?.[method.toLowerCase()];
  if (!operation) throw new Error(`No management API operation ${method} ${path}`);
  const capability = operation["x-required-capability"];
  if (!capability || capability.startsWith("(")) return [];
  return [capability];
}

/** Turn a dispatch response into a tool outcome. */
export function outcomeOf(status: number, body: unknown): ToolOutcome {
  if (status >= 200 && status < 300) return { ok: true, data: body ?? { ok: true } };
  const message =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : typeof body === "string" && body
        ? body
        : "Request failed";
  if (status === 401 || status === 403) {
    return { ok: false, status, error: "Forbidden: this session is not allowed to do that." };
  }
  if (status === 404) return { ok: false, status, error: `Not found: ${message}` };
  if (status === 409) {
    return { ok: false, status, error: `Conflict: ${message}. Re-read the resource and retry with its current version.` };
  }
  if (status === 429) return { ok: false, status, error: "Rate limited: wait a minute and try again." };
  if (status >= 500) return { ok: false, status, error: "The server could not complete the request." };
  return { ok: false, status, error: message };
}

function fillPath(template: string, args: Record<string, unknown>): { path: string; used: Set<string> } {
  const used = new Set<string>();
  const path = template.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    used.add(name);
    const value = args[name];
    if (value === undefined || value === null || value === "") throw new ToolArgumentError(`"${name}" is required.`);
    return encodeURIComponent(String(value));
  });
  return { path, used };
}

export class ToolArgumentError extends Error {}

/** Call one management API operation as the principal. */
export async function callManage(
  ctx: ToolCallContext,
  method: HttpMethod,
  template: string,
  args: Record<string, unknown>,
  extra: Partial<Pick<DispatchRequest, "payload" | "headers">> & { body?: unknown; query?: Record<string, QueryValue> } = {},
): Promise<ToolOutcome> {
  let filled: { path: string; used: Set<string> };
  try {
    filled = fillPath(template, args);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid arguments" };
  }
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !filled.used.has(key)));
  const request: DispatchRequest = {
    method,
    path: filled.path,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    headers: extra.headers,
    payload: extra.payload,
  };
  if (method === "GET") {
    request.query = extra.query ?? (rest as Record<string, QueryValue>);
  } else {
    request.query = extra.query;
    request.body = extra.body !== undefined ? extra.body : Object.keys(rest).length > 0 ? rest : undefined;
  }
  const response = await dispatchManageApi(ctx.principal, request);
  return outcomeOf(response.status, response.body);
}

export interface ManageToolSpec {
  name: string;
  title: string;
  description: string;
  method: HttpMethod;
  path: string;
  input?: JsonSchemaObject;
  annotations: ToolAnnotations;
  group: ToolGroup;
  /** Extra capabilities beyond the operation's own (e.g. schedule also needs content:update). */
  alsoRequires?: string[];
  targetArg?: string;
}

const EMPTY_INPUT: JsonSchemaObject = { type: "object", properties: {}, additionalProperties: false };

/**
 * Generate a tool from a management API operation. Path parameters come from
 * the arguments of the same name; for GET the rest become the query string,
 * otherwise the JSON body.
 */
export function manageTool(spec: ManageToolSpec): AgentTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.input ?? EMPTY_INPUT,
    annotations: spec.annotations,
    group: spec.group,
    capabilities: [...operationCapability(spec.method, spec.path), ...(spec.alsoRequires ?? [])],
    operation: { method: spec.method, path: spec.path },
    targetArg: spec.targetArg,
    run: (args, ctx) => callManage(ctx, spec.method, spec.path, args),
  };
}

/* ---------------------------- schema helpers ---------------------------- */

export const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
export const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });
export const bool = (description: string) => ({ type: "boolean", description });

export function object(
  properties: Record<string, unknown>,
  required: string[] = [],
  additionalProperties = false,
): JsonSchemaObject {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties };
}

export const PAGINATION = {
  limit: int("Page size (1–200, default 50).", { minimum: 1, maximum: 200 }),
  cursor: str("Opaque cursor from a previous page's `page.nextCursor`."),
};
