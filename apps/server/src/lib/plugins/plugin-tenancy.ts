// SPDX-License-Identifier: MIT

import type {
  PluginAddSiteInput,
  PluginCreateWorkspaceInput,
  PluginPermission,
  PluginTenancyApi,
  PluginTenancyResult,
  PluginWorkspace,
  PluginWorkspaceContext,
  PluginWorkspaceSite,
} from "@justflows/sdk";
import { getControlDb } from "../database/db.js";
import { getTenantContext } from "../tenancy/context.js";
import {
  createAdditionalSite,
  createWorkspace,
  deleteTenant,
  reactivateTenant,
  suspendTenant,
} from "../tenancy/provision.js";

function requireTenancy(pluginId: string, permissions: ReadonlySet<PluginPermission>): void {
  if (!permissions.has("platform:tenancy")) {
    throw new Error(`Plugin "${pluginId}" requires the "platform:tenancy" permission`);
  }
}

function asResult(result: PluginTenancyResult): PluginTenancyResult {
  return result;
}

export function createPluginTenancyApi(
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
): PluginTenancyApi {
  return {
    async current(): Promise<PluginWorkspaceContext | null> {
      const current = getTenantContext();
      if (!current) return null;
      return {
        tenantId: current.tenantId,
        siteId: current.siteId,
        hostname: current.hostname,
        userMode: current.userMode,
        databaseMode: current.databaseMode,
        rootSite: current.rootSite === true,
      };
    },

    async listWorkspaces(): Promise<PluginWorkspace[]> {
      requireTenancy(pluginId, permissions);
      const db = await getControlDb();
      const rows = await db.query<{
        id: string;
        name: string;
        slug: string;
        status: PluginWorkspace["status"];
        user_mode: PluginWorkspace["userMode"];
        database_mode: PluginWorkspace["databaseMode"];
        owner_user_id: string | null;
      }>(
        `SELECT id, name, slug, status, user_mode, database_mode, owner_user_id FROM tenants
         WHERE status <> 'deleted' ORDER BY created_at ASC`,
      );
      return rows.map((row) => ({
        id: String(row.id),
        ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
        name: String(row.name),
        slug: String(row.slug),
        status: row.status,
        userMode: row.user_mode,
        databaseMode: row.database_mode,
      }));
    },

    async listSites(tenantId: string): Promise<PluginWorkspaceSite[]> {
      requireTenancy(pluginId, permissions);
      const db = await getControlDb();
      const rows = await db.query<{
        id: string;
        tenant_id: string;
        name: string;
        hostname: string | null;
        status: string;
        database_choice: PluginWorkspaceSite["databaseChoice"];
      }>(
        `SELECT s.id, s.tenant_id, s.name, s.status, s.database_choice, d.hostname
         FROM sites s
         LEFT JOIN site_domains d ON d.site_id = s.id AND d.is_primary = ?
         WHERE s.tenant_id = ? AND s.status <> 'deleted'
         ORDER BY s.created_at ASC`,
        [true, tenantId],
      );
      return rows.map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        name: String(row.name),
        hostname: row.hostname ? String(row.hostname) : null,
        status: String(row.status),
        databaseChoice: row.database_choice,
      }));
    },

    async createWorkspace(input: PluginCreateWorkspaceInput): Promise<PluginTenancyResult> {
      requireTenancy(pluginId, permissions);
      return asResult(await createWorkspace({ ...input, actorId: null, platformOperator: false }));
    },

    async addSite(tenantId: string, input: PluginAddSiteInput): Promise<PluginTenancyResult> {
      requireTenancy(pluginId, permissions);
      return asResult(await createAdditionalSite({ tenantId, ...input, actorId: `plugin:${pluginId}` }));
    },

    async suspend(tenantId: string): Promise<PluginTenancyResult> {
      requireTenancy(pluginId, permissions);
      return asResult(await suspendTenant(tenantId, `plugin:${pluginId}`));
    },

    async reactivate(tenantId: string): Promise<PluginTenancyResult> {
      requireTenancy(pluginId, permissions);
      return asResult(await reactivateTenant(tenantId, `plugin:${pluginId}`));
    },

    async deleteWorkspace(tenantId: string, options?: { dropDatabase?: boolean }): Promise<PluginTenancyResult> {
      requireTenancy(pluginId, permissions);
      return asResult(await deleteTenant(tenantId, `plugin:${pluginId}`, options?.dropDatabase === true));
    },
  };
}
