// SPDX-License-Identifier: MIT

import { accountSections } from "../../lib/account/sections.js";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { optionalSession, requireSession, requireInstallationRoot } from "../../middleware/auth.js";
import { isInstallationRootRequest } from "../../lib/tenancy/access.js";
import { ownedWorkspace, ownerAccount } from "../../lib/tenancy/platform-account.js";
import { getControlDb, getDb } from "../../lib/database/db.js";
import { withSiteUsers } from "../../lib/tenancy/site-users.js";
import { createAdditionalSite } from "../../lib/tenancy/provision.js";
import { platformBaseDomain } from "../../lib/tenancy/saas-settings.js";
import { signupBaseDomain } from "../../lib/tenancy/host.js";
import { listQuotaMeters } from "../../lib/tenancy/quotas.js";
import { auditLog } from "../../lib/security/audit-log.js";

export const pageRouter = Router();
export const apiRouter = Router();
const reads = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
const writes = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
function privateResponse(_req: unknown, res: import("express").Response, next: import("express").NextFunction) {
  res.set({ "Cache-Control": "private, no-store", "CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  next();
}
pageRouter.use(privateResponse);
pageRouter.get("/", reads, optionalSession, async (req, res) => {
  if (!req.session) { res.redirect("/login"); return; }
  const { ensureBuiltinContentTypes } = await import("../../lib/content/content-types-db.js");
  const { accountPages } = await import("../../lib/account/pages.js");
  const { serveAccountContent } = await import("./account-pages.js");
  await ensureBuiltinContentTypes(req.session.siteId);
  const pages = await accountPages(req.session.siteId);
  const page = pages.find(page => page.content.status === "published");
  if (!page) { res.status(404).send("No published account page."); return; }
  const requested = req.originalUrl.split("?")[0]!.replace(/\/$/, "");
  if (requested !== page.url.replace(/\/$/, "")) { res.redirect(302, page.url); return; }
  await serveAccountContent(req, res, page.content, page.url);
});
apiRouter.use(privateResponse, reads, requireSession);
apiRouter.use("/workspaces", requireInstallationRoot);
apiRouter.get("/workspaces", async (req, res) => {
  const [workspaces, siteDomain] = await Promise.all([
    ownerAccount(req.session!.userId), platformBaseDomain().then(signupBaseDomain),
  ]);
  res.json({ workspaces, siteDomain });
});
apiRouter.get("/", async (req, res) => {
  const session = req.session!;
  const installationRoot = isInstallationRootRequest();
  const [workspaces, siteDomain, sections] = await Promise.all([
    installationRoot ? ownerAccount(session.userId) : Promise.resolve([]),
    installationRoot ? platformBaseDomain().then(signupBaseDomain) : Promise.resolve(null),
    accountSections({ siteId: session.siteId, userId: session.userId, email: session.email, role: session.role, installationRoot }),
  ]);
  res.json({ workspaces, siteDomain, sections });
});
apiRouter.get("/workspaces/:id/limits", async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success || !await ownedWorkspace(req.session!.userId, id.data)) { res.status(404).json({ error: "Workspace not found." }); return; }
  res.json({ meters: await listQuotaMeters("workspace", id.data) });
});
apiRouter.get("/workspaces/:id/sites/:siteId/limits", async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const siteId = z.string().uuid().safeParse(req.params.siteId);
  if (!id.success || !siteId.success || !await ownedWorkspace(req.session!.userId, id.data)) { res.status(404).json({ error: "Site not found." }); return; }
  const db = await getControlDb();
  const sites = await db.query("SELECT id FROM sites WHERE id = ? AND tenant_id = ? AND status <> 'deleted'", [siteId.data, id.data]);
  if (!sites.length) { res.status(404).json({ error: "Site not found." }); return; }
  res.json({ meters: await listQuotaMeters("site", siteId.data) });
});
apiRouter.patch("/workspaces/:id", writes, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({ name: z.string().trim().min(1).max(255) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Enter a workspace name." }); return; }
  const workspace = id.success ? await ownedWorkspace(req.session!.userId, id.data) : null;
  if (!workspace) { res.status(404).json({ error: "Workspace not found." }); return; }
  if (!["active", "suspended"].includes(workspace.status)) { res.status(409).json({ error: "This workspace cannot be edited yet." }); return; }
  const db = await getControlDb();
  await db.run("UPDATE tenants SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ?", [body.data.name, workspace.id, req.session!.userId]);
  await auditLog({ siteId: req.session!.siteId, actorId: req.session!.userId, actorEmail: req.session!.email, actorRole: req.session!.role, action: "workspace.owner_updated", target: workspace.id });
  res.json({ ok: true });
});
apiRouter.patch("/workspaces/:id/sites/:siteId", writes, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const siteId = z.string().uuid().safeParse(req.params.siteId);
  const body = z.object({ name: z.string().trim().min(1).max(255) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Enter a site name." }); return; }
  if (!id.success || !siteId.success || !await ownedWorkspace(req.session!.userId, id.data)) { res.status(404).json({ error: "Site not found." }); return; }
  const db = await getControlDb();
  const changed = await db.execute(`UPDATE sites SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ? AND status <> 'deleted'
    AND tenant_id IN (SELECT id FROM tenants WHERE owner_user_id = ? AND status <> 'deleted')`, [body.data.name, siteId.data, id.data, req.session!.userId]);
  if (!changed) {
    const unchanged = await db.query(`SELECT s.id FROM sites s JOIN tenants t ON t.id = s.tenant_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.status <> 'deleted' AND t.owner_user_id = ? AND t.status <> 'deleted'`, [siteId.data, id.data, req.session!.userId]);
    if (!unchanged.length) { res.status(404).json({ error: "Site not found." }); return; }
  }
  try {
    const synced = await withSiteUsers(siteId.data, async (scope) => {
      if (scope.separateDatabase) {
        await (await getDb()).run("UPDATE sites SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [body.data.name, siteId.data]);
      }
    });
    if (!synced.ok) { res.status(502).json({ error: "The name was saved here, but the site's database could not be updated. Try saving again." }); return; }
  } catch { res.status(502).json({ error: "The name was saved here, but the site's database could not be updated. Try saving again." }); return; }
  await auditLog({ siteId: req.session!.siteId, actorId: req.session!.userId, actorEmail: req.session!.email, actorRole: req.session!.role, action: "site.owner_updated", target: siteId.data });
  res.json({ ok: true });
});
apiRouter.post("/workspaces/:id/sites", writes, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const body = z.object({ name: z.string().trim().min(1).max(255), address: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/), password: z.string().min(12).max(256) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Enter a site name, an address of 3–40 lowercase letters, numbers or dashes, and a password of at least 12 characters." }); return; }
  const workspace = id.success ? await ownedWorkspace(req.session!.userId, id.data) : null;
  if (!workspace) { res.status(404).json({ error: "Workspace not found." }); return; }
  if (workspace.status !== "active") { res.status(409).json({ error: "Only an active workspace can create sites." }); return; }
  const domain = signupBaseDomain(await platformBaseDomain());
  if (!domain) { res.status(409).json({ error: "The platform has not configured a domain for new sites." }); return; }
  const result = await createAdditionalSite({ tenantId: workspace.id, name: body.data.name, hostname: `${body.data.address}.${domain}`, databaseChoice: "inherit", actorId: req.session!.userId,
    admin: { email: req.session!.email, username: body.data.address.replace(/-/g, "").slice(0, 30), displayName: req.session!.email.split("@")[0]!, password: body.data.password } });
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.status(201).json({ ok: true });
});
