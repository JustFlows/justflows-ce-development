// SPDX-License-Identifier: MIT

import { auditFromRequest } from "../../lib/security/audit-log.js";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES, THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { param } from "../../lib/http/params.js";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { clientIp } from "../../lib/security/rate-limit.js";
import { getSiteId } from "../../lib/themes/themes-db.js";
import { listContentTypes } from "../../lib/content/content-types-db.js";
import { getActiveLocaleCodes, getDefaultLocale } from "../../lib/i18n/languages-db.js";
import { listMenus } from "../../lib/navigation/menus-db.js";
import { sendServerError } from "../../lib/http/send-error.js";
import {
  clearWidgetAreaDraft,
  createSiteWidgetArea,
  deleteSiteWidgetArea,
  WidgetAreaError,
  getWidgetLayout,
  readWidgetAreaForEditor,
  saveWidgetAreaDoc,
  saveWidgetLayout,
  summarizeWidgetAreas,
  widgetAreaExists,
  WIDGET_AREA_POSITIONS,
} from "../../lib/rendering/widget-areas.js";

/**
 * Appearance → Widgets: the site's widget areas, their blocks
 * (base plus per-locale overrides, draft and published), and which area each
 * content type shows.
 */
const router = Router();

/** Listing areas reads the active theme's manifest off disk. */
const widgetsLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `widgets:${clientIp(req)}`,
});

router.use(widgetsLimit);

const BlocksSchema = z.array(z.record(z.string(), z.unknown()));

const AreaSaveSchema = z.object({
  blocks: BlocksSchema,
  locales: z.record(z.string().max(35), BlocksSchema).default({}),
  width: z.number().int().min(160).max(640).nullable().default(null),
  draft: z.boolean().default(false),
});

const LayoutSaveSchema = z.object({
  layout: z.record(
    z.string().max(60),
    z.object({
      area: z.string().max(32).nullable(),
      position: z.enum(WIDGET_AREA_POSITIONS as [string, ...string[]]),
    }),
  ),
});

/** Everything the Widgets screen needs to start: areas, layout, types, locales. */
router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.json({ areas: [], layout: {}, contentTypes: [], locales: [], defaultLocale: "en", positions: WIDGET_AREA_POSITIONS });
    return;
  }
  const [areas, layout, types, locales, defaultLocale] = await Promise.all([
    summarizeWidgetAreas(siteId),
    getWidgetLayout(siteId),
    listContentTypes(siteId),
    getActiveLocaleCodes(siteId),
    getDefaultLocale(siteId),
  ]);
  res.json({
    areas,
    layout,
    contentTypes: types.map((type) => ({ slug: type.slug, label: type.label })),
    locales,
    defaultLocale,
    positions: WIDGET_AREA_POSITIONS,
  });
});

router.put("/layout", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const body = LayoutSaveSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid layout" });
    return;
  }
  const siteId = await getSiteId();
  if (!siteId) {
    res.status(503).json({ error: "No site found" });
    return;
  }
  const layout = await saveWidgetLayout(siteId, body.data.layout);
  await revalidateOnUpdate("theme");
  auditFromRequest(req, "design.widgets_published", { siteId, target: "layout" });
  res.json({ layout });
});

const AreaCreateSchema = z.object({
  key: z.string().max(32),
  label: z.string().max(80),
  description: z.string().max(300).optional(),
});

/** Add a widget area of the site's own. */
router.post("/areas", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const body = AreaCreateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid widget area" });
    return;
  }
  const siteId = await getSiteId();
  if (!siteId) {
    res.status(503).json({ error: "No site found" });
    return;
  }
  try {
    res.status(201).json({ area: await createSiteWidgetArea(siteId, body.data) });
  } catch (err) {
    if (err instanceof WidgetAreaError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendServerError(res, "widgets.areas", err);
  }
});

/** Delete a widget area the site added, with its blocks and layout rules. */
router.delete("/areas/:key", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const siteId = await getSiteId();
  if (!siteId) {
    res.status(503).json({ error: "No site found" });
    return;
  }
  try {
    await deleteSiteWidgetArea(siteId, param(req.params.key));
    await revalidateOnUpdate("theme");
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof WidgetAreaError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendServerError(res, "widgets.areas", err);
  }
});

/** Choices for the Menu widget's menu field (`optionsUrl`). */
router.get("/options/menus", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  const siteId = await getSiteId();
  const menus = siteId ? await listMenus(siteId) : [];
  res.json({ options: menus.map((menu) => ({ value: menu.slug, label: menu.name || menu.slug })) });
});

router.get("/areas/:key", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  const siteId = await getSiteId();
  const found = siteId ? await readWidgetAreaForEditor(siteId, param(req.params.key)) : null;
  if (!found) {
    res.status(404).json({ error: "Unknown widget area" });
    return;
  }
  res.json(found);
});

router.put("/areas/:key", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const key = param(req.params.key);
  const body = AreaSaveSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid widget area" });
    return;
  }
  const siteId = await getSiteId();
  if (!siteId || !(await widgetAreaExists(siteId, key))) {
    res.status(404).json({ error: "Unknown widget area" });
    return;
  }
  const { draft, ...doc } = body.data;
  const saved = await saveWidgetAreaDoc(siteId, key, doc, draft ? "draft" : "publish");
  if (!draft) {
    await revalidateOnUpdate("theme");
    auditFromRequest(req, "design.widgets_published", { siteId, target: key });
  }
  res.json({ doc: saved });
});

router.delete("/areas/:key/draft", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const key = param(req.params.key);
  const siteId = await getSiteId();
  if (!siteId || !(await widgetAreaExists(siteId, key))) {
    res.status(404).json({ error: "Unknown widget area" });
    return;
  }
  await clearWidgetAreaDraft(siteId, key);
  res.json({ ok: true });
});

export default router;
