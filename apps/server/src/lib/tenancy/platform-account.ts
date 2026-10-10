// SPDX-License-Identifier: MIT

import { getControlDb } from "../database/db.js";

/** Ownership is always scoped to the authenticated root user, never an email. */
export async function ownedWorkspace(userId: string, tenantId: string) {
  const db = await getControlDb();
  const rows = await db.query<{ id: string; name: string; slug: string; status: string; user_mode: string }>(
    "SELECT id, name, slug, status, user_mode FROM tenants WHERE id = ? AND owner_user_id = ? AND status <> 'deleted' LIMIT 1",
    [tenantId, userId],
  );
  return rows[0] ?? null;
}

export async function ownerAccount(userId: string) {
  const db = await getControlDb();
  const workspaces = await db.query<{ id: string; name: string; status: string; user_mode: string }>(
    "SELECT id, name, status, user_mode FROM tenants WHERE owner_user_id = ? AND status <> 'deleted' ORDER BY created_at ASC, id ASC LIMIT 200",
    [userId],
  );
  const sites = await db.query<{ id: string; tenant_id: string; name: string; url: string; status: string }>(
    `SELECT s.id, s.tenant_id, s.name, s.url, s.status FROM sites s JOIN tenants t ON t.id = s.tenant_id
     WHERE t.owner_user_id = ? AND t.status <> 'deleted' AND s.status <> 'deleted'
     ORDER BY s.created_at ASC, s.id ASC LIMIT 1000`, [userId],
  );
  const grouped = new Map<string, typeof sites>();
  for (const site of sites) {
    const group = grouped.get(site.tenant_id) ?? [];
    group.push(site);
    grouped.set(site.tenant_id, group);
  }
  return workspaces.map((workspace) => ({
    id: workspace.id, name: workspace.name, status: workspace.status, userMode: workspace.user_mode,
    sites: (grouped.get(workspace.id) ?? []).map((site) => {
      // Stored site URLs are not trusted executable navigation targets.
      let url: string | null = null;
      try { const parsed = new URL(site.url); if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.origin; } catch { /* No public link for an invalid URL. */ }
      return { id: site.id, name: site.name, status: site.status, url };
    }),
  }));
}
