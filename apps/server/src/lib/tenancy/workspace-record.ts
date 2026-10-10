// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { getControlDb } from "../database/db.js";
import { borrowSeparateDatabase, type SeparateDatabaseRow } from "./connections.js";

export interface WorkspaceEditInput {
  name: string;
  slug: string;
}

export interface WorkspaceEditContext {
  currentStatus: string;
  currentSlug: string;
  takenSlugs: ReadonlySet<string>;
}

export interface PlatformWorkspaceView {
  workspace: {
    id: string;
    name: string;
    slug: string;
    status: string;
    userMode: string;
    databaseMode: string;
    createdAt: string;
    updatedAt: string;
    owner: { id: string; name: string; email: string } | null;
  };
  sites: Array<{
    id: string;
    name: string;
    url: string;
    hostname: string | null;
    status: string;
    databaseChoice: string;
  }>;
  database: {
    id: string;
    status: string;
    driver: string | null;
    host: string;
    port: number | null;
    databaseName: string;
    username: string;
    lastError: string | null;
  } | null;
}

type WorkspaceResult = { ok: true; workspace: PlatformWorkspaceView } | { ok: false; status: number; error: string };

const PRIMARY_SLUG = "primary";

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export function validateWorkspaceEdit(
  input: WorkspaceEditInput,
  context: WorkspaceEditContext,
): { ok: true; value: WorkspaceEditInput } | { ok: false; error: string } {
  if (context.currentStatus !== "active" && context.currentStatus !== "suspended") {
    return { ok: false, error: "This workspace cannot be edited while it is provisioning or deleted." };
  }
  const name = input.name.trim();
  if (!name || name.length > 255) return { ok: false, error: "Workspace name is not valid." };
  const slug = input.slug.trim().toLowerCase();
  if (context.currentSlug === PRIMARY_SLUG && slug !== PRIMARY_SLUG) {
    return { ok: false, error: "The platform workspace keeps the slug primary." };
  }
  if (slug !== context.currentSlug && slug === PRIMARY_SLUG) {
    return { ok: false, error: "That slug is reserved." };
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) {
    return { ok: false, error: "Slug can only use lowercase letters, numbers, and dashes." };
  }
  if (context.takenSlugs.has(slug)) return { ok: false, error: "That slug is already in use." };
  return { ok: true, value: { name, slug } };
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  user_mode: string;
  database_mode: string;
  created_at: string;
  updated_at: string;
  owner_user_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
}

interface SiteRow {
  id: string;
  name: string;
  url: string;
  hostname: string | null;
  status: string;
  database_choice: string;
}

interface DatabaseRow {
  id: string;
  status: string;
  driver: string | null;
  host: string | null;
  port: number | null;
  database_name: string | null;
  username: string | null;
  last_error: string | null;
}

export async function loadPlatformWorkspace(tenantId: string): Promise<PlatformWorkspaceView | null> {
  const db = await getControlDb();
  const rows = await db.query<WorkspaceRow>(
    `SELECT t.id, t.name, t.slug, t.status, t.user_mode, t.database_mode, t.created_at, t.updated_at,
            u.id AS owner_user_id, u.display_name AS owner_name, u.email AS owner_email
     FROM tenants t
     LEFT JOIN users u ON u.id = t.owner_user_id
     WHERE t.id = ?
     LIMIT 1`,
    [tenantId],
  );
  const tenant = rows[0];
  if (!tenant) return null;
  const sites = await db.query<SiteRow>(
    `SELECT s.id, s.name, s.url, s.status, s.database_choice, d.hostname
     FROM sites s
     LEFT JOIN site_domains d ON d.site_id = s.id AND d.is_primary = ?
     WHERE s.tenant_id = ?
     ORDER BY s.created_at ASC`,
    [true, tenantId],
  );
  const databases = await db.query<DatabaseRow>(
    `SELECT id, status, driver, host, port, database_name, username, last_error
     FROM tenant_databases
     WHERE tenant_id = ? AND site_id IS NULL
     LIMIT 1`,
    [tenantId],
  );
  const database = databases[0];
  return {
    workspace: {
      id: String(tenant.id),
      name: String(tenant.name),
      slug: String(tenant.slug),
      status: String(tenant.status),
      userMode: String(tenant.user_mode),
      databaseMode: String(tenant.database_mode),
      createdAt: String(tenant.created_at),
      updatedAt: String(tenant.updated_at),
      owner: tenant.owner_user_id ? {
        id: String(tenant.owner_user_id),
        name: String(tenant.owner_name || tenant.owner_email || tenant.owner_user_id),
        email: String(tenant.owner_email || ""),
      } : null,
    },
    sites: sites.map((site) => ({
      id: String(site.id),
      name: String(site.name),
      url: String(site.url),
      hostname: site.hostname ? String(site.hostname) : null,
      status: String(site.status),
      databaseChoice: String(site.database_choice),
    })),
    database: database
      ? {
          id: String(database.id),
          status: String(database.status),
          driver: database.driver ? String(database.driver) : null,
          host: database.host ? String(database.host) : "",
          port: database.port == null ? null : Number(database.port),
          databaseName: database.database_name ? String(database.database_name) : "",
          username: database.username ? String(database.username) : "",
          lastError: database.last_error ? String(database.last_error) : null,
        }
      : null,
  };
}

export async function updatePlatformWorkspace(tenantId: string, input: WorkspaceEditInput, actorId: string | null): Promise<WorkspaceResult> {
  const current = await loadPlatformWorkspace(tenantId);
  if (!current) return { ok: false, status: 404, error: "That workspace was not found." };
  const db = await getControlDb();
  const taken = await db.query<{ slug: string }>("SELECT slug FROM tenants WHERE id <> ?", [tenantId]);
  const checked = validateWorkspaceEdit(input, {
    currentStatus: current.workspace.status,
    currentSlug: current.workspace.slug,
    takenSlugs: new Set(taken.map((row) => String(row.slug))),
  });
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const { name, slug } = checked.value;

  const stamp = now();
  try {
    await db.run("UPDATE tenants SET name = ?, slug = ?, updated_at = ? WHERE id = ?", [name, slug, stamp, tenantId]);
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
    const message = err instanceof Error ? err.message : "";
    if (code === "23505" || code === "ER_DUP_ENTRY" || /duplicate|unique/i.test(message)) {
      return { ok: false, status: 409, error: "That slug is already in use." };
    }
    console.error("[justflows] workspace update failed:", JSON.stringify(code.replace(/[\r\n]/g, "") || "failed"));
    return { ok: false, status: 500, error: "The workspace could not be saved." };
  }

  // Separate databases keep their own copy of the tenant row.
  const separate = await db.query<SeparateDatabaseRow>(
    `SELECT id, tenant_id, site_id, mode, status, driver, host, port, database_name, username,
            password_ciphertext, updated_at
     FROM tenant_databases
     WHERE tenant_id = ? AND status = 'ready' AND mode = 'separate'`,
    [tenantId],
  );
  let mirrorFailed = false;
  for (const row of separate) {
    try {
      const client = await borrowSeparateDatabase(row);
      if (!client) {
        mirrorFailed = true;
        continue;
      }
      await client.run("UPDATE tenants SET name = ?, slug = ?, updated_at = ? WHERE id = ?", [name, slug, stamp, tenantId]);
    } catch {
      mirrorFailed = true;
    }
  }

  const uuid = actorId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId) ? actorId : null;
  await db.run(
    "INSERT INTO platform_audit (id, actor_id, action, target, detail, created_at) VALUES (?, ?, 'tenant.updated', ?, ?, ?)",
    [randomUUID(), uuid, tenantId, `${name} · ${slug}`.slice(0, 500), stamp],
  );

  if (mirrorFailed) {
    console.error("[justflows] workspace database mirror failed");
    return { ok: false, status: 502, error: "The workspace was saved here, but its database could not be updated. Save again when that database is reachable." };
  }
  const saved = await loadPlatformWorkspace(tenantId);
  if (!saved) return { ok: false, status: 404, error: "That workspace was not found." };
  return { ok: true, workspace: saved };
}
