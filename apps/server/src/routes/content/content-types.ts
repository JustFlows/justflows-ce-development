// SPDX-License-Identifier: MIT

import { Router } from "express";
import { z } from "zod";
import {
  ContentTypeFieldsSchema,
  ContentTypeSlugSchema,
  normalizeContentTypeSlug,
} from "@justflows/content";
import {
  createContentType,
  deleteContentType,
  ensureBuiltinContentTypes,
  getContentTypeBySlug,
  listContentTypes,
  updateContentType,
} from "../../lib/content/content-types-db.js";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES } from "../../lib/auth/rbac.js";
import { getRuntimeHooks } from "../../lib/plugins/plugin-runtime.js";
import { param } from "../../lib/http/params.js";
import { sendServerError } from "../../lib/http/send-error.js";

const router = Router();

const CreateSchema = z.object({
  slug: ContentTypeSlugSchema,
  label: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  fields: ContentTypeFieldsSchema.optional(),
});

const PatchSchema = z.object({
  label: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  fields: ContentTypeFieldsSchema.optional(),
});

router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  try {
    const types = await listContentTypes();
    res.json({ types });
  } catch (err) {
    sendServerError(res, "content-types", err);
  }
});

router.get("/:slug", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    const session = req.session!;
    const type = await getContentTypeBySlug(param(req.params.slug));
    if (!type) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const seeded = type.slug === "page" ? "blocks" : "fields";
    const editor = await getRuntimeHooks().applyFilter(
      "content.editor",
      seeded,
      { siteId: session.siteId, type: type.slug },
      { siteId: session.siteId, source: "http" },
    );
    res.json({ type: { ...type, editor: editor === "blocks" ? "blocks" : "fields" } });
  } catch (err) {
    sendServerError(res, "content-types", err);
  }
});

router.post("/", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const body = CreateSchema.safeParse({
    ...req.body,
    slug: typeof req.body?.slug === "string" ? normalizeContentTypeSlug(req.body.slug) : req.body?.slug,
  });
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message });
    return;
  }

  try {
    await ensureBuiltinContentTypes(session.siteId);
    const type = await createContentType(session.siteId, body.data);
    res.status(201).json({ type });
  } catch (err) {
    const message = String(err);
    const status = message.includes("UNIQUE") || message.toLowerCase().includes("duplicate") ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

router.patch("/:slug", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  const body = PatchSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message });
    return;
  }

  try {
    const type = await updateContentType(session.siteId, param(req.params.slug), body.data);
    res.json({ type });
  } catch (err) {
    const message = String(err);
    res.status(message.includes("not found") ? 404 : 400).json({ error: message });
  }
});

router.delete("/:slug", requireRole("administrator"), async (req, res) => {
  const session = req.session!;
  try {
    await deleteContentType(session.siteId, param(req.params.slug));
    res.json({ ok: true });
  } catch (err) {
    const message = String(err);
    const status = message.includes("not found")
      ? 404
      : message.includes("still has entries") || message.includes("built-in")
        ? 409
        : 400;
    res.status(status).json({ error: message });
  }
});

export default router;
