// SPDX-License-Identifier: MIT

import { sendTemplateMail } from "../email/mail.js";
import { auditLog } from "../security/audit-log.js";
import { getSiteId } from "../settings/site-settings.js";
import { adminSignInUrl } from "./find-sites.js";

export interface SiteCreatedMailInput {
  siteId: string;
  siteName: string;
  siteUrl: string;
  email: string;
  displayName: string;
}

/**
 * Mail a new workspace's owner where their site lives and where to sign in.
 *
 * Sent from the installation's root site with the platform-only `core.site-created`
 * template. The password is never part of the mail. Failures are logged and audited,
 * never thrown, so provisioning cannot fail because mail did.
 */
export async function sendSiteCreatedMail(input: SiteCreatedMailInput): Promise<void> {
  const to = input.email.trim().toLowerCase();
  try {
    const origin = input.siteUrl.replace(/\/+$/, "");
    const adminUrl = (await adminSignInUrl(input.siteId, origin)) ?? `${origin}/admin/login`;
    const siteName = input.siteName.replace(/[\r\n]+/g, " ").trim() || origin;
    const result = await sendTemplateMail({
      to,
      key: "core.site-created",
      values: {
        display_name: input.displayName.replace(/[\r\n]+/g, " ").trim() || to,
        new_site_name: siteName,
        site_url: origin,
        admin_url: adminUrl,
        login_email: to,
      },
    });
    if (!result.ok) console.error("[justflows] site-created mail failed:", result.error);
    /** Logged on the root site that sent it; the new site may live in another database. */
    const rootSiteId = await getSiteId();
    if (rootSiteId) void auditLog({
      siteId: rootSiteId,
      action: "workspace.created_mail",
      outcome: result.ok ? "success" : "failure",
      actorId: null,
      actorEmail: to,
      target: input.siteId,
      ip: null,
      userAgent: null,
      detail: result.ok ? "site details sent to owner" : `site details could not be mailed: ${result.error}`,
    });
  } catch (err) {
    console.error("[justflows] site-created mail failed:", err instanceof Error ? err.message.replace(/[\r\n]/g, " ") : "failed");
  }
}
