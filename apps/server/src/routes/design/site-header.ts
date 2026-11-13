// SPDX-License-Identifier: MIT

import { Router } from "express";
import { z } from "zod";
import { DocumentRevisionConflictError, documentConflictBody } from "../../lib/database/document-revision.js";
import { getSiteId } from "../../lib/themes/themes-db.js";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES, THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { getActiveLocaleCodes, getDefaultLocale } from "../../lib/i18n/languages-db.js";
import { listHeaderTemplates } from "../../lib/rendering/header-templates.js";
import {
  emptyLibrary,
  getSiteHeaderLibrary,
  hasSiteHeaderLibraryDraft,
  listSiteHeaderOptions,
  parseSiteHeaderLibrary,
  getSiteHeaderLibraryRevision,
  writeSiteHeaderLibrary,
  type SiteHeaderLibrary,
} from "../../lib/rendering/site-header.js";

const router = Router();

const LibrarySchema = z.object({
  library: z.record(z.string(), z.unknown()),
  draft: z.boolean().default(false),
  /** Revision the editor loaded; `0` = never saved. A mismatch is a 409, not an overwrite. */
  expectedRevision: z.number().int().min(0).optional(),
});

/** Drop overrides for locales the site no longer serves, then re-normalise. */
async function sanitizeLibrary(input: unknown): Promise<SiteHeaderLibrary> {
  const active = new Set(await getActiveLocaleCodes());
  const lib = parseSiteHeaderLibrary(input);
  for (const entry of lib.entries) {
    for (const locale of Object.keys(entry.overrides)) {
      if (!active.has(locale)) delete entry.overrides[locale];
    }
  }
  return lib;
}

// Full library (published + draft) for the theme customizer.
router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.json({ library: emptyLibrary(), draft: null });
    return;
  }
  res.json({
    library: await getSiteHeaderLibrary(siteId, false),
    draft: (await hasSiteHeaderLibraryDraft(siteId))
      ? await getSiteHeaderLibrary(siteId, true)
      : null,
    revision: await getSiteHeaderLibraryRevision(siteId),
  });
});

// Lightweight options for the per-page header dropdown: the site owner's own
// library entries plus any header designs contributed by plugins/themes.
router.get("/options", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.json({ defaultId: null, items: [], templates: [] });
    return;
  }
  const [own, defaultLocale] = await Promise.all([
    listSiteHeaderOptions(siteId, req.query.preview === "1"),
    getDefaultLocale(siteId),
  ]);
  const templates = await listHeaderTemplates(siteId, defaultLocale, defaultLocale);
  res.json({ ...own, templates });
});

router.put("/", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const body = LibrarySchema.parse(req.body);
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const lib = await sanitizeLibrary(body.library);
    const { library, revision } = await writeSiteHeaderLibrary(siteId, lib, {
      draft: body.draft,
      expectedRevision: body.expectedRevision,
      actorId: req.session?.userId ?? null,
    });
    if (!body.draft) await revalidateOnUpdate("theme");
    res.json({ library, revision });
  } catch (err) {
    if (err instanceof DocumentRevisionConflictError) {
      res.status(409).json(documentConflictBody(err));
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

export default router;
