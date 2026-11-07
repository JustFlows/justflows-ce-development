// SPDX-License-Identifier: MIT
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { ANONYMOUS_VIEWER, type ContentVisibilityViewer } from "@justflows/content";
import { getEffectiveAccess } from "../auth/access-policy.js";
import { resolveSession } from "../auth/auth-session.js";
import { getSession } from "../auth/session.js";
import { sessionMatchesRequestSite } from "../tenancy/access.js";

interface VisibilityRequestState {
  viewer: () => Promise<ContentVisibilityViewer>;
  /** Built once per request and viewer, typed loosely to keep this module free of the scope. */
  scopes: Map<string, Promise<unknown>>;
}

const storage = new AsyncLocalStorage<VisibilityRequestState>();

/** A custom role lives in the access policy, not on the user row, so read the effective roles. */
export async function visibilityViewerFor(userId: string, siteId: string, role: string): Promise<ContentVisibilityViewer> {
  const access = await getEffectiveAccess(userId, siteId, role);
  return { userId, roles: [...new Set([access.roleId, ...access.additionalRoles])], authenticated: true };
}

async function resolveRequestViewer(req: Request, res: Response): Promise<ContentVisibilityViewer> {
  if (!getSession(req)) return ANONYMOUS_VIEWER;
  try {
    const session = await resolveSession(req, res);
    if (!session || !sessionMatchesRequestSite(session.siteId)) return ANONYMOUS_VIEWER;
    return await visibilityViewerFor(session.userId, session.siteId, session.role);
  } catch {
    return ANONYMOUS_VIEWER;
  }
}

/** Makes the visitor available to every read below. Resolved only when something needs it. */
export function visibilityRequestContext(req: Request, res: Response, next: NextFunction): void {
  let viewer: Promise<ContentVisibilityViewer> | undefined;
  storage.run({ viewer: () => (viewer ??= resolveRequestViewer(req, res)), scopes: new Map() }, next);
}

/** Outside a request, nobody has identified themselves: a job or export reads as anonymous. */
export async function currentVisibilityViewer(): Promise<ContentVisibilityViewer> {
  return (await storage.getStore()?.viewer()) ?? ANONYMOUS_VIEWER;
}

export function visibilityRequestMemo(): Map<string, Promise<unknown>> | undefined {
  return storage.getStore()?.scopes;
}
