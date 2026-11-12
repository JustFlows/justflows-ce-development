// SPDX-License-Identifier: MIT

import { getControlDb } from "../database/db.js";
import { sendTemplateMail } from "../email/mail.js";
import { auditLog } from "../security/audit-log.js";
import { ownerAccount } from "./platform-account.js";
import { withSiteUsers } from "./site-users.js";

/** An owner with more sites than this gets the first ones. */
const MAX_LISTED_SITES = 100;

export interface FindSitesContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * The site's admin sign-in page under its own admin path, which may be a custom one.
 * Null when the path cannot be read, so no wrong address is mailed.
 */
export async function adminSignInUrl(siteId: string, origin: string): Promise<string | null> {
  try {
    const { getAdminPathConfig } = await import("../admin/admin-path.js");
    const result = await withSiteUsers(siteId, async () => (await getAdminPathConfig()).path);
    return result.ok ? `${origin}${result.value}/login` : null;
  } catch {
    return null;
  }
}

/**
 * Mail an owner the sites of every workspace they own on the installation.
 *
 * Each site is listed with its own address (its primary domain, custom or not) and
 * its admin sign-in address under that site's admin path. The installation's own
 * address is never part of the mail. Resolves without disclosing whether `email`
 * belongs to an owner, so the route can answer the same way for every address.
 * Nothing is mailed when the address owns no live site.
 */
export async function processFindSites(email: string, ctx: FindSitesContext): Promise<void> {
  const normalized = email.trim().toLowerCase();
  try {
    const db = await getControlDb();
    const roots = await db.query<{ id: string }>(
      "SELECT id FROM sites WHERE status <> 'deleted' ORDER BY created_at ASC, id ASC LIMIT 1",
    );
    const root = roots[0];
    if (!root) return;
    const rows = await db.query<{ id: string; email: string; display_name: string; site_id: string }>(
      "SELECT id, email, display_name, site_id FROM users WHERE site_id = ? AND email = ? LIMIT 1",
      [root.id, normalized],
    );
    const user = rows[0];
    if (!user) return;

    const sites = (await ownerAccount(user.id))
      .flatMap((workspace) => workspace.sites)
      .filter((site): site is typeof site & { url: string } => site.url !== null)
      .slice(0, MAX_LISTED_SITES);
    if (sites.length === 0) return;

    const entries: string[] = [];
    for (const site of sites) {
      const name = site.name.replace(/[\r\n]+/g, " ").trim() || site.url;
      const admin = await adminSignInUrl(site.id, site.url);
      entries.push([
        `${name}${site.status === "active" ? "" : ` (${site.status})`}`,
        `Site: ${site.url}`,
        ...(admin ? [`Admin: ${admin}`] : []),
      ].join("\n"));
    }
    const result = await sendTemplateMail({
      to: user.email,
      key: "core.owned-sites",
      values: {
        display_name: user.display_name || user.email,
        site_list: entries.join("\n\n"),
      },
    });

    void auditLog({
      siteId: user.site_id,
      action: "workspace.sites_requested",
      outcome: result.ok ? "success" : "failure",
      actorId: user.id,
      actorEmail: user.email,
      target: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detail: result.ok ? `site list sent (${entries.length})` : `site list could not be mailed: ${result.error}`,
    });
  } catch (err) {
    console.error("Find-sites processing failed:", err);
  }
}
