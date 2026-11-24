// SPDX-License-Identifier: MIT

import { sessionMatchesRequestSite } from "../../tenancy/access.js";
import { getTenantContext } from "../../tenancy/context.js";
import { auditLog } from "../../security/audit-log.js";
import { runAsDelegate } from "../../security/delegated-call.js";
import { logSafe } from "../../security/log-safe.js";
import { runWithAgentOrigin } from "../agent-origin.js";
import { safeAgentData, safeAgentText } from "../agent-data.js";
import { CORE_TOOLS } from "./catalog.js";
import {
  READ,
  type AgentTool,
  type JsonSchemaObject,
  type ToolCallContext,
  type ToolOutcome,
} from "./manage-tool.js";
import { pluginRouteTools } from "./plugin-route-tools.js";
import { principalCapabilities, type AgentPrincipal } from "./principal.js";

/**
 * Resolve, filter and call agent tools — the one code path behind both MCP
 * `tools/list` / `tools/call` and the assistant.
 *
 * A tool is listed only when the principal currently holds every capability it
 * needs. Tools that change users & roles also need the key or grant to have
 * opted in; reading them needs only `users:read`. The assistant is offered
 * neither.
 * Calling a tool that is not listed is refused the same way, so filtering is
 * not merely cosmetic; the handler it reaches checks the capability again.
 */

const MAX_RESULT_CHARS = 100_000;

/** Only reviewed core operations and explicitly registered plugin API routes.
 * Arbitrary mcp.tools handlers are deliberately ignored: agents are API-only.
 */
export async function allTools(_siteId: string): Promise<AgentTool[]> {
  const seen = new Set(CORE_TOOLS.map((tool) => tool.name));
  return [...CORE_TOOLS, ...pluginRouteTools().filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  })];
}

export function principalMatchesSite(principal: AgentPrincipal): boolean {
  return principal.key.siteId === principal.owner.siteId && sessionMatchesRequestSite(principal.owner.siteId);
}

/** Explicit site/workspace selectors cannot override the authenticated target.
 * Core resource IDs are additionally checked against site_id by their APIs.
 */
function foreignTarget(value: unknown, principal: AgentPrincipal, depth = 0): boolean {
  if (depth > 64) return true;
  if (!value || typeof value !== "object") return false;
  const tenant = getTenantContext();
  return Object.entries(value).some(([key, item]) => {
    const name = key.replace(/[_-]/g, "").toLowerCase();
    if (name === "siteid" && item !== principal.owner.siteId) return true;
    if (name === "tenantid" && (!tenant || item !== tenant.tenantId)) return true;
    return foreignTarget(item, principal, depth + 1);
  });
}

/** The tools this principal may see and call right now. */
export async function toolsForPrincipal(principal: AgentPrincipal): Promise<AgentTool[]> {
  if (!principalMatchesSite(principal)) return [];
  const [tools, capabilities] = await Promise.all([
    allTools(principal.owner.siteId),
    principalCapabilities(principal),
  ]);
  return tools.filter((tool) => {
    if (tool.group === "users" && !principal.userTools) {
      if (principal.kind === "assistant" || !tool.annotations.readOnlyHint) return false;
    }
    return tool.capabilities.every((capability) => capabilities.has(capability));
  });
}

function typeMatches(expected: unknown, value: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  });
}

/**
 * Shallow argument check against a tool's input schema: required keys, the
 * top-level types and enums, and unknown keys when the schema is closed. The
 * handler validates in depth; this turns the common mistakes into errors a
 * model can fix before a request is made.
 */
export function checkArguments(
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `Missing required argument "${key}".`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key] as { type?: unknown; enum?: unknown[] } | undefined;
    if (!spec) {
      if (schema.additionalProperties === false) {
        return `Unknown argument "${key}". Allowed: ${Object.keys(schema.properties).join(", ") || "none"}.`;
      }
      continue;
    }
    if (value === undefined) continue;
    if (spec.type !== undefined && !typeMatches(spec.type, value)) {
      return `Argument "${key}" must be ${Array.isArray(spec.type) ? spec.type.join(" or ") : String(spec.type)}.`;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      return `Argument "${key}" must be one of ${spec.enum.join(", ")}.`;
    }
  }
  return null;
}

function targetOf(tool: AgentTool, args: Record<string, unknown>): string | null {
  const value = tool.targetArg ? args[tool.targetArg] : undefined;
  return typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, 255)
    : null;
}

function audit(
  tool: AgentTool,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
  outcome: ToolOutcome,
): void {
  if (tool.annotations.readOnlyHint) return;
  const { principal } = ctx;
  // Never the arguments themselves: they can hold content, passwords or keys.
  const credential =
    principal.kind === "api-key"
      ? `key=${principal.key.id}`
      : principal.kind === "oauth"
        ? `oauth_client=${principal.oauthClientId ?? ""} grant=${principal.id}`
        : "assistant";
  void auditLog({
    siteId: principal.owner.siteId,
    action: "ai.tool_called",
    outcome: outcome.ok ? "success" : "failure",
    actorId: principal.owner.userId,
    actorRole: principal.via,
    target: targetOf(tool, args),
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    detail: `tool=${tool.name} via=${principal.via} client=${principal.clientName} ${credential}${
      outcome.ok ? "" : ` status=${outcome.status ?? "error"}`
    }`,
  });
}

export interface ToolCallResult extends Pick<AgentTool, "name" | "annotations"> {
  outcome: ToolOutcome;
}

/** Find a tool the principal may call, or explain why not (without leaking which). */
export async function resolveTool(
  principal: AgentPrincipal,
  name: string,
): Promise<AgentTool | null> {
  const tools = await toolsForPrincipal(principal);
  return tools.find((tool) => tool.name === name) ?? null;
}

export async function callTool(
  principal: AgentPrincipal,
  name: string,
  rawArgs: unknown,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<ToolCallResult> {
  const tool = await resolveTool(principal, name);
  if (!tool) {
    return {
      name,
      annotations: READ,
      outcome: {
        ok: false,
        status: 403,
        error: `Tool "${name}" is not available to this session.`,
      },
    };
  }
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  if (foreignTarget(args, principal)) {
    return { name, annotations: tool.annotations, outcome: { ok: false, status: 403, error: "Cross-site agent access is forbidden." } };
  }
  const problem = checkArguments(tool.inputSchema, args);
  const ctx: ToolCallContext = { principal, ip: meta.ip, userAgent: meta.userAgent };
  if (problem)
    return {
      name,
      annotations: tool.annotations,
      outcome: { ok: false, status: 400, error: problem },
    };

  let outcome: ToolOutcome;
  try {
    // Marked before any tool or plugin code runs: platform operations refuse delegated work.
    const delegate = {
      kind: principal.kind === "assistant" ? "assistant" : "mcp",
      client: principal.clientName,
    } as const;
    outcome = await runAsDelegate(delegate, () =>
      runWithAgentOrigin({ via: principal.via, client: principal.clientName }, () =>
        tool.run(args, ctx),
      ),
    );
  } catch (err) {
    console.error(
      "[justflows] agent tool failed",
      JSON.stringify(logSafe(`${name}: tool execution failed`)),
    );
    outcome = { ok: false, status: 500, error: "The tool failed to run." };
  }
  outcome = outcome.ok
    ? { ok: true, data: safeAgentData(outcome.data) }
    : { ...outcome, error: safeAgentText(outcome.error) };
  audit(tool, args, ctx, outcome);
  return { name, annotations: tool.annotations, outcome };
}

/** Serialize a tool outcome for a model, capped so one call cannot flood a context window. */
export function outcomeText(outcome: ToolOutcome): string {
  const text = outcome.ok
    ? JSON.stringify(safeAgentData(outcome.data), null, 1)
    : safeAgentText(outcome.error);
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated; request a smaller page with "limit")`
    : text;
}
