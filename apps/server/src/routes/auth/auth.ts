import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../../lib/database/db.js";
import { clearSessionCookie, getSession, setCsrfCookie, setSessionCookie } from "../../lib/auth/session.js";
import { clientIp, consumeRateLimit, rateLimitRetryAfter } from "../../lib/security/rate-limit.js";
import { hashPassword, needsRehash, verifyPassword } from "../../lib/auth/password.js";
import { getGeneralSettings } from "../../lib/settings/general-settings.js";
import { getSiteId } from "../../lib/settings/site-settings.js";
import { isInstalled } from "../../middleware/install-guard.js";
import { auditContext, auditFromRequest, auditLog } from "../../lib/security/audit-log.js";
import { requireSession } from "../../middleware/auth.js";
import { PasswordSchema } from "../../lib/auth/password-policy.js";
import { revokeUserSessions } from "../../lib/auth/auth-session.js";
import { createDeviceSession, listDeviceSessions, revokeDeviceSession, revokeOtherDeviceSessions } from "../../lib/auth/device-sessions.js";
import { getAdminPathConfig } from "../../lib/admin/admin-path.js";
import { param } from "../../lib/http/params.js";
import {
  completePasswordReset,
  processForgotPassword,
  resolveResetToken,
} from "../../lib/auth/password-reset.js";
import { clearUserResets, hashResetToken } from "../../lib/auth/password-reset-db.js";

const router = Router();
const loginRequestLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  // The route's credential-aware limiter below is deliberately stricter. This
  // middleware is the coarse per-IP ceiling that CodeQL can verify exists.
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
function accountSecurityRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
}
const registerRequestLimit = accountSecurityRateLimit();
const passwordRequestLimit = accountSecurityRateLimit();
const passwordForgotRequestLimit = accountSecurityRateLimit();
const passwordResetRequestLimit = accountSecurityRateLimit();
const totpSetupRequestLimit = accountSecurityRateLimit();
const totpEnableRequestLimit = accountSecurityRateLimit();
const totpDisableRequestLimit = accountSecurityRateLimit();

router.get("/csrf", (req, res) => {
  if (!req.cookies?.jf_csrf) {
    // Bind to the session when there is one; the pre-session form (login) gets
    // a random value, which is all a request without a session can offer.
    const session = getSession(req);
    if (session) setCsrfCookie(res, session.userId, Number(session.tv ?? 0));
    else setCsrfCookie(res);
  }
  res.json({ ok: true });
});

/**
 * Who the current session belongs to, and their live role.
 *
 * The admin UI uses this to decide what to render — which nav items, which
 * page controls — for a role that authenticated but was not granted the
 * capability. It is a UX convenience, not a security boundary: every route it
 * informs is still enforced independently by `requireRole` on the server.
 */
router.get("/me", requireSession, async (req, res) => {
  const session = req.session!;
  const { getEffectiveAccess } = await import("../../lib/auth/access-policy.js");
  const access = await getEffectiveAccess(session.userId, session.siteId, session.role);
  res.json({ id: session.userId, email: session.email, role: session.role, roleId: access.roleId, capabilities: access.capabilities });
});

/**
 * Where the browser should go once authenticated.
 *
 * A subscriber, or a plugin role such as Shop's customer, has nothing in the
 * admin app and belongs on the site itself.
 * Everyone else lands on the admin app — at whatever path the administrator
 * moved it to (issue #51). The pre-session `/login` and `/register` pages have
 * no way to know that path on their own, and it should not be handed to anyone
 * who has not signed in, so it is resolved here and returned in the response.
 */
async function postAuthRedirect(role: string, userId?: string, siteId?: string): Promise<string> {
  if (userId && siteId) {
    const { getEffectiveAccess } = await import("../../lib/auth/access-policy.js");
    const access = await getEffectiveAccess(userId, siteId, role);
    if (!access.capabilities.some((capability) => capability !== "content:read")) return "/";
  } else if (role === "subscriber" || role === "customer") return "/";
  return (await getAdminPathConfig()).path;
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Six-digit authenticator code, or a recovery code, when 2FA is enrolled. */
  totp: z.string().max(64).optional(),
});

router.post("/login", loginRequestLimit, async (req, res) => {
  const ip = clientIp(req);
  if (!consumeRateLimit(`login:ip:${ip}`, 20, 15 * 60 * 1000)) {
    // The window grows with each exhausted one, so the caller cannot work it
    // out for themselves any more.
    res.setHeader("Retry-After", String(rateLimitRetryAfter(`login:ip:${ip}`)));
    res.status(429).json({ error: "Too many login attempts. Try again later." });
    return;
  }

  const body = LoginSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const { email, password } = body.data;
  const normalizedEmail = email.toLowerCase().trim();

  if (!consumeRateLimit(`login:email:${normalizedEmail}`, 10, 15 * 60 * 1000)) {
    res.setHeader("Retry-After", String(rateLimitRetryAfter(`login:email:${normalizedEmail}`)));
    res.status(429).json({ error: "Too many login attempts. Try again later." });
    return;
  }

  try {
    const db = await getDb();
    // Scoped to the site. Registration enforces uniqueness per site_id, so two
    // accounts can legitimately share an address across sites — an unscoped
    // lookup then picked whichever row the database returned first, which is
    // not a decision authentication should be leaving to row order.
    const siteId = await getSiteId();
    type UserRow = {
      id: string;
      site_id: string;
      email: string;
      password_hash: string;
      role: string;
      token_version: number | null;
    };
    const rows = siteId
      ? await db.query<UserRow>(
          "SELECT id, site_id, email, password_hash, role, token_version FROM users WHERE site_id = ? AND email = ? LIMIT 1",
          [siteId, normalizedEmail],
        )
      : // No site row yet means the install did not finish; fall back rather
        // than lock the owner out of a half-built site.
        await db.query<UserRow>(
          "SELECT id, site_id, email, password_hash, role, token_version FROM users WHERE email = ? LIMIT 1",
          [normalizedEmail],
        );

    const user = rows[0];
    const valid = user ? await verifyPassword(password, user.password_hash) : false;

    if (!user || !valid) {
      // Recorded with the address attempted, not the password. A run of these
      // from one address is the signal that a credential-stuffing attempt is
      // under way, and it was previously invisible.
      if (user) {
        void auditLog({
          siteId: user.site_id,
          action: "auth.login_failed",
          outcome: "failure",
          actorId: user.id,
          actorEmail: user.email,
          target: normalizedEmail,
          ...auditContext(req),
          detail: "wrong password",
        });
      }
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Second factor, if this account has one. Checked after the password so a
    // wrong password and a wrong code are indistinguishable to someone who has
    // neither — this must not become an oracle for "that address exists and has
    // 2FA". The rate limits above already counted this attempt.
    const { getTotpState, consumeRecoveryCode } = await import("../../lib/auth/totp-db.js");
    const totpState = await getTotpState(user.id, user.site_id);
    if (totpState.enabled) {
      const supplied = body.data.totp?.trim() ?? "";
      if (!supplied) {
        // Only reached by someone who already proved the password, so it
        // discloses nothing they do not know.
        res.status(401).json({ error: "Enter your authentication code", totpRequired: true });
        return;
      }

      const { verifyTotp } = await import("../../lib/auth/totp.js");
      const codeOk =
        verifyTotp(totpState.secret ?? "", supplied) ||
        (await consumeRecoveryCode(user.id, user.site_id, supplied));

      if (!codeOk) {
        void auditLog({
          siteId: user.site_id,
          action: "auth.login_failed",
          outcome: "failure",
          actorId: user.id,
          actorEmail: user.email,
          ...auditContext(req),
          detail: "wrong second factor",
        });
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
        res.status(401).json({ error: "That code is not valid", totpRequired: true });
        return;
      }
    }

    // Successful login is the only moment the plaintext is available, so it is
    // where an old work factor can be upgraded without asking the user to do
    // anything. Failure here must not fail the login.
    if (needsRehash(user.password_hash)) {
      try {
        await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [
          await hashPassword(password),
          user.id,
        ]);
      } catch (err) {
        console.error("Password rehash failed", err);
      }
    }

    const sid = await createDeviceSession({
      userId: user.id,
      siteId: user.site_id,
      userAgent: req.get("user-agent"),
      ip: clientIp(req),
    });
    setSessionCookie(res, {
      sid,
      userId: user.id,
      siteId: user.site_id,
      role: user.role,
      email: user.email,
      tv: Number(user.token_version ?? 0),
    });
    void auditLog({
      siteId: user.site_id,
      action: "auth.login",
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      ...auditContext(req),
    });
    // The client needs this to decide where to send the browser next — only
    // certain roles get the admin app; a subscriber belongs on the site itself.
    // `redirectTo` carries the configured admin path so the client does not have
    // to guess it from a page that was served before the session existed.
    res.json({ ok: true, role: user.role, redirectTo: await postAuthRedirect(user.role, user.id, user.site_id) });
  } catch (err) {
    console.error("Login error", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/logout", async (req, res) => {
  // Revoke this device only. Account-wide revocation remains available after
  // password changes and through the explicit sessions control.
  const session = getSession(req);
  if (session) {
    if (session.sid) await revokeDeviceSession(session.sid, session.userId, session.siteId);
    else await revokeUserSessions(session.userId, session.siteId);
    void auditLog({
      siteId: session.siteId,
      action: "auth.logout",
      actorId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      ...auditContext(req),
    });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

const RegisterSchema = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(2)
    .max(60)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Username may only contain letters, numbers, dots, underscores and hyphens",
    ),
  password: PasswordSchema,
  displayName: z.string().min(1).max(255).optional(),
});

function now(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

router.get("/registration", async (_req, res) => {
  if (!isInstalled()) {
    res.json({ enabled: false });
    return;
  }
  try {
    const general = await getGeneralSettings();
    res.json({ enabled: general.usersCanRegister, defaultRole: general.defaultRole });
  } catch {
    res.json({ enabled: false });
  }
});

router.post("/register", registerRequestLimit, async (req, res) => {
  if (!isInstalled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const ip = clientIp(req);
  if (!consumeRateLimit(`register:ip:${ip}`, 8, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many registration attempts. Try again later." });
    return;
  }

  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  const email = parsed.data.email.toLowerCase().trim();
  const username = parsed.data.username.trim();
  const displayName = (parsed.data.displayName ?? username).trim();

  if (!consumeRateLimit(`register:email:${email}`, 5, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many registration attempts. Try again later." });
    return;
  }

  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(500).json({ error: "Site is not configured" });
      return;
    }

    const general = await getGeneralSettings(siteId);
    if (!general.usersCanRegister) {
      res.status(403).json({ error: "Registration is closed" });
      return;
    }

    const db = await getDb();
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE site_id = ? AND (email = ? OR username = ?) LIMIT 1",
      [siteId, email, username],
    );
    if (existing[0]) {
      res.status(409).json({ error: "That email or username is already registered" });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const id = randomUUID();
    await db.run(
      `INSERT INTO users (id, site_id, email, username, display_name, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, siteId, email, username, displayName, passwordHash, general.defaultRole, now(), now()],
    );

    try {
      const { getRuntimeHooks } = await import("../../lib/plugins/plugin-runtime.js");
      await getRuntimeHooks().dispatchAction(
        "user.created",
        { userId: id },
        { siteId, source: "http" },
      );
    } catch {
      // hooks are optional during early boot
    }

    const sid = await createDeviceSession({
      userId: id,
      siteId,
      userAgent: req.get("user-agent"),
      ip: clientIp(req),
    });
    setSessionCookie(res, {
      sid,
      userId: id,
      siteId,
      role: general.defaultRole,
      email,
      tv: 0,
    });

    const origin = (process.env.APP_URL ?? "").replace(/\/$/, "");
    const loginUrl = origin ? `${origin}/login` : "/login";
    void import("../../lib/email/mail.js")
      .then(async (mail) => {
        await mail.notifyAdmin(
          "New user registration",
          `A new user registered:\n\nName: ${displayName}\nUsername: ${username}\nEmail: ${email}\nRole: ${general.defaultRole}`,
          email,
        );
        await mail.sendTemplateMail({
          to: email,
          key: "core.account-created",
          values: { display_name: displayName, action_url: loginUrl, username },
        });
      })
      .catch((err) => console.error("Registration mail failed:", err));

    res.status(201).json({
      ok: true,
      role: general.defaultRole,
      redirectTo: await postAuthRedirect(general.defaultRole, id, siteId),
    });
  } catch (err) {
    console.error("Register error", err);
    res.status(500).json({ error: "Server error" });
  }
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: PasswordSchema,
});

/**
 * Change your own password.
 *
 * There was no way to do this — not here, not in /api/users. A user who
 * believed their password was compromised had no remedy inside the product,
 * and neither did an administrator; with a stateless 14-day token, an attacker
 * who captured a password held the account until someone edited the database.
 */
router.post("/password", passwordRequestLimit, requireSession, async (req, res) => {
  const session = req.session!;

  // Guessing the current password is a credential test like any other.
  if (!consumeRateLimit(`password:user:${session.userId}`, 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  const body = ChangePasswordSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  const { currentPassword, newPassword } = body.data;
  if (currentPassword === newPassword) {
    res.status(400).json({ error: "The new password must be different from the current one" });
    return;
  }

  try {
    const db = await getDb();
    const rows = await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = ? AND site_id = ? LIMIT 1",
      [session.userId, session.siteId],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    await db.run(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND site_id = ?",
      [await hashPassword(newPassword), now(), session.userId, session.siteId],
    );

    // Ends every other session, which is the point: a password change is what
    // someone does after a compromise. Re-issue this caller's cookie at the new
    // counter so the tab they are sitting in keeps working.
    await revokeUserSessions(session.userId, session.siteId);
    // A pending "forgot password" link must not outlive the password it would
    // have changed.
    await clearUserResets(session.userId, session.siteId);
    const bumped = await db
      .query<{ token_version: number | null }>(
        "SELECT token_version FROM users WHERE id = ? AND site_id = ? LIMIT 1",
        [session.userId, session.siteId],
      )
      .catch(() => []);

    setSessionCookie(res, {
      sid: session.sid,
      userId: session.userId,
      siteId: session.siteId,
      role: session.role,
      email: session.email,
      tv: Number(bumped[0]?.token_version ?? (session.tv ?? 0) + 1),
    });

    auditFromRequest(req, "auth.password_changed");

    void import("../../lib/email/mail.js")
      .then((mail) =>
        mail.sendTemplateMail({
          to: session.email,
          key: "core.password-changed",
          values: { display_name: session.email },
        }),
      )
      .catch((err) => console.error("Password-change notice failed:", err));

    res.json({ ok: true });
  } catch (err) {
    console.error("Password change error", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Self-service password recovery (#93) ─────────────────────────────────────

/**
 * Whether the login and registration screens should offer a "Forgot password?"
 * entry point. Mirrors GET /registration: a single boolean, nothing an
 * unauthenticated caller could not infer by trying the form anyway.
 */
router.get("/password/forgot", async (_req, res) => {
  if (!isInstalled()) {
    res.json({ enabled: false });
    return;
  }
  try {
    const general = await getGeneralSettings();
    res.json({ enabled: general.passwordResetEnabled });
  } catch {
    res.json({ enabled: false });
  }
});

const ForgotPasswordSchema = z.object({ email: z.string().email() });

/**
 * Ask for a reset link.
 *
 * The response is identical whether or not the address is known, whether or not
 * self-service reset is enabled for it, and whether or not the mail was sent —
 * so it cannot be used to enumerate accounts. The work is handed off and not
 * awaited, which keeps the response time flat across all of those cases. Only a
 * rate-limit rejection looks different, and that is keyed on the submitted
 * address regardless of whether it exists.
 */
router.post("/password/forgot", passwordForgotRequestLimit, async (req, res) => {
  const ip = clientIp(req);
  const sameAnswer = () => res.json({ ok: true });

  if (!consumeRateLimit(`pwreset:forgot:ip:${ip}`, 5, 15 * 60 * 1000)) {
    res.setHeader("Retry-After", String(rateLimitRetryAfter(`pwreset:forgot:ip:${ip}`)));
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  const body = ForgotPasswordSchema.safeParse(req.body);
  if (!body.success) {
    // A malformed address cannot belong to anyone, so this leaks nothing.
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }

  const email = body.data.email.toLowerCase().trim();
  if (!consumeRateLimit(`pwreset:forgot:email:${email}`, 3, 15 * 60 * 1000)) {
    res.setHeader("Retry-After", String(rateLimitRetryAfter(`pwreset:forgot:email:${email}`)));
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  void processForgotPassword(email, {
    ip,
    userAgent: (req.get("user-agent") ?? "").slice(0, 255) || null,
  }).catch((err) => console.error("Forgot-password dispatch failed:", err));

  sameAnswer();
});

const VerifyResetSchema = z.object({ token: z.string().min(16).max(512) });

/**
 * Whether a reset token is still good, for the reset page to show the form or an
 * "expired link" message. The token is a high-entropy secret the caller already
 * holds, so answering does not disclose anything they do not have.
 */
router.post("/password/reset/verify", passwordResetRequestLimit, async (req, res) => {
  const ip = clientIp(req);
  if (!consumeRateLimit(`pwreset:verify:ip:${ip}`, 30, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }
  const body = VerifyResetSchema.safeParse(req.body);
  if (!body.success) {
    res.json({ valid: false });
    return;
  }
  try {
    const reset = await resolveResetToken(body.data.token);
    res.json({ valid: reset !== null });
  } catch (err) {
    console.error("Reset verify error", err);
    res.status(500).json({ error: "Server error" });
  }
});

const ResetPasswordSchema = z.object({
  token: z.string().min(16).max(512),
  newPassword: PasswordSchema,
});

/**
 * Redeem a reset link.
 *
 * Rate limited per IP and per token. A valid token sets the new password,
 * revokes every session for the account, and invalidates the token and its
 * siblings — but never signs the caller in, so TOTP, lockout and the rest still
 * apply when they next sign in.
 */
router.post("/password/reset", passwordResetRequestLimit, async (req, res) => {
  const ip = clientIp(req);
  if (!consumeRateLimit(`pwreset:reset:ip:${ip}`, 10, 15 * 60 * 1000)) {
    res.setHeader("Retry-After", String(rateLimitRetryAfter(`pwreset:reset:ip:${ip}`)));
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  const body = ResetPasswordSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  const tokenKey = hashResetToken(body.data.token).slice(0, 32);
  if (!consumeRateLimit(`pwreset:reset:token:${tokenKey}`, 5, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  try {
    const reset = await resolveResetToken(body.data.token);
    if (!reset) {
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 150));
      res
        .status(400)
        .json({ error: "This reset link is invalid or has expired. Request a new one." });
      return;
    }

    await completePasswordReset(reset, body.data.newPassword, {
      ip,
      userAgent: (req.get("user-agent") ?? "").slice(0, 255) || null,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Password reset error", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Two-factor authentication ────────────────────────────────────────────────

/**
 * Enrolment is two steps on purpose. POST /2fa/setup mints a secret and stores
 * it unconfirmed; POST /2fa/enable proves the user can generate a code before
 * it comes into force. Minting and enabling in one call would lock out anyone
 * whose clock is wrong or who mistyped the secret.
 */

router.get("/2fa", requireSession, async (req, res) => {
  const session = req.session!;
  try {
    const { getTotpState } = await import("../../lib/auth/totp-db.js");
    const state = await getTotpState(session.userId, session.siteId);
    res.json({
      enabled: state.enabled,
      pending: state.pending,
      recoveryCodesRemaining: state.enabled ? state.recoveryCodes.length : 0,
    });
  } catch (err) {
    console.error("2FA status error", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/2fa/setup", totpSetupRequestLimit, requireSession, async (req, res) => {
  const session = req.session!;
  try {
    const { getTotpState, startTotpEnrolment } = await import("../../lib/auth/totp-db.js");
    const existing = await getTotpState(session.userId, session.siteId);
    if (existing.enabled) {
      res.status(409).json({ error: "Two-factor authentication is already on" });
      return;
    }

    const { generateTotpSecret, totpUri } = await import("../../lib/auth/totp.js");
    const secret = generateTotpSecret();
    await startTotpEnrolment(session.userId, session.siteId, secret);

    const { getDb: db2 } = await import("../../lib/database/db.js");
    const db = await db2();
    const siteRows = await db
      .query<{ name: string }>("SELECT name FROM sites WHERE id = ? LIMIT 1", [session.siteId])
      .catch(() => []);
    const issuer = siteRows[0]?.name?.trim() || "Justflows";

    // The secret is returned once, for the QR code and for manual entry. After
    // /2fa/enable it is never readable again through the API.
    res.json({ secret, uri: totpUri(secret, session.email, issuer) });
  } catch (err) {
    console.error("2FA setup error", err);
    res.status(500).json({ error: "Server error" });
  }
});

const EnableTotpSchema = z.object({ code: z.string().min(1).max(16) });

router.post("/2fa/enable", totpEnableRequestLimit, requireSession, async (req, res) => {
  const session = req.session!;
  if (!consumeRateLimit(`2fa:enable:${session.userId}`, 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  const body = EnableTotpSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter the six-digit code from your authenticator app" });
    return;
  }

  try {
    const { getTotpState, confirmTotp } = await import("../../lib/auth/totp-db.js");
    const state = await getTotpState(session.userId, session.siteId);
    if (state.enabled) {
      res.status(409).json({ error: "Two-factor authentication is already on" });
      return;
    }
    if (!state.pending || !state.secret) {
      res.status(400).json({ error: "Start setup first" });
      return;
    }

    const { verifyTotp, generateRecoveryCodes } = await import("../../lib/auth/totp.js");
    if (!verifyTotp(state.secret, body.data.code)) {
      res
        .status(400)
        .json({ error: "That code is not valid. Check your device's clock and try again." });
      return;
    }

    const recoveryCodes = generateRecoveryCodes();
    await confirmTotp(session.userId, session.siteId, recoveryCodes, now());
    auditFromRequest(req, "auth.2fa_enabled");

    void import("../../lib/email/mail.js")
      .then((mail) =>
        mail.sendTemplateMail({
          to: session.email,
          key: "core.two-factor-enabled",
          values: { display_name: session.email },
        }),
      )
      .catch((err) => console.error("2FA notice failed:", err));

    // Shown once. Storing them anywhere the user can re-read would make them a
    // second copy of the secret rather than a break-glass measure.
    res.json({ ok: true, recoveryCodes });
  } catch (err) {
    console.error("2FA enable error", err);
    res.status(500).json({ error: "Server error" });
  }
});

const DisableTotpSchema = z.object({
  password: z.string().min(1),
  code: z.string().max(64).optional(),
});

/**
 * Turning 2FA off is a downgrade, so it costs a password and a current code —
 * otherwise a borrowed session is enough to remove the factor that a borrowed
 * session was supposed to stop.
 */
router.post("/2fa/disable", totpDisableRequestLimit, requireSession, async (req, res) => {
  const session = req.session!;
  if (!consumeRateLimit(`2fa:disable:${session.userId}`, 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  const body = DisableTotpSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    const db = await getDb();
    const rows = await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = ? AND site_id = ? LIMIT 1",
      [session.userId, session.siteId],
    );
    if (!rows[0] || !(await verifyPassword(body.data.password, rows[0].password_hash))) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
      res.status(401).json({ error: "Password is incorrect" });
      return;
    }

    const { getTotpState, disableTotp, consumeRecoveryCode } = await import("../../lib/auth/totp-db.js");
    const state = await getTotpState(session.userId, session.siteId);
    if (state.enabled) {
      const supplied = body.data.code?.trim() ?? "";
      const { verifyTotp } = await import("../../lib/auth/totp.js");
      const codeOk =
        Boolean(supplied) &&
        (verifyTotp(state.secret ?? "", supplied) ||
          (await consumeRecoveryCode(session.userId, session.siteId, supplied)));
      if (!codeOk) {
        res.status(401).json({ error: "Enter a current authentication code to turn this off" });
        return;
      }
    }

    await disableTotp(session.userId, session.siteId);
    auditFromRequest(req, "auth.2fa_disabled");

    void import("../../lib/email/mail.js")
      .then((mail) =>
        mail.sendTemplateMail({
          to: session.email,
          key: "core.two-factor-disabled",
          values: { display_name: session.email },
        }),
      )
      .catch((err) => console.error("2FA notice failed:", err));

    res.json({ ok: true });
  } catch (err) {
    console.error("2FA disable error", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/sessions", requireSession, async (req, res) => {
  const session = req.session!;
  try {
    res.json({ sessions: await listDeviceSessions(session.userId, session.siteId, session.sid) });
  } catch (err) {
    console.error("Session list error", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/sessions/:id", requireSession, async (req, res) => {
  const session = req.session!;
  const id = param(req.params.id);
  if (id === session.sid) {
    res.status(400).json({ error: "Use sign out to end the current session" });
    return;
  }
  const revoked = await revokeDeviceSession(id, session.userId, session.siteId);
  if (!revoked) { res.status(404).json({ error: "Session not found" }); return; }
  auditFromRequest(req, "auth.session_revoked", { target: id });
  res.json({ ok: true });
});

router.post("/sessions/revoke-others", requireSession, async (req, res) => {
  const session = req.session!;
  if (!session.sid) { res.status(409).json({ error: "Sign in again to manage device sessions" }); return; }
  const revoked = await revokeOtherDeviceSessions(session.sid, session.userId, session.siteId);
  auditFromRequest(req, "auth.other_sessions_revoked", { detail: `count=${revoked}` });
  res.json({ ok: true, revoked });
});

export default router;
