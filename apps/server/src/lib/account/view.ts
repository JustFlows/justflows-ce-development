// SPDX-License-Identifier: MIT

import type { SessionPayload } from "../auth/session.js";
import { accountSections } from "./sections.js";
import { isInstallationRootRequest } from "../tenancy/access.js";
import { ownerAccount } from "../tenancy/platform-account.js";
import { platformBaseDomain } from "../tenancy/saas-settings.js";
import { signupBaseDomain } from "../tenancy/host.js";
import { listQuotaMeters } from "../tenancy/quotas.js";

export async function accountView(session: SessionPayload) {
  const installationRoot = isInstallationRootRequest();
  const [workspaces, siteDomain, sections] = await Promise.all([
    installationRoot ? ownerAccount(session.userId) : Promise.resolve([]),
    installationRoot ? platformBaseDomain().then(signupBaseDomain) : Promise.resolve(null),
    accountSections({ siteId: session.siteId, userId: session.userId, email: session.email, role: session.role, installationRoot }),
  ]);
  const workspace = workspaces[0] ?? null;
  let meters: Awaited<ReturnType<typeof listQuotaMeters>> | null = null;
  if (workspace) { try { meters = await listQuotaMeters("workspace", workspace.id); } catch { /* Independent measurement failure. */ } }
  return { email: session.email, workspaces, workspace, siteDomain, sections, meters,
    initialAccount: JSON.stringify({ workspaces, siteDomain }).replace(/</g, "\\u003c") };
}
