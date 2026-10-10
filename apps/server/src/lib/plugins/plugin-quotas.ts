// SPDX-License-Identifier: MIT

import type { PluginPermission, PluginQuotaTarget, PluginQuotasApi, QuotaMeterView } from "@justflows/sdk";
import { getControlDb } from "../database/db.js";
import { installationRootSiteId } from "../tenancy/registry.js";
import {
  checkQuota,
  listMeterDefinitions,
  listQuotaMeters,
  registerPluginMeter,
  scopeIdForMeter,
  setQuotaLimit,
  type QuotaMeterDefinition,
} from "../tenancy/quotas.js";

export function createPluginQuotasApi(
  pluginId: string,
  permissions: ReadonlySet<PluginPermission>,
  siteId: string,
): PluginQuotasApi {
  async function meterFor(key: string): Promise<{ meter: QuotaMeterDefinition; scopeId: string }> {
    const meter = listMeterDefinitions().find((item) => item.key === key);
    if (!meter) throw new Error(`Unknown quota meter "${key}".`);
    return { meter, scopeId: await scopeIdForMeter(meter, siteId) };
  }

  function requireTenancy(): void {
    if (!permissions.has("platform:tenancy")) {
      throw new Error(`Plugin "${pluginId}" requires the "platform:tenancy" permission`);
    }
  }

  /**
   * Another workspace's or site's scope. Only a plugin on the installation's root
   * site may reach one: on a hosted site the same plugin could otherwise raise
   * its own workspace's limits.
   */
  async function targetScope(meter: QuotaMeterDefinition, target: PluginQuotaTarget): Promise<string> {
    requireTenancy();
    const root = await installationRootSiteId();
    if (root !== null && root !== siteId) {
      throw new Error(`Plugin "${pluginId}" can only change other workspaces from the root site.`);
    }
    if ("tenantId" in target) {
      if (meter.scope !== "workspace") throw new Error(`Quota meter "${meter.key}" is set per site; pass a siteId.`);
      return target.tenantId;
    }
    if (meter.scope === "site") return target.siteId;
    const db = await getControlDb();
    const rows = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM sites WHERE id = ? LIMIT 1", [target.siteId]);
    if (!rows[0]) throw new Error("That website was not found.");
    return String(rows[0].tenant_id);
  }

  return {
    register: (registration) => registerPluginMeter(pluginId, registration),
    async meters() {
      return listMeterDefinitions().map((meter) => ({
        key: meter.key,
        scope: meter.scope,
        label: meter.label,
        unit: meter.unit,
        owner: meter.owner,
      }));
    },
    async check(key, input) {
      const { scopeId } = await meterFor(key);
      return checkQuota(key, scopeId, input);
    },
    async get(key, target): Promise<QuotaMeterView> {
      if (target) {
        const meter = listMeterDefinitions().find((item) => item.key === key);
        if (!meter) throw new Error(`Unknown quota meter "${key}".`);
        const scopeId = await targetScope(meter, target);
        const view = (await listQuotaMeters(meter.scope, scopeId)).find((item) => item.key === key);
        return view ?? { key: meter.key, scope: meter.scope, label: meter.label, unit: meter.unit, limit: null, used: null };
      }
      const { meter, scopeId } = await meterFor(key);
      const decision = await checkQuota(key, scopeId, meter.owner === "core" || meter.count ? { delta: 0 } : { delta: 0, used: 0 });
      return {
        key: meter.key,
        scope: meter.scope,
        label: meter.label,
        unit: meter.unit,
        limit: decision.limit,
        used: meter.owner === "core" || meter.count ? decision.used : null,
      };
    },
    async set(key, limit, target) {
      requireTenancy();
      if (target) {
        const meter = listMeterDefinitions().find((item) => item.key === key);
        if (!meter) throw new Error(`Unknown quota meter "${key}".`);
        await setQuotaLimit(meter.scope, await targetScope(meter, target), key, limit, null);
        return;
      }
      const { meter, scopeId } = await meterFor(key);
      await setQuotaLimit(meter.scope, scopeId, key, limit, null);
    },
  };
}
