// SPDX-License-Identifier: MIT

import { seedAccountPage } from "@justflows/content";
import { randomUUID } from "node:crypto";
import { createDbClient, getControlDb, runWithDatabase, type DbClient } from "../database/db.js";
import { runAllMigrations } from "../database/run-migrations.js";
import { hashPassword } from "../auth/password.js";
import { freshInstallSiteSettings, siteSettingsInsertSql } from "../installation/install-defaults.js";
import { encryptSecret, decryptSecret } from "../security/secret-box.js";
import {
  quoteDatabaseIdent,
  sanitizeDatabaseError,
  validateDatabaseChoice,
  validateDatabaseTarget,
  type DatabaseTarget,
} from "./choice.js";
import type { DatabaseChoice, DatabaseMode, UserMode } from "./context.js";
import { hostnameFromUrl, isValidHostname, normalizeHostname, siteDomainKind, slugify } from "./host.js";
import { platformBaseDomain } from "./saas-settings.js";
import { ensureWorkspaceOwnerAccount } from "./workspace-owner.js";

type Sql = Pick<DbClient, "run" | "query">;

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

async function workspaceGate(name: string, payload: object): Promise<string | null> {
  const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  const { isHookAbortError } = await import("@justflows/core");
  try {
    await getRuntimeHooks().dispatchGate(name, payload, { source: "system" });
    return null;
  } catch (err) {
    if (isHookAbortError(err)) return err.message.replace(/[\r\n]/g, " ").slice(0, 300);
    throw err;
  }
}

async function workspaceAction(name: string, payload: object): Promise<void> {
  const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  await getRuntimeHooks().dispatchAction(name, payload, { source: "system" });
}

function installationDriver(): "postgres" | "mysql" | "mariadb" {
  const driver = process.env.DB_DRIVER;
  if (driver === "postgres" || driver === "mysql" || driver === "mariadb") return driver;
  throw new Error("DB_DRIVER not set");
}

export interface WorkspaceAdmin {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  userMode: UserMode;
  databaseMode: DatabaseMode;
  siteName: string;
  hostname: string;
  siteUrl?: string;
  admin: WorkspaceAdmin;
  database?: DatabaseTarget;
  actorId: string | null;
  platformOperator?: boolean;
}

export type ProvisionResult =
  | { ok: true; tenantId: string; siteId: string; hostname: string }
  | { ok: false; status: number; error: string; code?: string; meter?: string };

async function audit(actorId: string | null, action: string, target: string, detail: string): Promise<void> {
  const db = await getControlDb();
  const uuid = actorId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId) ? actorId : null;
  const note = uuid || !actorId ? detail : `${actorId}: ${detail}`.slice(0, 500);
  await db.run(
    "INSERT INTO platform_audit (id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [randomUUID(), uuid, action, target, note, now()],
  );
}

async function copyQuotaDefaults(scope: "workspace" | "site", scopeId: string): Promise<void> {
  try {
    const { applyQuotaDefaults } = await import("./quotas.js");
    await applyQuotaDefaults(scope, scopeId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    console.error("[justflows] quota defaults were not applied:", JSON.stringify(message.replace(/[\r\n]/g, " ")));
  }
}

async function hostnameTaken(hostname: string): Promise<boolean> {
  const db = await getControlDb();
  const rows = await db.query<{ id: string }>("SELECT id FROM site_domains WHERE hostname = ? LIMIT 1", [hostname]);
  return Boolean(rows[0]);
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<ProvisionResult> {
  const slug = slugify(input.slug || input.name);
  const hostname = input.hostname.trim().toLowerCase();
  const choice = validateDatabaseChoice({
    userMode: input.userMode,
    tenantMode: input.databaseMode,
    siteChoice: "inherit",
    target: input.databaseMode === "separate" ? input.database : null,
  });
  if (!choice.ok) return { ok: false, status: 400, error: choice.error };
  if (input.databaseMode === "separate") {
    const problem = validateDatabaseTarget(input.database);
    if (problem) return { ok: false, status: 400, error: problem };
  }
  if (!isValidHostname(hostname)) {
    return { ok: false, status: 400, error: "Hostname is not valid." };
  }
  if (await hostnameTaken(hostname)) return { ok: false, status: 409, error: "That hostname is already in use." };
  const blocked = await workspaceGate("workspace.beforeCreate", {
    name: input.name,
    slug,
    userMode: input.userMode,
    databaseMode: input.databaseMode,
    siteName: input.siteName,
    hostname,
  });
  if (blocked) return { ok: false, status: 403, error: blocked };

  const db = await getControlDb();
  const tenantId = randomUUID();
  const siteId = randomUUID();
  const stamp = now();
  const status = input.databaseMode === "separate" ? "provisioning" : "active";
  const siteUrl = input.siteUrl ?? `https://${hostname}`;
  const domainKind = siteDomainKind(hostname, await platformBaseDomain());
  try {
    await db.run(
      `INSERT INTO tenants (id, name, slug, status, user_mode, database_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, input.name, slug, status, input.userMode, input.databaseMode, stamp, stamp],
    );
    await db.run(
      `INSERT INTO sites (id, name, url, description, active, installed_at, created_at, updated_at, tenant_id, status, database_choice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [siteId, input.siteName, siteUrl, null, status === "active", stamp, stamp, stamp, tenantId, status, "inherit"],
    );
    await db.run(
      `INSERT INTO site_domains (id, site_id, hostname, kind, verified, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), siteId, hostname, domainKind, true, true, stamp],
    );
    const databaseId = randomUUID();
    if (input.databaseMode === "current") {
      await db.run(
        `INSERT INTO tenant_databases (id, tenant_id, site_id, mode, status, created_at, updated_at)
         VALUES (?, ?, NULL, 'current', 'ready', ?, ?)`,
        [databaseId, tenantId, stamp, stamp],
      );
      await seedSiteContents(db, { tenantId, siteId, siteName: input.siteName, hostname, userMode: input.userMode, databaseMode: "current", admin: input.admin, stamp });
      await runWithDatabase(db, async () => {
        const { ensureDefaultTheme } = await import("../themes/themes-db.js");
        await ensureDefaultTheme(siteId);
      });
    } else {
      const target = input.database as DatabaseTarget;
      await db.run(
        `INSERT INTO tenant_databases (id, tenant_id, site_id, mode, status, driver, host, port, database_name, username, password_ciphertext, created_at, updated_at)
         VALUES (?, ?, NULL, 'separate', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          databaseId,
          tenantId,
          installationDriver(),
          target.host,
          target.port,
          target.database,
          target.username,
          encryptSecret(target.password),
          stamp,
          stamp,
        ],
      );
      const opened = await openSeparateDatabase(target);
      if (!opened.ok) {
        await discardNewWorkspace(db, tenantId, siteId);
        return { ok: false, status: 502, error: "The separate database could not be prepared. Nothing else was changed." };
      }
      try {
        await runAllMigrations(opened.client, installationDriver());
        await seedSiteContents(opened.client, {
          tenantId,
          siteId,
          siteName: input.siteName,
          hostname,
          userMode: input.userMode,
          databaseMode: "separate",
          admin: input.admin,
          stamp,
          tenantName: input.name,
          tenantSlug: slug,
        });
      } catch (err) {
        await opened.client.close();
        await db.run("UPDATE tenant_databases SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [
          sanitizeDatabaseError(err, target.password),
          now(),
          databaseId,
        ]);
        return { ok: false, status: 502, error: "The separate database could not be migrated. Other workspaces were not changed." };
      }
      await runWithDatabase(opened.client, async () => {
        const { ensureDefaultTheme } = await import("../themes/themes-db.js");
        await ensureDefaultTheme(siteId);
      });
      await opened.client.close();
      await db.run("UPDATE tenant_databases SET status = 'ready', last_error = NULL, updated_at = ? WHERE id = ?", [now(), databaseId]);
      await db.run("UPDATE tenants SET status = 'active', updated_at = ? WHERE id = ?", [now(), tenantId]);
      await db.run("UPDATE sites SET status = 'active', active = ? WHERE id = ?", [true, siteId]);
    }
    if (input.platformOperator) {
      const owners = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE site_id = ? AND role = 'administrator' ORDER BY created_at ASC LIMIT 1",
        [siteId],
      );
      if (owners[0] && input.databaseMode === "current") {
        await db.run("INSERT INTO platform_operators (user_id, created_at) VALUES (?, ?)", [owners[0].id, stamp]);
      }
    }
    const rootOwner = await ensureWorkspaceOwnerAccount(db, {
      email: input.admin.email,
      username: input.admin.username,
      displayName: input.admin.displayName,
      passwordHash: await hashPassword(input.admin.password),
    }, stamp);
    await db.run("UPDATE tenants SET owner_user_id = ? WHERE id = ?", [rootOwner.userId, tenantId]);
    if (rootOwner.created) {
      const { emitUserEvent } = await import("../auth/users-admin.js");
      await runWithDatabase(db, () => emitUserEvent("user.created", rootOwner.userId, rootOwner.siteId));
    }
    await copyQuotaDefaults("workspace", tenantId);
    await copyQuotaDefaults("site", siteId);
    await audit(input.actorId, "tenant.created", tenantId, `database=${input.databaseMode};users=${input.userMode}`);
    await workspaceAction("workspace.created", {
      tenantId,
      siteId,
      hostname,
      userMode: input.userMode,
      databaseMode: input.databaseMode,
    });
    // Same event with the administrator's email, for platform plugins only (`platform:tenancy`).
    await workspaceAction("tenancy.workspaceCreated", {
      tenantId,
      siteId,
      hostname,
      userMode: input.userMode,
      databaseMode: input.databaseMode,
      adminEmail: input.admin?.email ? String(input.admin.email).toLowerCase() : "",
    });
    return { ok: true, tenantId, siteId, hostname };
  } catch (err) {
    console.error("[justflows] workspace provisioning failed:", err instanceof Error ? err.message.replace(/[\r\n]/g, " ") : "failed");
    return { ok: false, status: 500, error: "The workspace could not be created." };
  }
}

async function seedSiteContents(
  db: Sql,
  input: {
    tenantId: string;
    siteId: string;
    siteName: string;
    hostname: string;
    userMode: UserMode;
    databaseMode: DatabaseMode;
    admin: WorkspaceAdmin;
    stamp: string;
    tenantName?: string;
    tenantSlug?: string;
  },
): Promise<void> {
  if (input.databaseMode === "separate") {
    await db.run(
      `INSERT INTO tenants (id, name, slug, status, user_mode, database_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, 'separate', ?, ?)`,
      [input.tenantId, input.tenantName ?? input.siteName, input.tenantSlug ?? slugify(input.siteName), input.userMode, input.stamp, input.stamp],
    );
    await db.run(
      `INSERT INTO sites (id, name, url, description, active, installed_at, created_at, updated_at, tenant_id, status, database_choice)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', 'inherit')`,
      [input.siteId, input.siteName, `https://${input.hostname}`, true, input.stamp, input.stamp, input.stamp, input.tenantId],
    );
    await db.run(
      `INSERT INTO site_domains (id, site_id, hostname, kind, verified, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), input.siteId, input.hostname, siteDomainKind(input.hostname, await platformBaseDomain()), true, true, input.stamp],
    );
  }
  const userId = randomUUID();
  const passwordHash = await hashPassword(input.admin.password);
  await db.run(
    `INSERT INTO users (id, site_id, email, username, display_name, password_hash, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'administrator', ?, ?)`,
    [userId, input.siteId, input.admin.email.toLowerCase(), input.admin.username, input.admin.displayName, passwordHash, input.stamp, input.stamp],
  );
  if (input.userMode === "shared") {
    await db.run(
      "INSERT INTO site_memberships (id, user_id, site_id, role, created_at) VALUES (?, ?, ?, 'administrator', ?)",
      [randomUUID(), userId, input.siteId, input.stamp],
    );
  }
  const settingsSql = siteSettingsInsertSql(installationDriver());
  for (const [key, value] of freshInstallSiteSettings(input.admin.email)) {
    await db.run(settingsSql, [randomUUID(), input.siteId, key, JSON.stringify(value), input.stamp]);
  }
  await db.run(
    `INSERT INTO languages (id, site_id, code, name, native_name, is_default, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, 'en', 'English', 'English', ?, ?, 0, ?, ?)`,
    [randomUUID(), input.siteId, true, true, input.stamp, input.stamp],
  );
  await seedAccountPage(db, input.siteId, "en");
}

/** Check the login and the named database. Does not create a database. */
export async function probeSeparateDatabase(target: DatabaseTarget): Promise<{ ok: true } | { ok: false; error: string }> {
  const driver = installationDriver();
  try {
    const client = await createDbClient({
      driver,
      host: target.host,
      port: String(target.port),
      database: target.database,
      username: target.username,
      password: target.password,
    });
    await client.query("SELECT 1");
    await client.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sanitizeDatabaseError(err, target.password) };
  }
}

async function discardNewWorkspace(db: Sql, tenantId: string, siteId: string): Promise<void> {
  await db.run("DELETE FROM site_domains WHERE site_id = ?", [siteId]);
  await db.run("DELETE FROM tenant_databases WHERE tenant_id = ?", [tenantId]);
  await db.run("DELETE FROM sites WHERE id = ?", [siteId]);
  await db.run("DELETE FROM tenants WHERE id = ?", [tenantId]);
}

async function openSeparateDatabase(target: DatabaseTarget): Promise<{ ok: true; client: DbClient } | { ok: false; error: string }> {
  const driver = installationDriver();
  const config = {
    driver,
    host: target.host,
    port: String(target.port),
    database: target.database,
    username: target.username,
    password: target.password,
  };
  try {
    const client = await createDbClient(config);
    await client.query("SELECT 1");
    return { ok: true, client };
  } catch (first) {
    try {
      const admin = await createDbClient({ ...config, database: driver === "postgres" ? "postgres" : "mysql" });
      const ident = quoteDatabaseIdent(target.database, driver);
      if (driver === "postgres") {
        const existing = await admin.query<{ one: number }>("SELECT 1 AS one FROM pg_database WHERE datname = ?", [target.database]);
        if (!existing[0]) await admin.run(`CREATE DATABASE ${ident}`);
      } else {
        await admin.run(`CREATE DATABASE IF NOT EXISTS ${ident} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      }
      await admin.close();
      const client = await createDbClient(config);
      await client.query("SELECT 1");
      return { ok: true, client };
    } catch (err) {
      return { ok: false, error: sanitizeDatabaseError(err ?? first, target.password) };
    }
  }
}

export async function suspendTenant(tenantId: string, actorId: string): Promise<ProvisionResult> {
  const db = await getControlDb();
  const rows = await db.query<{ id: string }>("SELECT id FROM tenants WHERE id = ? AND status <> 'deleted' LIMIT 1", [tenantId]);
  if (!rows[0]) return { ok: false, status: 404, error: "Workspace not found." };
  const blocked = await workspaceGate("workspace.beforeSuspend", { tenantId });
  if (blocked) return { ok: false, status: 403, error: blocked };
  const stamp = now();
  await db.run("UPDATE tenants SET status = 'suspended', updated_at = ? WHERE id = ?", [stamp, tenantId]);
  await db.run("UPDATE sites SET status = 'suspended', active = ? WHERE tenant_id = ?", [false, tenantId]);
  await audit(actorId, "tenant.suspended", tenantId, "sites suspended");
  await workspaceAction("workspace.suspended", { tenantId });
  return { ok: true, tenantId, siteId: "", hostname: "" };
}

export async function reactivateTenant(tenantId: string, actorId: string): Promise<ProvisionResult> {
  const db = await getControlDb();
  const rows = await db.query<{ id: string }>("SELECT id FROM tenants WHERE id = ? AND status = 'suspended' LIMIT 1", [tenantId]);
  if (!rows[0]) return { ok: false, status: 404, error: "Suspended workspace not found." };
  const blocked = await workspaceGate("workspace.beforeReactivate", { tenantId });
  if (blocked) return { ok: false, status: 403, error: blocked };
  const stamp = now();
  await db.run("UPDATE tenants SET status = 'active', updated_at = ? WHERE id = ?", [stamp, tenantId]);
  await db.run("UPDATE sites SET status = 'active', active = ? WHERE tenant_id = ? AND status = 'suspended'", [true, tenantId]);
  await audit(actorId, "tenant.reactivated", tenantId, "sites reactivated");
  await workspaceAction("workspace.reactivated", { tenantId });
  return { ok: true, tenantId, siteId: "", hostname: "" };
}

export async function deleteTenant(tenantId: string, actorId: string, dropDatabase: boolean): Promise<ProvisionResult> {
  const db = await getControlDb();
  const rows = await db.query<{ id: string; database_mode: string }>(
    "SELECT id, database_mode FROM tenants WHERE id = ? LIMIT 1",
    [tenantId],
  );
  const tenant = rows[0];
  if (!tenant) return { ok: false, status: 404, error: "Workspace not found." };
  const blocked = await workspaceGate("workspace.beforeDelete", { tenantId, dropDatabase });
  if (blocked) return { ok: false, status: 403, error: blocked };
  const stamp = now();
  await db.run("UPDATE tenants SET status = 'deleted', updated_at = ? WHERE id = ?", [stamp, tenantId]);
  await db.run("UPDATE sites SET status = 'deleted', active = ? WHERE tenant_id = ?", [false, tenantId]);
  if (dropDatabase && tenant.database_mode === "separate") {
    const databases = await db.query<{ id: string; host: string; port: number; database_name: string; username: string; password_ciphertext: string }>(
      `SELECT id, host, port, database_name, username, password_ciphertext FROM tenant_databases
       WHERE tenant_id = ? AND mode = 'separate' AND database_name IS NOT NULL`,
      [tenantId],
    );
    for (const row of databases) {
      const password = decryptPassword(row.password_ciphertext);
      try {
        const driver = installationDriver();
        const admin = await createDbClient({
          driver,
          host: row.host,
          port: String(row.port),
          database: driver === "postgres" ? "postgres" : "mysql",
          username: row.username,
          password,
        });
        await admin.run(`DROP DATABASE IF EXISTS ${quoteDatabaseIdent(row.database_name, driver)}`);
        await admin.close();
        await db.run("UPDATE tenant_databases SET status = 'failed', last_error = NULL, updated_at = ? WHERE id = ?", [stamp, row.id]);
      } catch (err) {
        await db.run("UPDATE tenant_databases SET last_error = ?, updated_at = ? WHERE id = ?", [
          sanitizeDatabaseError(err, password),
          stamp,
          row.id,
        ]);
      }
    }
  }
  await audit(actorId, "tenant.deleted", tenantId, dropDatabase ? "drop database requested" : "records marked deleted");
  await workspaceAction("workspace.deleted", { tenantId, dropDatabase });
  return { ok: true, tenantId, siteId: "", hostname: "" };
}

/**
 * Removes one customer site from routing. The installation's first site cannot
 * be deleted here. A shared signup database is left in place: other sites may
 * still use it.
 */
export async function deleteCustomerSite(siteId: string, confirmHostname: string, actorId: string): Promise<ProvisionResult> {
  const db = await getControlDb();
  const sites = await db.query<{ id: string; tenant_id: string; status: string }>(
    "SELECT id, tenant_id, status FROM sites WHERE id = ? LIMIT 1",
    [siteId],
  );
  const site = sites[0];
  if (!site || site.status === "deleted") return { ok: false, status: 404, error: "Site not found." };
  const roots = await db.query<{ id: string }>(
    "SELECT id FROM sites WHERE status <> 'deleted' ORDER BY created_at ASC, id ASC LIMIT 1",
    [],
  );
  if (String(roots[0]?.id ?? "") === siteId) {
    return { ok: false, status: 403, error: "The platform site cannot be deleted from its settings." };
  }
  const domains = await db.query<{ hostname: string }>("SELECT hostname FROM site_domains WHERE site_id = ?", [siteId]);
  const confirmed = normalizeHostname(confirmHostname);
  if (!domains.some((row) => normalizeHostname(String(row.hostname)) === confirmed)) {
    return { ok: false, status: 400, error: "Type this site's hostname to confirm." };
  }
  const stamp = now();
  await db.run("UPDATE sites SET status = 'deleted', active = ?, updated_at = ? WHERE id = ?", [false, stamp, siteId]);
  await db.run("DELETE FROM site_domains WHERE site_id = ?", [siteId]);
  const remaining = await db.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM sites WHERE tenant_id = ? AND status <> 'deleted'",
    [site.tenant_id],
  );
  if (Number(remaining[0]?.count ?? 0) === 0) {
    await db.run("UPDATE tenants SET status = 'deleted', updated_at = ? WHERE id = ?", [stamp, site.tenant_id]);
  }
  await audit(actorId, "site.deleted", siteId, confirmed);
  return { ok: true, tenantId: site.tenant_id, siteId, hostname: confirmed };
}

function decryptPassword(value: string): string {
  return decryptSecret(value);
}

export async function migrateTenantDatabase(databaseId: string, actorId: string): Promise<ProvisionResult> {
  const db = await getControlDb();
  const rows = await db.query<{ id: string; tenant_id: string; host: string; port: number; database_name: string; username: string; password_ciphertext: string; mode: string }>(
    `SELECT id, tenant_id, host, port, database_name, username, password_ciphertext, mode
     FROM tenant_databases WHERE id = ? LIMIT 1`,
    [databaseId],
  );
  const row = rows[0];
  if (!row || row.mode !== "separate") return { ok: false, status: 404, error: "Separate database not found." };
  const password = decryptSecret(row.password_ciphertext);
  try {
    const client = await createDbClient({
      driver: installationDriver(),
      host: row.host,
      port: String(row.port),
      database: row.database_name,
      username: row.username,
      password,
    });
    await runAllMigrations(client, installationDriver());
    await client.close();
    await db.run("UPDATE tenant_databases SET status = 'ready', last_error = NULL, updated_at = ? WHERE id = ?", [now(), row.id]);
    await audit(actorId, "database.migrated", row.tenant_id, row.database_name);
    return { ok: true, tenantId: row.tenant_id, siteId: "", hostname: "" };
  } catch (err) {
    const message = sanitizeDatabaseError(err, password);
    await db.run("UPDATE tenant_databases SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [message, now(), row.id]);
    return { ok: false, status: 502, error: "Migrations failed for that database. Other workspaces were not changed." };
  }
}

export async function insertInstallTenant(
  sql: Sql,
  input: { tenantId: string; siteName: string; stamp: string },
): Promise<void> {
  await sql.run(
    `INSERT INTO tenants (id, name, slug, status, user_mode, database_mode, created_at, updated_at)
     VALUES (?, ?, 'primary', 'active', 'isolated', 'current', ?, ?)`,
    [input.tenantId, input.siteName, input.stamp, input.stamp],
  );
}

export async function finishInstallTenancy(
  sql: Sql,
  input: { tenantId: string; siteId: string; siteUrl: string; userId: string; stamp: string },
): Promise<void> {
  const hostname = hostnameFromUrl(input.siteUrl) ?? "localhost";
  await sql.run(
    `INSERT INTO site_domains (id, site_id, hostname, kind, verified, is_primary, created_at)
     VALUES (?, ?, ?, 'primary', ?, ?, ?)`,
    [randomUUID(), input.siteId, hostname, true, true, input.stamp],
  );
  await sql.run(
    `INSERT INTO tenant_databases (id, tenant_id, site_id, mode, status, created_at, updated_at)
     VALUES (?, ?, NULL, 'current', 'ready', ?, ?)`,
    [randomUUID(), input.tenantId, input.stamp, input.stamp],
  );
  await sql.run("INSERT INTO platform_operators (user_id, created_at) VALUES (?, ?)", [input.userId, input.stamp]);
}

export async function runWithSiteDatabase<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const db = await getControlDb();
  const rows = await db.query<{ tenant_id: string; database_choice: string; database_mode: string }>(
    `SELECT s.tenant_id, s.database_choice, t.database_mode FROM sites s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ? LIMIT 1`,
    [siteId],
  );
  const row = rows[0];
  if (!row) return fn();
  const choice = row.database_choice === "current" || row.database_choice === "separate" ? row.database_choice : "inherit";
  const mode = row.database_mode === "separate" ? "separate" : "current";
  const { separateDatabaseForSite, borrowSeparateDatabase } = await import("./connections.js");
  const separate = await separateDatabaseForSite(row.tenant_id, siteId, choice, mode);
  if (!separate) return fn();
  const client = await borrowSeparateDatabase(separate);
  if (!client) return fn();
  return runWithDatabase(client, fn);
}

export async function createAdditionalSite(input: {
  tenantId: string;
  name: string;
  hostname: string;
  databaseChoice: DatabaseChoice;
  database?: DatabaseTarget;
  admin?: WorkspaceAdmin;
  actorId: string;
}): Promise<ProvisionResult> {
  const db = await getControlDb();
  const tenants = await db.query<{ id: string; user_mode: string; database_mode: string; status: string; name: string; slug: string }>(
    "SELECT id, user_mode, database_mode, status, name, slug FROM tenants WHERE id = ? LIMIT 1",
    [input.tenantId],
  );
  const tenant = tenants[0];
  if (!tenant || tenant.status === "deleted") return { ok: false, status: 404, error: "Workspace not found." };
  const userMode = tenant.user_mode === "shared" ? "shared" : "isolated";
  const tenantMode = tenant.database_mode === "separate" ? "separate" : "current";
  const choice = validateDatabaseChoice({
    userMode,
    tenantMode,
    siteChoice: input.databaseChoice,
    target: input.database,
  });
  if (!choice.ok) return { ok: false, status: 400, error: choice.error };
  const hostname = input.hostname.trim().toLowerCase();
  if (!isValidHostname(hostname)) return { ok: false, status: 400, error: "Hostname is not valid." };
  if (await hostnameTaken(hostname)) return { ok: false, status: 409, error: "That hostname is already in use." };
  if (userMode === "isolated" && !input.admin) {
    return { ok: false, status: 400, error: "An isolated site needs its own administrator account." };
  }
  if (choice.mode === "separate" && input.databaseChoice === "separate") {
    const problem = validateDatabaseTarget(input.database);
    if (problem) return { ok: false, status: 400, error: problem };
    if (!input.admin) return { ok: false, status: 400, error: "A separate database needs an administrator account." };
  }
  const blocked = await workspaceGate("site.beforeCreate", {
    tenantId: input.tenantId,
    name: input.name,
    hostname,
    databaseChoice: input.databaseChoice,
    userMode,
    databaseMode: choice.mode,
  });
  if (blocked) return { ok: false, status: 403, error: blocked };
  const { enforceQuota } = await import("./quotas.js");
  const quota = await enforceQuota("sites", input.tenantId, 1);
  if (quota) return { ok: false, status: quota.status, error: quota.error, code: quota.code, meter: quota.meter };

  const siteId = randomUUID();
  const stamp = now();
  const siteUrl = `https://${hostname}`;
  const domainKind = siteDomainKind(hostname, await platformBaseDomain());
  await db.run(
    `INSERT INTO sites (id, name, url, description, active, installed_at, created_at, updated_at, tenant_id, status, database_choice)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', ?)`,
    [siteId, input.name, siteUrl, true, stamp, stamp, stamp, input.tenantId, input.databaseChoice],
  );
  await db.run(
    `INSERT INTO site_domains (id, site_id, hostname, kind, verified, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), siteId, hostname, domainKind, true, true, stamp],
  );

  const dataMode = choice.mode;
  if (dataMode === "current") {
    if (userMode === "shared") await grantWorkspaceAdmins(db, input.tenantId, siteId, stamp);
    else if (input.admin) {
      await seedSiteContents(db, {
        tenantId: input.tenantId,
        siteId,
        siteName: input.name,
        hostname,
        userMode,
        databaseMode: "current",
        admin: input.admin,
        stamp,
      });
    }
    await runWithDatabase(db, () => ensureSiteTheme(siteId));
  } else if (input.databaseChoice === "separate" && input.database && input.admin) {
    const databaseId = randomUUID();
    await db.run(
      `INSERT INTO tenant_databases (id, tenant_id, site_id, mode, status, driver, host, port, database_name, username, password_ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, 'separate', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [databaseId, input.tenantId, siteId, installationDriver(), input.database.host, input.database.port, input.database.database, input.database.username, encryptSecret(input.database.password), stamp, stamp],
    );
    const opened = await openSeparateDatabase(input.database);
    if (!opened.ok) {
      await db.run("UPDATE sites SET status = 'provisioning', active = ? WHERE id = ?", [false, siteId]);
      await db.run("UPDATE tenant_databases SET status = 'failed', last_error = ? WHERE id = ?", [opened.error, databaseId]);
      return { ok: false, status: 502, error: "The separate database could not be prepared. Other sites were not changed." };
    }
    try {
      await runAllMigrations(opened.client, installationDriver());
      await seedSiteContents(opened.client, {
        tenantId: input.tenantId,
        siteId,
        siteName: input.name,
        hostname,
        userMode: "isolated",
        databaseMode: "separate",
        admin: input.admin,
        stamp,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
      });
      await runWithDatabase(opened.client, () => ensureSiteTheme(siteId));
      await opened.client.close();
      await db.run("UPDATE tenant_databases SET status = 'ready', last_error = NULL, updated_at = ? WHERE id = ?", [stamp, databaseId]);
    } catch (err) {
      await opened.client.close();
      await db.run("UPDATE sites SET status = 'provisioning', active = ? WHERE id = ?", [false, siteId]);
      await db.run("UPDATE tenant_databases SET status = 'failed', last_error = ? WHERE id = ?", [
        sanitizeDatabaseError(err, input.database.password),
        databaseId,
      ]);
      return { ok: false, status: 502, error: "The separate database could not be migrated. Other sites were not changed." };
    }
  } else {
    await runWithSiteDatabase(siteId, async () => {
      const { getDb } = await import("../database/db.js");
      const data = await getDb();
      await data.run(
        `INSERT INTO sites (id, name, url, description, active, installed_at, created_at, updated_at, tenant_id, status, database_choice)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', 'inherit')`,
        [siteId, input.name, siteUrl, true, stamp, stamp, stamp, input.tenantId],
      );
      await data.run(
        `INSERT INTO site_domains (id, site_id, hostname, kind, verified, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), siteId, hostname, domainKind, true, true, stamp],
      );
      if (userMode === "shared") await grantWorkspaceAdmins(data, input.tenantId, siteId, stamp);
      else if (input.admin) {
        await seedSiteContents(data, {
          tenantId: input.tenantId,
          siteId,
          siteName: input.name,
          hostname,
          userMode,
          databaseMode: "current",
          admin: input.admin,
          stamp,
        });
      }
      await ensureSiteTheme(siteId);
    });
  }
  await copyQuotaDefaults("site", siteId);
  await audit(input.actorId, "site.created", siteId, `database=${input.databaseChoice}`);
  await workspaceAction("site.created", {
    tenantId: input.tenantId,
    siteId,
    hostname,
    databaseChoice: input.databaseChoice,
  });
  return { ok: true, tenantId: input.tenantId, siteId, hostname };
}

async function ensureSiteTheme(siteId: string): Promise<void> {
  const { ensureDefaultTheme } = await import("../themes/themes-db.js");
  await ensureDefaultTheme(siteId);
}

async function grantWorkspaceAdmins(db: Sql, tenantId: string, siteId: string, stamp: string): Promise<void> {
  const admins = await db.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN sites s ON s.id = u.site_id
     WHERE s.tenant_id = ? AND u.role = 'administrator'`,
    [tenantId],
  );
  for (const admin of admins) {
    await db.run(
      "INSERT INTO site_memberships (id, user_id, site_id, role, created_at) VALUES (?, ?, ?, 'administrator', ?)",
      [randomUUID(), admin.id, siteId, stamp],
    );
  }
}
