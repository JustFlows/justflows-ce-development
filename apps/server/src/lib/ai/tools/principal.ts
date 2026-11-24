// SPDX-License-Identifier: MIT

import type { UserCapability } from "@justflows/sdk";
import { getEffectiveAccess } from "../../auth/access-policy.js";
import { keyHolds, pluginCapabilityIds, type ApiKeyOwner, type ApiKeyRecord } from "../../auth/api-keys.js";
import type { AgentVia } from "../agent-origin.js";

/**
 * Who an agent tool call runs as.
 *
 * All three ways in resolve to the same shape the management API already
 * authorizes against — a key-like capability set plus its owner:
 *
 * - `api-key`: a real `jfk_…` key, unchanged.
 * - `oauth`: an OAuth grant; `key` is synthesized from the grant's capability
 *   set (what the user consented to, never more than they had).
 * - `assistant`: the signed-in admin user; `key` carries their own effective
 *   capabilities, so the assistant can never do more than they can.
 *
 * `keyCan` re-intersects `key.capabilities` with the owner's *current* access
 * on every handler, so a role change or revocation applies to the next call.
 */
export interface AgentPrincipal {
  kind: "api-key" | "oauth" | "assistant";
  /** Key id, OAuth grant id, or `assistant:<userId>` — used for rate limits and audit. */
  id: string;
  /** Client display name for audit and revision attribution. */
  clientName: string;
  /** OAuth client id (public identifier) when `kind` is `oauth`. */
  oauthClientId?: string;
  key: ApiKeyRecord;
  owner: ApiKeyOwner;
  /** Tools that change users & roles are off unless the key or grant turned them on. */
  userTools: boolean;
  via: AgentVia;
}

/** A synthetic key record for a principal that is not a stored API key. */
export function syntheticKey(input: {
  id: string;
  name: string;
  owner: ApiKeyOwner;
  capabilities: UserCapability[];
  rateLimitPerMin?: number | null;
}): ApiKeyRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    siteId: input.owner.siteId,
    name: input.name,
    keyPrefix: "",
    ownerUserId: input.owner.userId,
    createdBy: input.owner.userId,
    capabilities: [...new Set(input.capabilities)],
    scope: {},
    allowedIps: [],
    allowedOrigins: [],
    rateLimitPerMin: input.rateLimitPerMin ?? null,
    mcpUserTools: false,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    requestCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The capabilities a principal can exercise right now: its key set ∩ the
 * owner's current effective set. Used to filter `tools/list`; each call is
 * still checked again by the handler it reaches.
 */
export async function principalCapabilities(principal: AgentPrincipal): Promise<Set<UserCapability>> {
  const [access, plugin] = await Promise.all([
    getEffectiveAccess(principal.owner.userId, principal.owner.siteId, principal.owner.role),
    pluginCapabilityIds(),
  ]);
  return new Set(access.capabilities.filter((capability) => keyHolds(principal.key, capability, plugin)));
}

/** An API key resolved by `verifyApiKey`, used as-is. */
export function principalFromApiKey(key: ApiKeyRecord, owner: ApiKeyOwner): AgentPrincipal {
  return {
    kind: "api-key",
    id: key.id,
    clientName: key.name,
    key,
    owner,
    userTools: key.mcpUserTools,
    via: "mcp",
  };
}

/** An OAuth grant: the consented capability set as a synthetic key. */
export function principalFromGrant(grant: {
  id: string;
  siteId: string;
  userId: string;
  clientId: string;
  clientName: string;
  capabilities: UserCapability[];
  userTools: boolean;
}, role: string): AgentPrincipal {
  const owner: ApiKeyOwner = { userId: grant.userId, siteId: grant.siteId, role };
  return {
    kind: "oauth",
    id: grant.id,
    clientName: grant.clientName,
    oauthClientId: grant.clientId,
    key: syntheticKey({ id: grant.id, name: grant.clientName, owner, capabilities: grant.capabilities }),
    owner,
    userTools: grant.userTools,
    via: "mcp",
  };
}

/**
 * The signed-in admin user, for the in-admin assistant. Their current
 * capabilities (minus users & roles management, which the assistant never
 * offers) — `keyCan` re-checks each one against their live access anyway.
 */
export async function principalForAssistant(session: { userId: string; siteId: string; role: string }): Promise<AgentPrincipal> {
  const owner: ApiKeyOwner = { userId: session.userId, siteId: session.siteId, role: session.role };
  const access = await getEffectiveAccess(session.userId, session.siteId, session.role);
  return {
    kind: "assistant",
    id: `assistant:${session.userId}`,
    clientName: "Assistant",
    key: syntheticKey({ id: `assistant:${session.userId}`, name: "Assistant", owner, capabilities: [...access.capabilities] }),
    owner,
    userTools: false,
    via: "assistant",
  };
}
