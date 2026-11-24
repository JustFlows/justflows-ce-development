// SPDX-License-Identifier: MIT

import { Router, type Request } from "express";
import { clientIp } from "../../lib/security/rate-limit.js";
import {
  createManagedUser,
  deleteUser,
  getUserWithAccess,
  listUsers,
  ManageCreateUserSchema,
  PatchUserSchema,
  updateUser,
  type UserAdminActor,
} from "../../lib/auth/users-admin.js";
import {
  createRole,
  deleteRole,
  listRoles,
  RoleSchema,
  updateRole,
  type RoleAdminActor,
} from "../../lib/auth/roles-admin.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { badRequest, ensureKeyCan, paginate, relay, sendJson } from "./envelope.js";

const router = Router();

function actorOf(req: Request): UserAdminActor & RoleAdminActor {
  return {
    siteId: req.apiKeyOwner!.siteId,
    userId: req.apiKeyOwner!.userId,
    role: req.apiKeyOwner!.role,
    ip: clientIp(req),
    userAgent: req.get("user-agent") ?? null,
    // A key (or OAuth grant) can never hand out more than it was given.
    capabilityCeiling: req.apiKey?.capabilities ?? [],
    scopeCeiling: req.apiKey?.scope ?? null,
  };
}

/* ------------------------------- users -------------------------------- */

router.get("/users", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:read"))) return;
  try {
    sendJson(req, res, paginate(await listUsers(req.apiKeyOwner!.siteId), req));
  } catch (err) {
    sendServerError(res, "manage.users", err);
  }
});

router.get("/users/:id", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:read"))) return;
  try {
    relay(res, await getUserWithAccess(req.apiKeyOwner!.siteId, req.params.id));
  } catch (err) {
    sendServerError(res, "manage.users", err);
  }
});

router.post("/users", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:manage"))) return;
  const body = ManageCreateUserSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid user");
  try {
    relay(res, await createManagedUser(body.data, actorOf(req)));
  } catch (err) {
    sendServerError(res, "manage.users", err);
  }
});

router.patch("/users/:id", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:manage"))) return;
  const body = PatchUserSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid patch");
  try {
    relay(res, await updateUser(req.params.id, body.data, actorOf(req)));
  } catch (err) {
    sendServerError(res, "manage.users", err);
  }
});

router.delete("/users/:id", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:manage"))) return;
  try {
    relay(res, await deleteUser(req.params.id, actorOf(req)));
  } catch (err) {
    sendServerError(res, "manage.users", err);
  }
});

/* ------------------------------- roles -------------------------------- */

router.get("/roles", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:read"))) return;
  try {
    sendJson(req, res, await listRoles(req.apiKeyOwner!.siteId));
  } catch (err) {
    sendServerError(res, "manage.roles", err);
  }
});

router.post("/roles", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:manage"))) return;
  const body = RoleSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid role");
  try {
    relay(res, await createRole(body.data, actorOf(req)));
  } catch (err) {
    sendServerError(res, "manage.roles", err);
  }
});

router.patch("/roles/:id", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:manage"))) return;
  const body = RoleSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid role");
  try {
    relay(res, await updateRole(req.params.id, body.data, actorOf(req)));
  } catch (err) {
    sendServerError(res, "manage.roles", err);
  }
});

router.delete("/roles/:id", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "users:manage"))) return;
  try {
    relay(res, await deleteRole(req.params.id, actorOf(req)));
  } catch (err) {
    sendServerError(res, "manage.roles", err);
  }
});

export default router;
