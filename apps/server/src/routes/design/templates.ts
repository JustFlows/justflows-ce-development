// SPDX-License-Identifier: MIT

import { Router } from "express";
import { z } from "zod";
import { auditLog } from "../../lib/security/audit-log.js";
import { DocumentRevisionConflictError, documentConflictBody } from "../../lib/database/document-revision.js";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES, THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { param } from "../../lib/http/params.js";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { getActiveTheme, getSiteId, themeInstalledPath } from "../../lib/themes/themes-db.js";
import { loadThemeTemplate } from "../../lib/themes/theme-files.js";
import { TEMPLATE_SLOTS } from "../../lib/rendering/template-hierarchy.js";
import { validateTemplateBlocks } from "../../lib/rendering/template-validate.js";
import {
  clearStoredTemplateDraft,
  getStoredTemplateDocs,
  isTemplateSlug,
  listTemplateSlots,
  getStoredTemplateRevision,
  resetStoredTemplate,
  writeStoredTemplate,
} from "../../lib/themes/theme-templates-store.js";

const router = Router();

const SaveSchema = z.object({
  blocks: z.array(z.record(z.string(), z.unknown())),
  draft: z.boolean().default(false),
  /** Revision the editor loaded; `0` = no site override yet. A mismatch is a 409, not an overwrite. */
  expectedRevision: z.number().int().min(0).optional(),
});

async function activeTheme(): Promise<{
  siteId: string;
  themeId: string;
  installedPath: string | null;
} | null> {
  const siteId = await getSiteId();
  if (!siteId) return null;
  const theme = await getActiveTheme(siteId);
  return {
    siteId,
    themeId: theme?.theme_id ?? "justflows.default",
    installedPath: theme ? themeInstalledPath(theme) : null,
  };
}

/** The template slots an editor can create even when neither theme nor site has one. */
const CREATABLE_SLOTS = [...TEMPLATE_SLOTS];

/** All templates for the active theme: which are shipped, customised, drafted. */
router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  const ctx = await activeTheme();
  if (!ctx) {
    res.json({ slots: [], creatable: CREATABLE_SLOTS });
    return;
  }
  const slots = await listTemplateSlots(ctx.siteId, ctx.themeId, ctx.installedPath);
  const known = new Set(slots.map((s) => s.slug));
  res.json({
    themeId: ctx.themeId,
    slots,
    creatable: CREATABLE_SLOTS.filter((slug) => !known.has(slug)),
  });
});

/** One template's editable blocks: the site override, else the theme file as a seed. */
router.get("/:slug", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  const slug = param(req.params.slug);
  if (!isTemplateSlug(slug)) {
    res.status(404).json({ error: "Unknown template slug" });
    return;
  }
  const ctx = await activeTheme();
  if (!ctx) {
    res.json({ blocks: [], draft: [] });
    return;
  }

  const { published, draft } = await getStoredTemplateDocs(ctx.siteId, ctx.themeId, slug);
  const revision = await getStoredTemplateRevision(ctx.siteId, ctx.themeId, slug);
  if (published?.length || draft?.length) {
    res.json({ blocks: published ?? [], draft: draft ?? [], revision });
    return;
  }

  // Never customised — seed the editor from the theme's own file so publishing
  // promotes it to a per-site override.
  const themeBlocks = loadThemeTemplate(ctx.themeId, slug, ctx.installedPath);
  if (themeBlocks?.length) {
    const seeded = sanitizeBlockDocument({ version: 1, blocks: themeBlocks }).blocks;
    res.json({ blocks: seeded, draft: [], fromThemeDefault: true, revision });
    return;
  }
  res.json({ blocks: [], draft: [], fromThemeDefault: true, revision });
});

router.put("/:slug", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const slug = param(req.params.slug);
    if (!isTemplateSlug(slug)) {
      res.status(404).json({ error: "Unknown template slug" });
      return;
    }
    const body = SaveSchema.parse(req.body);
    const ctx = await activeTheme();
    if (!ctx) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const { blocks, revision } = await writeStoredTemplate(ctx.siteId, ctx.themeId, slug, body.blocks, {
      draft: body.draft,
      expectedRevision: body.expectedRevision,
      actorId: req.session?.userId ?? null,
    });
    if (!body.draft) {
      /** Publishing a site-wide part changes every page that shows it. */
      void auditLog({
        siteId: ctx.siteId,
        action: "design.part_published",
        actorId: req.session?.userId ?? null,
        actorRole: req.session?.role ?? null,
        target: `template:${slug}`,
        detail: `revision ${revision}`,
      });
    }
    if (!body.draft) await revalidateOnUpdate("theme");
    // Advisory only — a template may legitimately reference a plugin block that
    // is not installed yet. The editor shows the list; the save still lands.
    const { unknownBlockTypes } = validateTemplateBlocks(blocks);
    res.json({ blocks, unknownBlockTypes, revision });
  } catch (err) {
    if (err instanceof DocumentRevisionConflictError) {
      res.status(409).json(documentConflictBody(err));
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

/** Discard the working draft, keeping the published override. */
router.post("/:slug/discard-draft", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const slug = param(req.params.slug);
  if (!isTemplateSlug(slug)) {
    res.status(404).json({ error: "Unknown template slug" });
    return;
  }
  const ctx = await activeTheme();
  if (!ctx) {
    res.status(503).json({ error: "No site found" });
    return;
  }
  await clearStoredTemplateDraft(ctx.siteId, ctx.themeId, slug);
  res.json({ ok: true });
});

/** Reset the template to the theme's own file (drops the override entirely). */
router.delete("/:slug", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const slug = param(req.params.slug);
  if (!isTemplateSlug(slug)) {
    res.status(404).json({ error: "Unknown template slug" });
    return;
  }
  const ctx = await activeTheme();
  if (!ctx) {
    res.status(503).json({ error: "No site found" });
    return;
  }
  await resetStoredTemplate(ctx.siteId, ctx.themeId, slug);
  void auditLog({
    siteId: ctx.siteId,
    action: "design.part_reset",
    actorId: req.session?.userId ?? null,
    actorRole: req.session?.role ?? null,
    target: `template:${slug}`,
  });
  await revalidateOnUpdate("theme");
  res.json({ ok: true });
});

export default router;
