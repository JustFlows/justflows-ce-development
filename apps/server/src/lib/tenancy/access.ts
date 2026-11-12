// SPDX-License-Identifier: MIT

import { getControlDb, getDb } from "../database/db.js";
import { getTenantContext } from "./context.js";
import { multisiteEnabled } from "./multisite.js";

export interface LoginAccount {
  id: string;
  homeSiteId: string;
  siteId: string;
  email: string;
  password_hash: string;
  role: string;
  token_version: number | null;
}

/** Nobody operates the platform while multisite is off. */
export async function isPlatformOperator(userId: string): Promise<boolean> {
  if (!multisiteEnabled()) return false;
  try {
    const db = await getControlDb();
    const rows = await db.query<{ user_id: string }>(
      "SELECT user_id FROM platform_operators WHERE user_id = ? LIMIT 1",
      [userId],
    );
    return Boolean(rows[0]);
  } catch {
    return false;
  }
}

export async function findLoginAccount(siteId: string, email: string): Promise<LoginAccount | null> {
  const db = await getDb();
  let userMode = "isolated";
  try {
    const modes = await db.query<{ user_mode: string }>(
      "SELECT t.user_mode FROM sites s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ? LIMIT 1",
      [siteId],
    );
    if (modes[0]?.user_mode === "shared") userMode = "shared";
  } catch {
    userMode = "isolated";
  }

  if (userMode === "shared") {
    const rows = await db.query<LoginAccount & { role: string | null }>(
      `SELECT u.id, u.site_id AS homeSiteId, u.email, u.password_hash, u.token_version,
              COALESCE(m.role, CASE WHEN u.site_id = ? THEN u.role ELSE NULL END) AS role
       FROM users u
       JOIN sites home ON home.id = u.site_id
       LEFT JOIN site_memberships m ON m.user_id = u.id AND m.site_id = ?
       WHERE home.tenant_id = (SELECT tenant_id FROM sites WHERE id = ?)
         AND u.email = ?
         AND (u.site_id = ? OR m.site_id IS NOT NULL)
       LIMIT 1`,
      [siteId, siteId, siteId, email, siteId],
    );
    const row = rows[0];
    if (!row?.role) return null;
    return { ...row, siteId, homeSiteId: String(row.homeSiteId) };
  }

  const rows = await db.query<Omit<LoginAccount, "siteId" | "homeSiteId"> & { site_id: string }>(
    "SELECT id, site_id, email, password_hash, role, token_version FROM users WHERE site_id = ? AND email = ? LIMIT 1",
    [siteId, email],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    homeSiteId: String(row.site_id),
    siteId,
    email: String(row.email),
    password_hash: String(row.password_hash),
    role: String(row.role),
    token_version: row.token_version,
  };
}

/**
 * Updates, diagnostics, and process settings belong to the installation's
 * first site. A missing tenant context is that single-site case.
 */
export function isInstallationRootRequest(): boolean {
  const ctx = getTenantContext();
  if (!ctx) return true;
  return ctx.rootSite === true;
}

/** A session cookie is only valid for the site the Host header resolved. */
export function sessionMatchesRequestSite(sessionSiteId: string): boolean {
  const ctx = getTenantContext();
  if (!ctx) return true;
  return ctx.siteId === sessionSiteId;
}
