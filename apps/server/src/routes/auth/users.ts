import { Router, type Request } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../../lib/database/db.js";
import { requireCapability, requireRole } from "../../middleware/auth.js";
import { param } from "../../lib/http/params.js";
import { hashPassword } from "../../lib/auth/password.js";
import { isAssignableRole } from "../../lib/auth/assignable-roles.js";
import { STORED_ROLE_ID } from "../../lib/auth/rbac.js";
import { PasswordSchema } from "../../lib/auth/password-policy.js";
import { revokeUserSessions } from "../../lib/auth/auth-session.js";
import { clearUserResets } from "../../lib/auth/password-reset-db.js";
import { auditFromRequest } from "../../lib/security/audit-log.js";
import { erasePersonalData, exportPersonalData } from "../../lib/auth/personal-data.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { sendMail } from "../../lib/email/mail.js";
import {
  createUser,
  CreateUserSchema,
  deleteUser,
  emitUserEvent,
  getUserWithAccess,
  listUsers,
  PatchUserSchema,
  updateUser,
  type UserAdminActor,
} from "../../lib/auth/users-admin.js";

const router = Router();

function now(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function actorOf(req: Request): UserAdminActor {
  const session = req.session!;
  return {
    siteId: session.siteId,
    userId: session.userId,
    role: session.role,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

router.get("/", requireCapability("users:read"), async (req, res) => {
  try {
    res.json({ users: await listUsers(req.session!.siteId) });
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

router.get("/:id", requireCapability("users:read"), async (req, res) => {
  try {
    const result = await getUserWithAccess(req.session!.siteId, param(req.params.id));
    res.status(result.status).json(result.body);
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

router.post("/", requireRole("administrator"), async (req, res) => {
  try {
    const body = CreateUserSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message });
      return;
    }
    const result = await createUser(body.data, actorOf(req));
    res.status(result.status).json(result.body);
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.string().regex(STORED_ROLE_ID).optional(),
});

router.post("/invite", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const body = InviteSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  try {
    const email = body.data.email.toLowerCase();
    const localPart = email.slice(0, email.indexOf("@"));
    const usernameBase = localPart.replace(/[^a-z0-9_.-]/gi, "").slice(0, 51) || "user";
    const username = `${usernameBase}-${randomBytes(4).toString("hex")}`;
    const displayName = localPart.slice(0, 255);
    const password = randomBytes(24).toString("base64url");
    const role = body.data.role ?? "subscriber";
    if (!(await isAssignableRole(role))) {
      res.status(400).json({ error: "Unknown role" });
      return;
    }
    const id = randomUUID();
    const timestamp = now();
    const db = await getDb();

    await db.run(
      `INSERT INTO users (id, site_id, email, username, display_name, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        session.siteId,
        email,
        username,
        displayName,
        await hashPassword(password),
        role,
        timestamp,
        timestamp,
      ],
    );

    auditFromRequest(req, "user.created", { target: id, detail: `role=${role}; invited=true` });
    await emitUserEvent("user.created", id, session.siteId);
    const origin = (process.env.APP_URL ?? "").replace(/\/$/, "");
    const mail = await sendMail({
      to: email,
      subject: "You have been invited to Justflows",
      text: [
        "An administrator invited you to Justflows.",
        "",
        `Username: ${username}`,
        `Temporary password: ${password}`,
        origin ? `Sign in: ${origin}/login` : "Open the site's login page to sign in.",
        "",
        "Change your password after signing in.",
      ].join("\n"),
    });

    res.status(201).json({
      user: { id, email, username, displayName, role, createdAt: timestamp },
      mailSent: mail.ok,
      ...(!mail.ok
        ? { warning: `User created, but the invitation email could not be sent: ${mail.error}` }
        : {}),
    });
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

router.patch("/:id", requireCapability("users:manage"), async (req, res) => {
  const body = PatchUserSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }
  try {
    const result = await updateUser(param(req.params.id), body.data, actorOf(req));
    res.status(result.status).json(result.body);
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

const ResetPasswordSchema = z.object({ newPassword: PasswordSchema });

/**
 * Set another user's password.
 *
 * The counterpart to POST /api/auth/password: an administrator needs a way to
 * lock an account out of an attacker's hands without database access. No
 * current-password check — the administrator does not have it — so this is
 * deliberately administrator-only, and it revokes every session the account
 * has, including any the attacker is holding.
 */
router.post("/:id/password", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const userId = param(req.params.id);
  const body = ResetPasswordSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  try {
    const db = await getDb();
    const rows = await db.query<{ email: string }>(
      "SELECT email FROM users WHERE id = ? AND site_id = ? LIMIT 1",
      [userId, session.siteId],
    );
    if (!rows[0]) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await db.run(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND site_id = ?",
      [await hashPassword(body.data.newPassword), now(), userId, session.siteId],
    );
    await revokeUserSessions(userId, session.siteId);
    await clearUserResets(userId, session.siteId);
    auditFromRequest(req, "auth.password_reset", { target: userId });
    await emitUserEvent("user.updated", userId, session.siteId);

    void import("../../lib/email/mail.js")
      .then((mail) =>
        mail.sendMail({
          to: rows[0]!.email,
          subject: "Your password was reset",
          text:
            "An administrator reset the password on your Justflows account.\n\n" +
            "All sessions for the account have been signed out. If you did not " +
            "expect this, contact the site administrator.",
        }),
      )
      .catch((err) => console.error("Password-reset notice failed:", err));

    res.json({ ok: true });
  } catch (err) {
    console.error("Password reset error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * Everything held about one account (GDPR Art. 15).
 *
 * Administrator only, and the export is generated on request rather than
 * stored — a file of somebody's personal data sitting on disk is the problem
 * this is meant to help with, not the solution.
 */
router.get("/:id/personal-data", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  try {
    const data = await exportPersonalData(session.siteId, param(req.params.id));
    if (!data) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="personal-data-${param(req.params.id)}.json"`,
    );
    res.json(data);
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

const EraseSchema = z.object({
  /** Who inherits this user's content. Null leaves it unattributed. */
  reassignContentTo: z.string().uuid().nullable().optional(),
});

/**
 * Erase the personal data attached to an account (GDPR Art. 17).
 *
 * Separate from DELETE: removing the row and removing the person's data are
 * different operations, and conflating them is why deleting a user previously
 * left their comments, form submissions and IP addresses behind.
 */
router.post("/:id/erase", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const userId = param(req.params.id);
  const body = EraseSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  try {
    const result = await erasePersonalData(
      session.siteId,
      userId,
      body.data.reassignContentTo ?? null,
    );
    await emitUserEvent("user.updated", userId, session.siteId);
    res.json({ ok: true, ...result });
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

router.delete("/:id", requireRole("administrator"), async (req, res) => {
  try {
    const result = await deleteUser(param(req.params.id), actorOf(req));
    res.status(result.status).json(result.body);
  } catch (err) {
    sendServerError(res, "users", err);
  }
});

export default router;
