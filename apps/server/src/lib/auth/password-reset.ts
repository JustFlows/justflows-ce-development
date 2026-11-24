// SPDX-License-Identifier: MIT

import { getDb } from "../database/db.js";
import { getGeneralSettings } from "../settings/general-settings.js";
import { getSiteId } from "../settings/site-settings.js";
import { hashPassword } from "./password.js";
import { auditLog } from "../security/audit-log.js";
import { primarySiteOrigin } from "../email/email-asset-url.js";
import { sendTemplateMail } from "../email/mail.js";
import { accountSurface, authPagePath, type AuthSurface } from "./auth-surface.js";
import {
  createPasswordReset,
  findLiveReset,
  redeemPasswordReset,
  resetTtlMinutes,
  type ResolvedReset,
} from "./password-reset-db.js";

/**
 * Self-service password recovery (#93).
 *
 * The request side answers identically whether or not the address exists, and
 * the caller does not await it — so a "forgot password" POST takes the same time
 * for a real account, an unknown address, and an account whose role is not
 * allowed to self-serve. The completion side sets a new password and revokes
 * every session, but never establishes one: a second factor, lockout, and every
 * other login control still apply on the next sign-in.
 */

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

function appOrigin(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}

/**
 * The link mailed to the account: the reset page of the surface it belongs to,
 * so a staff link carries the admin path to its own owner and nobody else. The
 * page strips the token from the URL on load.
 */
export async function resetLinkFor(token: string, surface: AuthSurface = "site", origin = appOrigin()): Promise<string> {
  const query = `token=${encodeURIComponent(token)}`;
  return `${origin}${await authPagePath(surface, "reset-password")}?${query}`;
}

interface ForgotUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

/**
 * Act on a "forgot password" request.
 *
 * Resolves without disclosing whether `email` is a known address. When it is,
 * self-service reset is enabled, and the account's role is permitted, a
 * single-use link is mailed. Every outcome writes one audit row.
 */
export async function processForgotPassword(
  email: string,
  ctx: RequestContext,
  surface: AuthSurface = "site",
): Promise<void> {
  const normalized = email.toLowerCase().trim();

  try {
    const siteId = await getSiteId();
    if (!siteId) return;

    const settings = await getGeneralSettings(siteId);

    const db = await getDb();
    const rows = await db.query<ForgotUserRow>(
      "SELECT id, email, display_name, role FROM users WHERE site_id = ? AND email = ? LIMIT 1",
      [siteId, normalized],
    );
    const user = rows[0];

    if (!settings.passwordResetEnabled) {
      // Feature is off site-wide. Nothing is mailed; record the attempt only
      // when it maps to a real account, so the log is not a list of guesses.
      if (user) {
        void auditLog({
          siteId,
          action: "auth.password_reset_failed",
          outcome: "failure",
          actorId: user.id,
          actorEmail: user.email,
          target: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          detail: "self-service reset is disabled",
        });
      }
      return;
    }

    if (!user) return;

    // The site's page never mails a staff account and the admin's never mails a
    // member: each is treated as an unknown address, so the shared answer holds.
    if ((await accountSurface(user.role, user.id, siteId)) !== surface) {
      void auditLog({
        siteId,
        action: "auth.password_reset_failed",
        outcome: "failure",
        actorId: user.id,
        actorEmail: user.email,
        target: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        detail: surface === "site" ? "staff reset requested on the site's page" : "member reset requested on the admin's page",
      });
      return;
    }

    const allowedRoles = settings.passwordResetRoles;
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role as (typeof allowedRoles)[number])) {
      void auditLog({
        siteId,
        action: "auth.password_reset_failed",
        outcome: "failure",
        actorId: user.id,
        actorEmail: user.email,
        target: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        detail: `self-service reset not permitted for role ${user.role}`,
      });
      return;
    }

    const { token, expiresAt } = await createPasswordReset(user.id, siteId, ctx.ip);
    const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
    const link = await resetLinkFor(token, surface);

    // Local-development convenience: print the link so a reset can be tested
    // without a mail catcher. Deliberately gated on NODE_ENV === "development"
    // (not merely "not production") so an unset NODE_ENV never leaks a token to
    // logs — the one place issue #93 otherwise keeps them out of.
    if (process.env.NODE_ENV === "development") {
      console.log(`\n[dev] password reset for ${user.email}:\n      ${link}\n`);
    }

    const result = await sendTemplateMail({
      to: user.email,
      key: "core.password-reset",
      values: { display_name: user.display_name || user.email, action_url: link, expiration: `${minutes} minutes` },
    });

    void auditLog({
      siteId,
      action: "auth.password_reset_requested",
      outcome: result.ok ? "success" : "failure",
      actorId: user.id,
      actorEmail: user.email,
      target: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detail: result.ok ? "reset link sent" : `reset link could not be mailed: ${result.error}`,
    });
  } catch (err) {
    console.error("Forgot-password processing failed:", err);
  }
}

/** A first-password link stays valid for three days: the person may not read mail at once. */
export const PASSWORD_SETUP_TTL_MINUTES = 3 * 24 * 60;

export type PasswordSetupResult = { ok: true; expiresAt: string } | { ok: false; status: number; error: string };

/**
 * Email an existing account a single-use link to choose its password, on the
 * sign-in surface it belongs to (admin pages for staff, the site's for
 * members). For accounts made for someone by an administrator or a plugin,
 * who never typed a password. It does not depend on self-service reset being
 * enabled, because the site, not the person, asked for it. The link opens on
 * the account's own site, and replaces any earlier reset link; nothing changes
 * until the person uses it.
 */
export async function sendPasswordSetup(
  siteId: string,
  userId: string,
  actor: { userId: string; role: string },
): Promise<PasswordSetupResult> {
  const db = await getDb();
  const rows = await db.query<ForgotUserRow & { username: string }>(
    "SELECT id, email, display_name, role, username FROM users WHERE id = ? AND site_id = ? LIMIT 1",
    [userId, siteId],
  );
  const user = rows[0];
  if (!user) return { ok: false, status: 404, error: "User not found." };
  const surface = await accountSurface(user.role, user.id, siteId);
  const { token, expiresAt } = await createPasswordReset(user.id, siteId, null, PASSWORD_SETUP_TTL_MINUTES);
  const link = await resetLinkFor(token, surface, (await primarySiteOrigin(siteId)) ?? appOrigin());
  if (process.env.NODE_ENV === "development") {
    console.log(`\n[dev] password setup for ${user.email}:\n      ${link}\n`);
  }
  const result = await sendTemplateMail({
    to: user.email,
    key: "core.account-invite",
    values: { display_name: user.display_name || user.email, action_url: link, expiration: "3 days", username: user.username },
  });
  void auditLog({
    siteId,
    action: "auth.password_setup_sent",
    outcome: result.ok ? "success" : "failure",
    actorId: actor.userId,
    actorRole: actor.role,
    target: user.id,
    detail: result.ok ? `set-password link sent to ${user.email}` : `set-password link could not be mailed: ${result.error}`,
  });
  return result.ok ? { ok: true, expiresAt: expiresAt.toISOString() } : { ok: false, status: 502, error: "The email could not be sent." };
}

/** Resolve a raw token to a live reset, or null. Thin re-export for the route. */
export async function resolveResetToken(token: string): Promise<ResolvedReset | null> {
  return findLiveReset(token);
}

/**
 * Set a new password from a validated reset.
 *
 * The claim, the password, the session version, device-session revocation, and
 * sibling links commit together. A failed step leaves the previous password
 * and sessions in place. This never signs the caller in.
 */
export async function completePasswordReset(
  reset: ResolvedReset,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const db = await getDb();
  const rows = await db.query<{ email: string; display_name: string; role: string }>(
    "SELECT email, display_name, role FROM users WHERE id = ? AND site_id = ? LIMIT 1",
    [reset.userId, reset.siteId],
  );
  const user = rows[0];
  const passwordHash = await hashPassword(newPassword);
  await redeemPasswordReset(reset, passwordHash);

  void auditLog({
    siteId: reset.siteId,
    action: "auth.password_reset",
    actorId: reset.userId,
    actorEmail: user?.email ?? null,
    actorRole: user?.role ?? null,
    target: reset.userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    detail: "completed via emailed link; all sessions revoked",
  });

  if (user?.email) {
    void sendTemplateMail({
      to: user.email,
      key: "core.password-changed",
      values: { display_name: user.email },
    }).catch((err) => console.error("Password-reset confirmation failed:", err));
  }
}

/** Minutes a link stays valid — surfaced to the admin UI copy. */
export { resetTtlMinutes };
