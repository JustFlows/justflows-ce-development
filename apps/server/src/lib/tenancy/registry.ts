// SPDX-License-Identifier: MIT

import { getControlDb, type DbClient } from "../database/db.js";
import { isMissingColumnError, isMissingTableError } from "../database/schema-errors.js";
import { multisiteEnabled } from "./multisite.js";
import type { DatabaseChoice, DatabaseMode, TenantStatus, UserMode } from "./context.js";
import { hostnameFromUrl, pickHost, type HostDecision, type HostRecord } from "./host.js";

interface DomainRow {
  hostname: string;
  site_id: string;
  tenant_id: string;
  site_status: string;
  tenant_status: string;
  user_mode: string;
  database_mode: string;
  database_choice: string;
  primary_hostname?: string | null;
  primary_kind?: string | null;
}

/**
 * Only active hostnames route. A custom domain that is still being verified,
 * or that stopped pointing here, is not served. Before migration 0039 the
 * status column does not exist yet, so every row routes as it did. Any other
 * failure propagates: it must never silently drop the status filter.
 */
async function domainRows(client: DbClient): Promise<DomainRow[]> {
  try {
    return await client.query<DomainRow>(
      `SELECT d.hostname, s.id AS site_id, s.tenant_id, s.status AS site_status,
              t.status AS tenant_status, t.user_mode, t.database_mode, s.database_choice,
              p.hostname AS primary_hostname, p.kind AS primary_kind
       FROM site_domains d
       JOIN sites s ON s.id = d.site_id
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN site_domains p ON p.site_id = s.id AND p.is_primary = ? AND p.status = 'active'
       WHERE d.status = 'active'`,
      [true],
    );
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
    return client.query<DomainRow>(
      `SELECT d.hostname, s.id AS site_id, s.tenant_id, s.status AS site_status,
              t.status AS tenant_status, t.user_mode, t.database_mode, s.database_choice
       FROM site_domains d
       JOIN sites s ON s.id = d.site_id
       JOIN tenants t ON t.id = s.tenant_id`,
    );
  }
}

function asStatus(value: string): TenantStatus {
  if (value === "suspended" || value === "provisioning" || value === "deleted") return value;
  return "active";
}

function asUserMode(value: string): UserMode {
  return value === "shared" ? "shared" : "isolated";
}

function asDatabaseMode(value: string): DatabaseMode {
  return value === "separate" ? "separate" : "current";
}

function asChoice(value: string): DatabaseChoice {
  if (value === "current" || value === "separate") return value;
  return "inherit";
}

/**
 * Null only when the tenancy tables do not exist (a single-site install that
 * predates multisite). Any other database failure throws, so a transient
 * control-plane error can never be mistaken for single-site mode.
 */
export async function loadHostRecords(db?: DbClient): Promise<{
  records: HostRecord[];
  siteCount: number;
} | null> {
  const client = db ?? (await getControlDb());
  try {
    const counts = await client.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM sites");
    const siteCount = Number(counts[0]?.count ?? 0);
    const roots = await client.query<{ id: string }>(
      "SELECT id FROM sites WHERE status <> 'deleted' ORDER BY created_at ASC, id ASC LIMIT 1",
    );
    const rootSiteId = roots[0] ? String(roots[0].id) : "";
    const rows = await domainRows(client);
    return {
      siteCount,
      records: rows.map((row) => ({
        hostname: String(row.hostname).toLowerCase(),
        siteId: String(row.site_id),
        tenantId: String(row.tenant_id),
        siteStatus: asStatus(String(row.site_status)),
        tenantStatus: asStatus(String(row.tenant_status)),
        userMode: asUserMode(String(row.user_mode)),
        databaseMode: asDatabaseMode(String(row.database_mode)),
        databaseChoice: asChoice(String(row.database_choice)),
        rootSite: String(row.site_id) === rootSiteId,
        ...(row.primary_hostname
          ? { primaryHostname: String(row.primary_hostname).toLowerCase(), primaryCustom: row.primary_kind === "custom" }
          : {}),
      })),
    };
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

export type ResolvedHost = HostDecision | { kind: "unconfigured" } | { kind: "unavailable" };

/** `unavailable` means routing could not be established; callers must refuse the request. */
export async function resolveHost(hostname: string, db?: DbClient): Promise<ResolvedHost> {
  let loaded: Awaited<ReturnType<typeof loadHostRecords>>;
  try {
    loaded = await loadHostRecords(db);
  } catch {
    return { kind: "unavailable" };
  }
  if (!loaded) return { kind: "unconfigured" };
  if (!multisiteEnabled()) {
    /** With multisite off only the root site is served; other sites keep their data but are unreachable. */
    const root = loaded.records.filter((record) => record.rootSite);
    if (root.length === 0) return { kind: "unconfigured" };
    return pickHost({ hostname, records: root, siteCount: 1 });
  }
  if (loaded.records.length === 0 && loaded.siteCount <= 1) return { kind: "unconfigured" };
  return pickHost({ hostname, records: loaded.records, siteCount: loaded.siteCount });
}

export function hostnameOf(url: string): string | null {
  return hostnameFromUrl(url);
}

/** The site created with the installation. Null when tenancy tables are not there yet. */
export async function installationRootSiteId(db?: DbClient): Promise<string | null> {
  const client = db ?? (await getControlDb());
  try {
    const roots = await client.query<{ id: string }>(
      "SELECT id FROM sites WHERE status <> 'deleted' ORDER BY created_at ASC, id ASC LIMIT 1",
    );
    return roots[0] ? String(roots[0].id) : null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

/** A missing tenancy table is a single-site install, which is the root site. */
export async function isInstallationRootSite(siteId: string): Promise<boolean> {
  const root = await installationRootSiteId();
  if (!root) return true;
  return root === siteId;
}
