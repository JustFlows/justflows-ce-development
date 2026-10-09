// SPDX-License-Identifier: MIT

import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getControlDb } from "../../lib/database/db.js";
import { requireSession } from "../../middleware/auth.js";
import { isPlatformOperator } from "../../lib/tenancy/access.js";
import { signupBaseDomain } from "../../lib/tenancy/host.js";
import { buildSaasSettings, readSaasSettings, readSignupDatabaseTarget, withPurgeAfterDays } from "../../lib/tenancy/saas-settings.js";
import { purgeDeletedTenant } from "../../lib/tenancy/purge-deleted.js";
import {
  createAdditionalSite,
  createWorkspace,
  deleteTenant,
  migrateTenantDatabase,
  probeSeparateDatabase,
  reactivateTenant,
  suspendTenant,
} from "../../lib/tenancy/provision.js";
import { loadPlatformSite, updatePlatformSite, type SiteEditInput } from "../../lib/tenancy/site-record.js";
import { loadPlatformWorkspace, updatePlatformWorkspace } from "../../lib/tenancy/workspace-record.js";
import {
  createSiteUser,
  deleteSiteUser,
  getSiteUser,
  listSiteUsers,
  resetSiteUserPassword,
  updateSiteUser,
  type PlatformOperator,
} from "../../lib/tenancy/site-users.js";
import { CreateUserSchema } from "../../lib/auth/users-admin.js";
import { STORED_ROLE_ID } from "../../lib/auth/rbac.js";
import { PasswordSchema } from "../../lib/auth/password-policy.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { decryptSecret } from "../../lib/security/secret-box.js";

const router = Router();

const DatabaseSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().min(1).max(64),
  username: z.string().min(1).max(255),
  password: z.string().max(1024),
});

async function requireOperator(req: { session?: { userId: string } }, res: { status(code: number): { json(body: unknown): void } }, next: () => void): Promise<void> {
  if (!req.session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!(await isPlatformOperator(req.session.userId))) {
    res.status(403).json({ error: "Platform operator access is required" });
    return;
  }
  next();
}

router.use(requireSession, (req, res, next) => {
  void requireOperator(req, res, next).catch(next);
});

router.get("/overview", async (_req, res) => {
  const db = await getControlDb();
  const tenants = await db.query(
    `SELECT t.id, t.name, t.slug, t.status, t.user_mode, t.database_mode, t.created_at
     FROM tenants t
     ORDER BY t.created_at ASC`,
  );
  const sites = await db.query(
    `SELECT s.id, s.tenant_id, s.name, s.url, s.status, s.database_choice, d.hostname
     FROM sites s
     LEFT JOIN site_domains d ON d.site_id = s.id AND d.is_primary = ?
     ORDER BY s.created_at ASC`,
    [true],
  );
  const databases = await db.query(
    `SELECT id, tenant_id, site_id, mode, status, driver, host, port, database_name, username, last_error, updated_at,
            CASE WHEN password_ciphertext IS NULL OR password_ciphertext = '' THEN ? ELSE ? END AS password_set
     FROM tenant_databases
     ORDER BY created_at ASC`,
    [false, true],
  );
  const settings = await db.query<{ value: unknown }>("SELECT value FROM platform_settings WHERE setting_key = 'saas' LIMIT 1");
  res.json({
    tenants,
    sites,
    databases,
    settings: readSaasSettings(settings[0]?.value),
    installationPort: installationDatabasePort(),
  });
});

function installationDatabasePort(): number {
  const configured = Number(process.env.DB_PORT);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 65535) return configured;
  return process.env.DB_DRIVER === "postgres" ? 5432 : 3306;
}

const CreateTenant = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().max(60).optional(),
  userMode: z.enum(["isolated", "shared"]),
  databaseMode: z.enum(["current", "separate"]),
  siteName: z.string().min(1).max(255),
  hostname: z.string().min(1).max(253),
  admin: z.object({
    email: z.string().email(),
    username: z.string().min(2).max(60),
    displayName: z.string().min(1).max(255),
    password: z.string().min(12).max(1024),
  }),
  database: DatabaseSchema.optional(),
});

router.get("/sites/:id/storage", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
  const site = await loadPlatformSite(String(req.params.id));
  if (!site) { res.status(404).json({ error: "That website was not found." }); return; }
  res.json((await import("../../lib/storage/storage-snapshots.js")).storageSnapshot(String(req.params.id)));
});

router.get("/sites/:id", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
  const site = await loadPlatformSite(String(req.params.id));
  if (!site) {
    res.status(404).json({ error: "That website was not found." });
    return;
  }
  const { listQuotaMeters } = await import("../../lib/tenancy/quotas.js");
  const storage = (await import("../../lib/storage/storage-snapshots.js")).storageSnapshot(String(req.params.id)).report;
  res.json({ ...site, storage, quotas: { meters: await listQuotaMeters("site", String(req.params.id)) } });
});

const SiteDomainEdit = z.object({
  id: z.string().uuid().nullable(),
  hostname: z.string().min(1).max(253),
  kind: z.enum(["primary", "subdomain", "custom"]),
  verified: z.boolean(),
  isPrimary: z.boolean(),
});

const SiteEdit = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(10000),
  url: z.string().min(1).max(2048),
  status: z.enum(["active", "suspended"]),
  databaseChoice: z.enum(["inherit", "current", "separate"]),
  domains: z.array(SiteDomainEdit).min(1).max(20),
  database: z
    .object({
      host: z.string().max(255),
      port: z.coerce.number().int(),
      database: z.string().max(64),
      username: z.string().max(255),
      password: z.string().max(1024),
    })
    .nullable(),
});

router.put("/sites/:id", async (req, res) => {
  const body = SiteEdit.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid website" });
    return;
  }
  const result = await updatePlatformSite(String(req.params.id), body.data as SiteEditInput, req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? result.site : { error: result.error });
});

function operatorOf(req: Request): PlatformOperator {
  return { userId: req.session!.userId, ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

function send(res: Response, outcome: { status: number; body: unknown }): void {
  res.status(outcome.status).json(outcome.body);
}

const SiteUserPatchSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  role: z.string().regex(STORED_ROLE_ID).optional(),
});

const SiteUserPasswordSchema = z.object({ newPassword: PasswordSchema });

router.get("/sites/:id/users", async (req, res) => {
  try {
    send(res, await listSiteUsers(String(req.params.id)));
  } catch (err) {
    sendServerError(res, "platform site users", err);
  }
});

router.post("/sites/:id/users", async (req, res) => {
  const body = CreateUserSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid user" });
    return;
  }
  try {
    send(res, await createSiteUser(String(req.params.id), body.data, operatorOf(req)));
  } catch (err) {
    sendServerError(res, "platform site users", err);
  }
});

router.get("/sites/:id/users/:userId", async (req, res) => {
  try {
    send(res, await getSiteUser(String(req.params.id), String(req.params.userId)));
  } catch (err) {
    sendServerError(res, "platform site users", err);
  }
});

router.patch("/sites/:id/users/:userId", async (req, res) => {
  const body = SiteUserPatchSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid user" });
    return;
  }
  try {
    send(res, await updateSiteUser(String(req.params.id), String(req.params.userId), body.data, operatorOf(req)));
  } catch (err) {
    sendServerError(res, "platform site users", err);
  }
});

router.post("/sites/:id/users/:userId/password", async (req, res) => {
  const body = SiteUserPasswordSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid password" });
    return;
  }
  try {
    send(res, await resetSiteUserPassword(String(req.params.id), String(req.params.userId), body.data.newPassword, operatorOf(req)));
  } catch (err) {
    sendServerError(res, "platform site users", err);
  }
});

router.delete("/sites/:id/users/:userId", async (req, res) => {
  try {
    send(res, await deleteSiteUser(String(req.params.id), String(req.params.userId), operatorOf(req)));
  } catch (err) {
    sendServerError(res, "platform site users", err);
  }
});

router.post("/tenants", async (req, res) => {
  const body = CreateTenant.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid workspace" });
    return;
  }
  const result = await createWorkspace({ ...body.data, actorId: req.session!.userId, platformOperator: false });
  res.status(result.ok ? 201 : result.status).json(result.ok ? result : { error: result.error });
});

const CreateSite = z.object({
  name: z.string().min(1).max(255),
  hostname: z.string().min(1).max(253),
  databaseChoice: z.enum(["inherit", "current", "separate"]),
  database: DatabaseSchema.optional(),
  admin: CreateTenant.shape.admin.optional(),
});

router.get("/tenants/:id", async (req, res) => {
  const workspace = await loadPlatformWorkspace(String(req.params.id));
  if (!workspace) {
    res.status(404).json({ error: "That workspace was not found." });
    return;
  }
  const { listQuotaMeters } = await import("../../lib/tenancy/quotas.js");
  res.json({ ...workspace, quotas: { meters: await listQuotaMeters("workspace", String(req.params.id)) } });
});

const WorkspaceEdit = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(60),
});

router.put("/tenants/:id", async (req, res) => {
  const body = WorkspaceEdit.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid workspace" });
    return;
  }
  const result = await updatePlatformWorkspace(String(req.params.id), body.data, req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? result.workspace : { error: result.error });
});

function quotaFailure(result: { error: string; code?: string; meter?: string }): { error: string; code?: string; meter?: string } {
  return { error: result.error, ...(result.code ? { code: result.code, meter: result.meter } : {}) };
}

const QuotaLimitsSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,118}$/),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
);

router.put("/sites/:id/quotas", async (req, res) => {
  const body = z.object({ limits: QuotaLimitsSchema }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid limits" });
    return;
  }
  const { replaceQuotaLimits } = await import("../../lib/tenancy/quotas.js");
  const result = await replaceQuotaLimits("site", String(req.params.id), body.data.limits, req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? { quotas: { meters: result.meters } } : { error: result.error });
});

router.put("/tenants/:id/quotas", async (req, res) => {
  const body = z.object({ limits: QuotaLimitsSchema }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid limits" });
    return;
  }
  const { replaceQuotaLimits } = await import("../../lib/tenancy/quotas.js");
  const result = await replaceQuotaLimits("workspace", String(req.params.id), body.data.limits, req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? { quotas: { meters: result.meters } } : { error: result.error });
});

router.get("/quota-defaults", async (_req, res) => {
  const { listQuotaDefaultMeters } = await import("../../lib/tenancy/quotas.js");
  res.json({
    workspace: { meters: await listQuotaDefaultMeters("workspace") },
    site: { meters: await listQuotaDefaultMeters("site") },
  });
});

router.put("/quota-defaults/:scope", async (req, res) => {
  const scope = req.params.scope === "workspace" || req.params.scope === "site" ? req.params.scope : null;
  if (!scope) {
    res.status(400).json({ error: "Choose workspace or site." });
    return;
  }
  const body = z.object({ limits: QuotaLimitsSchema }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid limits" });
    return;
  }
  const { replaceQuotaDefaults } = await import("../../lib/tenancy/quotas.js");
  const result = await replaceQuotaDefaults(scope, body.data.limits, req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? { quotas: { meters: result.meters } } : { error: result.error });
});

router.post("/tenants/:id/sites", async (req, res) => {
  const body = CreateSite.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid site" });
    return;
  }
  const result = await createAdditionalSite({
    tenantId: String(req.params.id),
    ...body.data,
    actorId: req.session!.userId,
  });
  res.status(result.ok ? 201 : result.status).json(result.ok ? result : quotaFailure(result));
});

router.post("/tenants/:id/suspend", async (req, res) => {
  const result = await suspendTenant(String(req.params.id), req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? { ok: true } : { error: result.error });
});

router.post("/tenants/:id/reactivate", async (req, res) => {
  const result = await reactivateTenant(String(req.params.id), req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? { ok: true } : { error: result.error });
});

router.post("/tenants/:id/purge", async (req, res) => {
  try {
    const result = await purgeDeletedTenant(String(req.params.id), req.session!.userId);
    res.status(result.ok ? 200 : result.status).json(result.ok ? { ok: true } : { error: result.error });
  } catch (err) {
    console.error("[justflows] Permanent delete failed:", err);
    res.status(502).json({ error: "The website could not be removed." });
  }
});

router.delete("/tenants/:id", async (req, res) => {
  const dropDatabase = req.body?.dropDatabase === true;
  const result = await deleteTenant(String(req.params.id), req.session!.userId, dropDatabase);
  res.status(result.ok ? 200 : result.status).json(result.ok ? { ok: true } : { error: result.error });
});

router.post("/databases/:id/migrate", async (req, res) => {
  const result = await migrateTenantDatabase(String(req.params.id), req.session!.userId);
  res.status(result.ok ? 200 : result.status).json(result.ok ? { ok: true } : { error: result.error });
});

router.post("/databases/:id/reveal", async (req, res) => {
  const db = await getControlDb();
  const rows = await db.query<{ password_ciphertext: string | null; tenant_id: string; database_name: string | null }>(
    "SELECT password_ciphertext, tenant_id, database_name FROM tenant_databases WHERE id = ? LIMIT 1",
    [String(req.params.id)],
  );
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Database not found" });
    return;
  }
  await db.run(
    "INSERT INTO platform_audit (id, actor_id, action, target, detail, created_at) VALUES (?, ?, 'database.reveal', ?, ?, ?)",
    [randomUUID(), req.session!.userId, row.tenant_id, row.database_name, new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "")],
  );
  res.json({ password: decryptSecret(row.password_ciphertext ?? "") });
});

const SettingsSchema = z.object({
  signupEnabled: z.boolean(),
  signupDatabaseMode: z.enum(["current", "separate"]).optional(),
  baseDomain: z.string().max(253),
  database: DatabaseSchema.optional(),
});

router.put("/settings", async (req, res) => {
  const body = SettingsSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid settings" });
    return;
  }
  const baseDomain = signupBaseDomain(body.data.baseDomain);
  if (baseDomain === null || (body.data.signupEnabled && !baseDomain)) {
    res.status(400).json({ error: "Signup domain must be a hostname such as example.com or localhost." });
    return;
  }
  const db = await getControlDb();
  const driver = process.env.DB_DRIVER;
  const existing = await db.query<{ value: unknown }>("SELECT value FROM platform_settings WHERE setting_key = 'saas' LIMIT 1");
  const built = buildSaasSettings(existing[0]?.value, {
    signupEnabled: body.data.signupEnabled,
    signupDatabaseMode: body.data.signupDatabaseMode ?? "current",
    baseDomain,
    database: body.data.database,
  });
  if (!built.ok) {
    res.status(400).json({ error: built.error });
    return;
  }
  const settings = built.stored;
  await storeSaasSettings(db, driver, settings);
  await copySignupDatabaseOntoWorkspaces(db, existing[0]?.value, settings);
  res.json({ ok: true, settings: readSaasSettings(settings) });
});

const testDatabaseLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

router.post("/settings/test-database", testDatabaseLimit, async (req, res) => {
  const body = DatabaseSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid connection" });
    return;
  }
  let password = body.data.password;
  if (!password) {
    const db = await getControlDb();
    const existing = await db.query<{ value: unknown }>("SELECT value FROM platform_settings WHERE setting_key = 'saas' LIMIT 1");
    password = readSignupDatabaseTarget(existing[0]?.value)?.password ?? "";
  }
  if (!password) {
    res.status(400).json({ error: "Database password is required." });
    return;
  }
  const result = await probeSeparateDatabase({ ...body.data, password });
  if (!result.ok) {
    res.status(502).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/** Workspace rows keep a copy of the signup connection. A later edit of that connection updates those copies. */
async function copySignupDatabaseOntoWorkspaces(
  db: Awaited<ReturnType<typeof getControlDb>>,
  previous: unknown,
  settings: { signupDatabaseMode: "current" | "separate"; signupDatabase?: { host: string; port: number; database: string; username: string; passwordCiphertext: string } },
): Promise<void> {
  const prior = readSaasSettings(previous)?.signupDatabase;
  const next = settings.signupDatabase;
  if (settings.signupDatabaseMode !== "separate" || !prior || !next) return;
  const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  await db.run(
    `UPDATE tenant_databases
     SET host = ?, port = ?, database_name = ?, username = ?, password_ciphertext = ?, last_error = NULL, updated_at = ?
     WHERE mode = 'separate' AND host = ? AND database_name = ? AND username = ?`,
    [next.host, next.port, next.database, next.username, next.passwordCiphertext, stamp, prior.host, prior.database, prior.username],
  );
}

router.put("/settings/purge", async (req, res) => {
  const body = z.object({ purgeAfterDays: z.number().int().min(0).max(3650) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter a number of days from 0 to 3650." });
    return;
  }
  const db = await getControlDb();
  const existing = await db.query<{ value: unknown }>("SELECT value FROM platform_settings WHERE setting_key = 'saas' LIMIT 1");
  const settings = withPurgeAfterDays(existing[0]?.value, body.data.purgeAfterDays);
  await storeSaasSettings(db, process.env.DB_DRIVER, settings);
  res.json({ ok: true, settings: readSaasSettings(settings) });
});

async function storeSaasSettings(db: Awaited<ReturnType<typeof getControlDb>>, driver: string | undefined, settings: object): Promise<void> {
  const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  if (driver === "postgres") {
    // Pass the object. A JSON string bound to ::jsonb is stored as a JSON
    // string, and the platform page reloads with an empty form.
    await db.run(
      `INSERT INTO platform_settings (setting_key, value, updated_at) VALUES ('saas', ?::jsonb, ?)
       ON CONFLICT (setting_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [settings as unknown as string, stamp],
    );
  } else {
    const value = JSON.stringify(settings);
    await db.run(
      `INSERT INTO platform_settings (setting_key, value, updated_at) VALUES ('saas', ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [value, stamp],
    );
  }
}

export default router;
