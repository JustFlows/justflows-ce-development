// SPDX-License-Identifier: MIT

import { Router } from "express";
import { z } from "zod";
import { DocumentRevisionConflictError, documentConflictBody } from "../../lib/database/document-revision.js";
import {
  deleteReusableBlock,
  listReusableBlocks,
  saveReusableBlock,
} from "../../lib/rendering/reusable-blocks.js";
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
});

router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.json({ items: [] });
    return;
  }
  res.json({ items: await listReusableBlocks(siteId) });
});

router.put("/", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const body = SaveSchema.parse(req.body);
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const item = await saveReusableBlock(siteId, body);
    // Every page using this block now renders differently.
    await revalidateOnUpdate("content");
    res.json({ item });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

router.delete("/:id", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.status(503).json({ error: "No site found" });
    return;
  }
  await deleteReusableBlock(siteId, param(req.params.id));
  await revalidateOnUpdate("content");
  res.json({ ok: true });
});

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
