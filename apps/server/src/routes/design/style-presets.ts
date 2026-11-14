// SPDX-License-Identifier: MIT

import { Router } from "express";
import { z } from "zod";
import { STYLE_PRESET_NAME_MAX } from "@justflows/blocks";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { CONTENT_READ_ROLES, THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { param } from "../../lib/http/params.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { auditLog } from "../../lib/security/audit-log.js";
import {
  deleteStylePreset,
  discardStylePresetDraft,
  listStylePresets,
  publishStylePresets,
  saveStylePreset,
  stylePresetUsage,
  stylePresetsHaveDraft,
} from "../../lib/themes/style-presets.js";
import { getSiteId } from "../../lib/themes/themes-db.js";
import { requireRole } from "../../middleware/auth.js";

/**
 * Site style presets (justflows-ce#301). Reading is open to everyone who can
 * edit content, since any block may reference a preset; changing the library
 * is limited to the roles that customize the theme, like patterns and
 * reusable blocks.
 */
const router = Router();

const SaveSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(STYLE_PRESET_NAME_MAX),
  style: z.record(z.string(), z.unknown()),
});

router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.json({ items: [], published: [], hasDraft: false });
      return;
    }
    const [items, published, hasDraft] = await Promise.all([
      listStylePresets(siteId, { draft: true }),
      listStylePresets(siteId),
      stylePresetsHaveDraft(siteId),
    ]);
    res.json({ items, published, hasDraft });
  } catch (err) {
    sendServerError(res, "style-presets", err);
  }
});

router.put("/", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const body = SaveSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid preset" });
    return;
  }
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const item = await saveStylePreset(siteId, body.data);
    /** The draft only shows in previews, which are not cached. */
    res.json({ item });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

router.delete("/:id", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    await deleteStylePreset(siteId, param(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "style-presets", err);
  }
});

router.get("/:id/usage", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    const id = param(req.params.id);
    if (!siteId || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(await stylePresetUsage(siteId, id));
  } catch (err) {
    sendServerError(res, "style-presets", err);
  }
});

router.post("/publish", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const items = await publishStylePresets(siteId);
    await revalidateOnUpdate("theme");
    void auditLog({
      siteId,
      action: "design.presets_published",
      actorId: req.session!.userId,
      actorRole: req.session!.role,
      target: "style-presets",
      detail: `count=${items.length}`,
    });
    res.json({ items, published: items, hasDraft: false });
  } catch (err) {
    sendServerError(res, "style-presets", err);
  }
});

router.post("/discard", requireRole(...THEME_CUSTOMIZE_ROLES), async (_req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    await discardStylePresetDraft(siteId);
    const items = await listStylePresets(siteId);
    res.json({ items, published: items, hasDraft: false });
  } catch (err) {
    sendServerError(res, "style-presets", err);
  }
});

export default router;
