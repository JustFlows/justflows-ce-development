// SPDX-License-Identifier: MIT

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireRole } from "../../middleware/auth.js";
import { THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { param } from "../../lib/http/params.js";
import { getActiveTheme, getSiteId } from "../../lib/themes/themes-db.js";
import { isTemplateSlug } from "../../lib/themes/theme-templates-store.js";
import {
  getDocumentHistoryDoc,
  isDocumentHistoryKind,
  listDocumentHistory,
  themeTemplateHistoryKey,
  type DocumentHistoryKind,
} from "../../lib/rendering/document-history.js";

/**
 * Version history of the site's header library, footer, widget areas, and
 * template overrides (justflows-ce#302). Read-only: restoring loads an old
 * version into the editor, which saves it through the revision-checked write
 * routes like any other edit.
 *
 * Query: `kind=template_part&key=<part>` (`header`, `footer`, `widgets:<area>`)
 * or `kind=theme_template&key=<slug>` for the active theme.
 */
const router = Router();

const historyLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });

const PART_KEY = /^[a-z0-9][a-z0-9:_-]{0,59}$/;

async function resolveTarget(
  query: Record<string, unknown>,
): Promise<{ siteId: string; kind: DocumentHistoryKind; key: string } | null> {
  const kind = query.kind;
  const key = typeof query.key === "string" ? query.key : "";
  if (!isDocumentHistoryKind(kind)) return null;
  const siteId = await getSiteId();
  if (!siteId) return null;
  if (kind === "template_part") return PART_KEY.test(key) ? { siteId, kind, key } : null;
  if (!isTemplateSlug(key)) return null;
  const theme = await getActiveTheme(siteId);
  return { siteId, kind, key: themeTemplateHistoryKey(theme?.theme_id ?? "justflows.default", key) };
}

router.get("/", historyLimit, requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const target = await resolveTarget(req.query);
  if (!target) {
    res.status(400).json({ error: "Unknown document" });
    return;
  }
  res.json({ items: await listDocumentHistory(target.siteId, target.kind, target.key) });
});

router.get("/:id", historyLimit, requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const target = await resolveTarget(req.query);
  if (!target) {
    res.status(400).json({ error: "Unknown document" });
    return;
  }
  const doc = await getDocumentHistoryDoc(target.siteId, target.kind, target.key, param(req.params.id));
  if (doc === null) {
    res.status(404).json({ error: "Version not found" });
    return;
  }
  res.json({ doc });
});

export default router;
