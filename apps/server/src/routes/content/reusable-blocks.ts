// SPDX-License-Identifier: MIT

import { Router } from "express";
import { z } from "zod";
import { auditLog } from "../../lib/security/audit-log.js";
import { DocumentRevisionConflictError, documentConflictBody } from "../../lib/database/document-revision.js";
import {
  ReusableSaveError,
  asReusableId,
  deleteReusableBlock,
  discardReusableDraft,
  duplicateReusableBlock,
  getReusableBlock,
  listReusableBlocks,
  publishReusableDraft,
  renameReusableBlock,
  saveReusableBlock,
} from "../../lib/rendering/reusable-blocks.js";
import { reusableUsageFor } from "../../lib/rendering/reusable-usage.js";
import { getEffectiveAccess } from "../../lib/auth/access-policy.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { getActiveTheme, getSiteId, themeInstalledPath } from "../../lib/themes/themes-db.js";
import { loadThemeDemoFooter } from "../../lib/themes/theme-files.js";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES, THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { param } from "../../lib/http/params.js";
import {
  getTemplatePart,
  getTemplatePartRevision,
  isTemplatePart,
  writeTemplatePart,
} from "../../lib/rendering/template-parts.js";

const router = Router();

const SaveSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().max(120).optional(),
  blocks: z.array(z.record(z.string(), z.unknown())),
  /** Save the draft of an existing entry instead of publishing (justflows-ce#304). */
  draft: z.boolean().optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

/** A save error as an HTTP answer. */
function sendSaveError(res: import("express").Response, err: unknown): void {
  if (err instanceof ReusableSaveError) {
    const status = err.code === "revision_conflict" ? 409 : err.code === "not_found" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
}

router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.json({ items: [] });
    return;
  }
  res.json({ items: await listReusableBlocks(siteId) });
});

router.get("/:id", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  const siteId = await getSiteId();
  const item = siteId ? await getReusableBlock(siteId, param(req.params.id)) : null;
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ item });
});

/** Where the block is used, filtered to what this user may open (justflows-ce#304). */
router.get("/:id/usage", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    const id = asReusableId(param(req.params.id));
    if (!siteId || !id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const session = req.session!;
    const access = await getEffectiveAccess(session.userId, siteId, session.role);
    res.json(await reusableUsageFor(siteId, id, { userId: session.userId, access }));
  } catch (err) {
    sendServerError(res, "reusable-blocks", err);
  }
});

router.put("/", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const body = SaveSchema.parse(req.body);
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const item = await saveReusableBlock(siteId, body, {
      draft: body.draft,
      expectedRevision: body.expectedRevision,
      actorId: req.session?.userId ?? null,
    });
    /** A draft only shows in previews; a publish changes every page using the block. */
    if (!(body.draft && item.draft)) {
      await revalidateOnUpdate("content");
      auditReusable(req, siteId, "design.reusable_published", item.id, `revision ${item.revision}`);
    }
    res.json({ item });
  } catch (err) {
    sendSaveError(res, err);
  }
});

router.post("/:id/publish", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const expectedRevision = typeof req.body?.expectedRevision === "number" ? req.body.expectedRevision : undefined;
    const item = await publishReusableDraft(siteId, param(req.params.id), { expectedRevision, actorId: req.session?.userId ?? null });
    if (!item) {
      res.status(409).json({ error: "Nothing to publish", code: "no_draft" });
      return;
    }
    await revalidateOnUpdate("content");
    auditReusable(req, siteId, "design.reusable_published", item.id, `revision ${item.revision}`);
    res.json({ item });
  } catch (err) {
    sendSaveError(res, err);
  }
});

router.post("/:id/discard", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.status(503).json({ error: "No site found" });
    return;
  }
  await discardReusableDraft(siteId, param(req.params.id));
  res.json({ item: await getReusableBlock(siteId, param(req.params.id)) });
});

router.patch("/:id", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const name = z.object({ name: z.string().min(1).max(120) }).parse(req.body).name;
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    res.json({ item: await renameReusableBlock(siteId, param(req.params.id), name) });
  } catch (err) {
    sendSaveError(res, err);
  }
});

router.post("/:id/duplicate", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    res.json({ item: await duplicateReusableBlock(siteId, param(req.params.id), name) });
  } catch (err) {
    sendSaveError(res, err);
  }
});

/**
 * Deleting a block that is still used empties it on every page that uses it,
 * so that needs `?confirm=1`; without it the answer is 409 with the counts.
 */
router.delete("/:id", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const id = param(req.params.id);
    if (req.query.confirm !== "1" && (req.body as { confirm?: unknown } | undefined)?.confirm !== "1") {
      const session = req.session!;
      const usage = await reusableUsageFor(siteId, asReusableId(id) || "-", {
        userId: session.userId,
        access: await getEffectiveAccess(session.userId, siteId, session.role),
      });
      if (usage.total > 0) {
        res.status(409).json({ error: "This reusable block is still used", code: "in_use", usage });
        return;
      }
    }
    await deleteReusableBlock(siteId, id);
    await revalidateOnUpdate("content");
    auditReusable(req, siteId, "design.reusable_deleted", id, "");
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "reusable-blocks", err);
  }
});

function auditReusable(req: import("express").Request, siteId: string, action: "design.reusable_published" | "design.reusable_deleted", target: string, detail: string): void {
  void auditLog({
    siteId,
    action,
    actorId: req.session?.userId ?? null,
    actorRole: req.session?.role ?? null,
    target: `reusable:${target}`,
    detail,
  });
}

export default router;

// ─── Template parts ────────────────────────────────────────────────────────
//
// Site-wide chrome edited as blocks. Mounted here rather than in its own file
// because it shares the same storage shape and the same cache invalidation.

export const templatePartsRouter = Router();

const PartSchema = z.object({
  blocks: z.array(z.record(z.string(), z.unknown())),
  draft: z.boolean().default(false),
  /** Revision the editor loaded; `0` = never saved. A mismatch is a 409, not an overwrite. */
  expectedRevision: z.number().int().min(0).optional(),
});

templatePartsRouter.get("/:part", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  const part = param(req.params.part);
  if (!isTemplatePart(part)) {
    res.status(404).json({ error: "Unknown template part" });
    return;
  }
  const siteId = await getSiteId();
  if (!siteId) {
    res.json({ blocks: [], draft: [] });
    return;
  }
  const blocks = await getTemplatePart(siteId, part, false);
  const draft = await getTemplatePart(siteId, part, true);
  const revision = await getTemplatePartRevision(siteId, part);

  // Nothing customised yet — seed the editor with the active theme's default
  // (`demo/footer.json`), the same starting composition the public site renders.
  // Publishing from the builder promotes it to a real template part.
  if (part === "footer" && blocks.length === 0 && draft.length === 0) {
    const theme = await getActiveTheme(siteId);
    const themeFooter = theme
      ? loadThemeDemoFooter(theme.theme_id, themeInstalledPath(theme))
      : null;
    if (themeFooter?.length) {
      const seeded = sanitizeBlockDocument({ version: 1, blocks: themeFooter }).blocks;
      res.json({ blocks: seeded, draft: [], fromThemeDefault: true, revision });
      return;
    }
  }

  res.json({ blocks, draft, revision });
});

templatePartsRouter.put("/:part", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const part = param(req.params.part);
    if (!isTemplatePart(part)) {
      res.status(404).json({ error: "Unknown template part" });
      return;
    }
    const body = PartSchema.parse(req.body);
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const { blocks, revision } = await writeTemplatePart(siteId, part, body.blocks, {
      draft: body.draft,
      expectedRevision: body.expectedRevision,
      actorId: req.session?.userId ?? null,
    });
    if (!body.draft) {
      /** Publishing a site-wide part changes every page that shows it. */
      void auditLog({
        siteId: siteId,
        action: "design.part_published",
        actorId: req.session?.userId ?? null,
        actorRole: req.session?.role ?? null,
        target: part,
        detail: `revision ${revision}`,
      });
    }
    if (!body.draft) await revalidateOnUpdate("theme");
    res.json({ blocks, revision });
  } catch (err) {
    if (err instanceof DocumentRevisionConflictError) {
      res.status(409).json(documentConflictBody(err));
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});
