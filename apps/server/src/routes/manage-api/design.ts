// SPDX-License-Identifier: MIT

import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { PatternSetSchema } from "@justflows/sdk";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { getDb } from "../../lib/database/db.js";
import { listContentTypes } from "../../lib/content/content-types-db.js";
import { getBlogPageId, setBlogPageId } from "../../lib/content/blog-page.js";
import { getHomePageId, setHomePageId } from "../../lib/content/home-page.js";
import { normalizeBlocks } from "../../lib/content/content-api.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { param } from "../../lib/http/params.js";
import { getActiveLocaleCodes, getDefaultLocale } from "../../lib/i18n/languages-db.js";
import {
  PermalinkConflictError,
  getPermalinkState,
  savePermalinks,
} from "../../lib/navigation/permalinks-db.js";
import { PERMALINK_PRESETS, PermalinkSettingsSchema } from "../../lib/navigation/permalinks.js";
import { getPluginLoader } from "../../lib/plugins/plugin-runtime.js";
import { listHeaderTemplates } from "../../lib/rendering/header-templates.js";
import {
  ErrorPageConfigSchema,
  getErrorPageConfig,
  listErrorPagePickerOptions,
  PICKER_ERROR_CLASSES,
  setErrorPageConfig,
} from "../../lib/rendering/error-pages.js";
import {
  deleteReusableBlock,
  listReusableBlocks,
  saveReusableBlock,
} from "../../lib/rendering/reusable-blocks.js";
import {
  deleteSitePattern,
  exportPatternSet,
  importPatternSet,
  listSitePatterns,
  saveSitePattern,
} from "../../lib/rendering/site-patterns.js";
import {
  getSiteHeaderLibrary,
  hasSiteHeaderLibraryDraft,
  listSiteHeaderOptions,
  parseSiteHeaderLibrary,
  publishSiteHeaderLibrary,
  saveSiteHeaderLibrary,
  type SiteHeaderLibrary,
} from "../../lib/rendering/site-header.js";
import {
  getTemplatePart,
  isTemplatePart,
  publishTemplatePart,
  saveTemplatePart,
} from "../../lib/rendering/template-parts.js";
import {
  clearWidgetAreaDraft,
  getWidgetLayout,
  readWidgetAreaForEditor,
  saveWidgetAreaDoc,
  saveWidgetLayout,
  summarizeWidgetAreas,
  widgetAreaExists,
  WIDGET_AREA_POSITIONS,
} from "../../lib/rendering/widget-areas.js";
import { listLayoutScopes } from "../../lib/themes/layout-scopes.js";
import { loadThemeDemoFooter, listThemePatterns, loadThemePattern, loadThemeTemplate } from "../../lib/themes/theme-files.js";
import {
  clearThemeBlogDraft,
  defaultBlogBlocksFromTheme,
  getEffectiveBlogBlocks,
  getThemeBlogBlocks,
  publishThemeBlogBlocks,
  saveThemeBlogBlocks,
} from "../../lib/themes/theme-blog-blocks.js";
import {
  clearThemeDraft,
  defaultModsFromSchema,
  getCustomizeSchema,
  getSiteIdentity,
  getThemeMods,
  mergeMods,
  publishThemeMods,
  saveThemeMods,
  schemaWithThemeControls,
  type ThemeMods,
} from "../../lib/themes/theme-customize.js";
import {
  clearThemeHomeDraft,
  defaultHomeBlocksFromTheme,
  getEffectiveHomeBlocks,
  getThemeHomeBlocks,
  publishThemeHomeBlocks,
  saveThemeHomeBlocks,
} from "../../lib/themes/theme-home-blocks.js";
import {
  ensureThemesTable,
  getActiveTheme,
  syncBundledThemes,
  themeInstalledPath,
} from "../../lib/themes/themes-db.js";
import {
  clearStoredTemplateDraft,
  getStoredTemplateDocs,
  isTemplateSlug,
  listTemplateSlots,
  publishStoredTemplate,
  resetStoredTemplate,
  saveStoredTemplate,
} from "../../lib/themes/theme-templates-store.js";
import { TEMPLATE_SLOTS } from "../../lib/rendering/template-hierarchy.js";
import { validateTemplateBlocks } from "../../lib/rendering/template-validate.js";
import { auditFromRequest } from "../../lib/security/audit-log.js";
import { clientIp } from "../../lib/security/rate-limit.js";
import { badRequest, ensureKeyCan, sendJson } from "./envelope.js";

/**
 * Site chrome the admin edits outside a content entry: the header library,
 * the footer and other template parts, page templates, theme appearance,
 * reusable blocks, patterns, error pages, and permalinks.
 *
 * Each handler calls the same service the cookie route uses. The key's site
 * is `req.apiKeyOwner.siteId` (the dispatch also re-enters that site's
 * database, which the theme services read through `getSiteId()`).
 */

const router = Router();

/** Theme files are read off disk; CodeQL only treats express-rate-limit as a limiter. */
const fileLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `manage-design:${req.apiKey?.id ?? clientIp(req)}`,
});

function siteId(req: Request): string {
  return req.apiKeyOwner!.siteId;
}

const LibrarySchema = z.object({
  library: z.record(z.string(), z.unknown()),
  draft: z.boolean().default(false),
});

const PartSchema = z.object({
  blocks: z.array(z.record(z.string(), z.unknown())),
  draft: z.boolean().default(false),
});

const TemplateSaveSchema = z.object({
  blocks: z.array(z.record(z.string(), z.unknown())),
  draft: z.boolean().default(false),
});

const ReusableSaveSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().max(120).optional(),
  blocks: z.array(z.record(z.string(), z.unknown())),
});

const PatternSaveSchema = z.object({ synced: z.boolean().default(false) }).catchall(z.unknown());

const ModSection = z.record(z.string(), z.union([z.string(), z.number()])).optional();
const ModsSchema = z
  .object({
    identity: ModSection,
    colors: ModSection,
    colorsDark: ModSection,
    typography: ModSection,
    headings: ModSection,
    spacing: ModSection,
    radius: ModSection,
    shadow: ModSection,
    layout: ModSection,
    navigation: ModSection,
    advanced: ModSection,
  })
  .catchall(z.record(z.string(), z.union([z.string(), z.number()])));

const BlockDocumentSchema = z.object({
  version: z.literal(1).default(1),
  blocks: z.array(z.record(z.string(), z.unknown())),
});

const CustomizePatchSchema = z.object({
  mods: ModsSchema.optional(),
  blocks: BlockDocumentSchema.optional(),
  homePageId: z.string().uuid().nullable().optional(),
  blogBlocks: BlockDocumentSchema.optional(),
  blogPageId: z.string().uuid().nullable().optional(),
  draft: z.boolean().default(true),
  publish: z.boolean().default(false),
});

async function sanitizeLibrary(input: unknown, id: string): Promise<SiteHeaderLibrary> {
  const active = new Set(await getActiveLocaleCodes(id));
  const lib = parseSiteHeaderLibrary(input);
  for (const entry of lib.entries) {
    for (const locale of Object.keys(entry.overrides)) {
      if (!active.has(locale)) delete entry.overrides[locale];
    }
  }
  return lib;
}

async function activeTheme(id: string): Promise<{
  themeId: string;
  installedPath: string | null;
} | null> {
  const theme = await getActiveTheme(id);
  if (!theme && !id) return null;
  return {
    themeId: theme?.theme_id ?? "justflows.default",
    installedPath: theme ? themeInstalledPath(theme) : null,
  };
}

function localeQuery(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value) ? value : undefined;
}

/* -------------------------------- headers ------------------------------- */

router.get("/headers", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    const id = siteId(req);
    sendJson(req, res, {
      library: await getSiteHeaderLibrary(id, false),
      draft: (await hasSiteHeaderLibraryDraft(id)) ? await getSiteHeaderLibrary(id, true) : null,
    });
  } catch (err) {
    sendServerError(res, "manage.headers", err);
  }
});

router.get("/headers/options", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    const id = siteId(req);
    const preview = req.query.preview === "1" || req.query.preview === "true";
    const [own, defaultLocale] = await Promise.all([
      listSiteHeaderOptions(id, preview),
      getDefaultLocale(id),
    ]);
    const templates = await listHeaderTemplates(id, defaultLocale, defaultLocale);
    sendJson(req, res, { ...own, templates });
  } catch (err) {
    sendServerError(res, "manage.headers", err);
  }
});

router.put("/headers", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = LibrarySchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid header library");
  try {
    const id = siteId(req);
    const lib = await sanitizeLibrary(body.data.library, id);
    const library = body.data.draft
      ? await saveSiteHeaderLibrary(id, lib, true)
      : await publishSiteHeaderLibrary(id, lib);
    if (!body.data.draft) await revalidateOnUpdate("theme");
    res.json({ library });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

/* ----------------------------- template parts --------------------------- */

router.get("/template-parts/:part", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  const part = param(req.params.part);
  if (!isTemplatePart(part)) {
    res.status(404).json({ error: "Unknown template part" });
    return;
  }
  try {
    const id = siteId(req);
    const blocks = await getTemplatePart(id, part, false);
    const draft = await getTemplatePart(id, part, true);
    if (part === "footer" && blocks.length === 0 && draft.length === 0) {
      const theme = await getActiveTheme(id);
      const themeFooter = theme ? loadThemeDemoFooter(theme.theme_id, themeInstalledPath(theme)) : null;
      if (themeFooter?.length) {
        const seeded = sanitizeBlockDocument({ version: 1, blocks: themeFooter }).blocks;
        sendJson(req, res, { blocks: seeded, draft: [], fromThemeDefault: true });
        return;
      }
    }
    sendJson(req, res, { blocks, draft });
  } catch (err) {
    sendServerError(res, "manage.template-parts", err);
  }
});

router.put("/template-parts/:part", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const part = param(req.params.part);
  if (!isTemplatePart(part)) {
    res.status(404).json({ error: "Unknown template part" });
    return;
  }
  const body = PartSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid template part");
  try {
    const id = siteId(req);
    const blocks = body.data.draft
      ? await saveTemplatePart(id, part, body.data.blocks, true)
      : await publishTemplatePart(id, part, body.data.blocks);
    if (!body.data.draft) await revalidateOnUpdate("theme");
    res.json({ blocks });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

/* ------------------------------ widget areas ----------------------------- */

const WidgetBlocksSchema = z.array(z.record(z.string(), z.unknown()));

const WidgetAreaSaveSchema = z.object({
  blocks: WidgetBlocksSchema,
  locales: z.record(z.string().max(35), WidgetBlocksSchema).default({}),
  draft: z.boolean().default(false),
});

const WidgetLayoutSchema = z.object({
  layout: z.record(
    z.string().max(60),
    z.object({
      area: z.string().max(32).nullable(),
      position: z.enum(WIDGET_AREA_POSITIONS as [string, ...string[]]),
    }),
  ),
});

router.get("/widgets", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    const id = siteId(req);
    const [areas, layout, types] = await Promise.all([
      summarizeWidgetAreas(id),
      getWidgetLayout(id),
      listContentTypes(id),
    ]);
    sendJson(req, res, {
      areas,
      layout,
      contentTypes: types.map((type) => ({ slug: type.slug, label: type.label })),
      positions: WIDGET_AREA_POSITIONS,
    });
  } catch (err) {
    sendServerError(res, "manage.widgets", err);
  }
});

router.put("/widgets/layout", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = WidgetLayoutSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid widget layout");
  try {
    const layout = await saveWidgetLayout(siteId(req), body.data.layout);
    await revalidateOnUpdate("theme");
    res.json({ layout });
  } catch (err) {
    sendServerError(res, "manage.widgets.layout", err);
  }
});

router.get("/widgets/areas/:key", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    const found = await readWidgetAreaForEditor(siteId(req), param(req.params.key));
    if (!found) {
      res.status(404).json({ error: "Unknown widget area" });
      return;
    }
    sendJson(req, res, found);
  } catch (err) {
    sendServerError(res, "manage.widgets.area", err);
  }
});

router.put("/widgets/areas/:key", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = WidgetAreaSaveSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid widget area");
  try {
    const id = siteId(req);
    const key = param(req.params.key);
    if (!(await widgetAreaExists(id, key))) {
      res.status(404).json({ error: "Unknown widget area" });
      return;
    }
    const { draft, ...doc } = body.data;
    const saved = await saveWidgetAreaDoc(id, key, doc, draft ? "draft" : "publish");
    if (!draft) await revalidateOnUpdate("theme");
    res.json({ doc: saved });
  } catch (err) {
    sendServerError(res, "manage.widgets.area", err);
  }
});

router.post("/widgets/areas/:key/discard-draft", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  try {
    const id = siteId(req);
    const key = param(req.params.key);
    if (!(await widgetAreaExists(id, key))) {
      res.status(404).json({ error: "Unknown widget area" });
      return;
    }
    await clearWidgetAreaDraft(id, key);
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "manage.widgets.area", err);
  }
});

/* ------------------------------- templates ------------------------------ */

router.get("/templates", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    const id = siteId(req);
    const theme = await activeTheme(id);
    if (!theme) {
      sendJson(req, res, { slots: [], creatable: [...TEMPLATE_SLOTS] });
      return;
    }
    const slots = await listTemplateSlots(id, theme.themeId, theme.installedPath);
    const known = new Set(slots.map((slot) => slot.slug));
    sendJson(req, res, {
      themeId: theme.themeId,
      slots,
      creatable: TEMPLATE_SLOTS.filter((slug) => !known.has(slug)),
    });
  } catch (err) {
    sendServerError(res, "manage.templates", err);
  }
});

router.get("/templates/:slug", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  const slug = param(req.params.slug);
  if (!isTemplateSlug(slug)) {
    res.status(404).json({ error: "Unknown template slug" });
    return;
  }
  try {
    const id = siteId(req);
    const theme = await activeTheme(id);
    if (!theme) {
      sendJson(req, res, { blocks: [], draft: [] });
      return;
    }
    const { published, draft } = await getStoredTemplateDocs(id, theme.themeId, slug);
    if (published?.length || draft?.length) {
      sendJson(req, res, { blocks: published ?? [], draft: draft ?? [] });
      return;
    }
    const themeBlocks = loadThemeTemplate(theme.themeId, slug, theme.installedPath);
    if (themeBlocks?.length) {
      const seeded = sanitizeBlockDocument({ version: 1, blocks: themeBlocks }).blocks;
      sendJson(req, res, { blocks: seeded, draft: [], fromThemeDefault: true });
      return;
    }
    sendJson(req, res, { blocks: [], draft: [], fromThemeDefault: true });
  } catch (err) {
    sendServerError(res, "manage.templates", err);
  }
});

router.put("/templates/:slug", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const slug = param(req.params.slug);
  if (!isTemplateSlug(slug)) {
    res.status(404).json({ error: "Unknown template slug" });
    return;
  }
  const body = TemplateSaveSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid template");
  try {
    const id = siteId(req);
    const theme = await activeTheme(id);
    if (!theme) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const blocks = body.data.draft
      ? await saveStoredTemplate(id, theme.themeId, slug, body.data.blocks, true)
      : await publishStoredTemplate(id, theme.themeId, slug, body.data.blocks);
    if (!body.data.draft) await revalidateOnUpdate("theme");
    const { unknownBlockTypes } = validateTemplateBlocks(blocks);
    res.json({ blocks, unknownBlockTypes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

router.post("/templates/:slug/discard-draft", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const slug = param(req.params.slug);
  if (!isTemplateSlug(slug)) {
    res.status(404).json({ error: "Unknown template slug" });
    return;
  }
  try {
    const id = siteId(req);
    const theme = await activeTheme(id);
    if (!theme) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    await clearStoredTemplateDraft(id, theme.themeId, slug);
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "manage.templates", err);
  }
});

router.delete("/templates/:slug", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const slug = param(req.params.slug);
  if (!isTemplateSlug(slug)) {
    res.status(404).json({ error: "Unknown template slug" });
    return;
  }
  try {
    const id = siteId(req);
    const theme = await activeTheme(id);
    if (!theme) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    await resetStoredTemplate(id, theme.themeId, slug);
    await revalidateOnUpdate("theme");
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "manage.templates", err);
  }
});

/* ---------------------------- theme customize --------------------------- */

router.get("/themes/customize", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    await ensureThemesTable();
    const id = siteId(req);
    await syncBundledThemes(id);
    const theme = await getActiveTheme(id);
    if (!theme) {
      res.status(404).json({ error: "No active theme — activate a theme first" });
      return;
    }
    const defaults = defaultModsFromSchema(
      schemaWithThemeControls(theme.manifest),
      theme.css_variables,
    );
    const published = (await getThemeMods(theme.theme_id, false)) ?? {};
    const draft = (await getThemeMods(theme.theme_id, true)) ?? {};
    const effective = mergeMods(mergeMods(defaults, published), draft);
    const identity = await getSiteIdentity(effective);
    effective.identity = { ...effective.identity, siteTitle: identity.siteTitle, tagline: identity.tagline };
    const homeDraft = (await getThemeHomeBlocks(theme.theme_id, true)) ?? null;
    const homePublished = (await getThemeHomeBlocks(theme.theme_id, false)) ?? null;
    const blogDraft = (await getThemeBlogBlocks(theme.theme_id, true)) ?? null;
    const blogPublished = (await getThemeBlogBlocks(theme.theme_id, false)) ?? null;
    const db = await getDb();
    const pageRows = await db.query<{ id: string; title: string; slug: string; locale: string; status: string }>(
      "SELECT id, title, slug, locale, status FROM content WHERE site_id = ? AND type = 'page' ORDER BY title ASC",
      [id],
    );
    sendJson(req, res, {
      theme: { id: theme.theme_id, name: theme.name, version: theme.version },
      schema: await getCustomizeSchema(id),
      mods: effective,
      blocks: await getEffectiveHomeBlocks(theme.theme_id, true),
      defaultBlocks: defaultHomeBlocksFromTheme(theme.theme_id),
      published: mergeMods(defaults, published),
      publishedBlocks: homePublished?.blocks.length ? homePublished : null,
      hasDraft: Object.keys(draft).length > 0 || Boolean(homeDraft?.blocks.length) || Boolean(blogDraft?.blocks.length),
      homePageId: await getHomePageId(id),
      blogBlocks: await getEffectiveBlogBlocks(theme.theme_id, true),
      defaultBlogBlocks: defaultBlogBlocksFromTheme(theme.theme_id),
      publishedBlogBlocks: blogPublished?.blocks.length ? blogPublished : null,
      blogPageId: await getBlogPageId(id),
      layoutScopes: await listLayoutScopes(id),
      pages: pageRows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        slug: String(row.slug),
        locale: String(row.locale ?? "en-US"),
        status: String(row.status),
      })),
    });
  } catch (err) {
    sendServerError(res, "manage.themes", err);
  }
});

router.patch("/themes/customize", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = CustomizePatchSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid theme settings");
  try {
    await ensureThemesTable();
    const id = siteId(req);
    const theme = await getActiveTheme(id);
    if (!theme) {
      res.status(404).json({ error: "No active theme" });
      return;
    }
    const defaults = defaultModsFromSchema(
      schemaWithThemeControls(theme.manifest),
      theme.css_variables,
    );
    const published = (await getThemeMods(theme.theme_id, false)) ?? {};
    const base = mergeMods(defaults, published);
    const currentMods = mergeMods(base, (await getThemeMods(theme.theme_id, true)) ?? {});
    const mods = body.data.mods ? mergeMods(base, body.data.mods as ThemeMods) : currentMods;
    const blocks = body.data.blocks ? normalizeBlocks(body.data.blocks) : await getEffectiveHomeBlocks(theme.theme_id, true);
    const homePageId =
      body.data.homePageId !== undefined ? await setHomePageId(id, body.data.homePageId) : await getHomePageId(id);
    const blogBlocks = body.data.blogBlocks
      ? normalizeBlocks(body.data.blogBlocks)
      : await getEffectiveBlogBlocks(theme.theme_id, true);
    const blogPageId =
      body.data.blogPageId !== undefined ? await setBlogPageId(id, body.data.blogPageId) : await getBlogPageId(id);
    if (body.data.publish) {
      await publishThemeMods(theme.theme_id, mods);
      await publishThemeHomeBlocks(theme.theme_id, blocks);
      await publishThemeBlogBlocks(theme.theme_id, blogBlocks);
      await revalidateOnUpdate("theme");
      res.json({ ok: true, published: true, mods, blocks, homePageId, blogBlocks, blogPageId });
      return;
    }
    await saveThemeMods(theme.theme_id, mods, body.data.draft);
    await saveThemeHomeBlocks(theme.theme_id, blocks, body.data.draft);
    await saveThemeBlogBlocks(theme.theme_id, blogBlocks, body.data.draft);
    await revalidateOnUpdate("theme");
    res.json({ ok: true, published: false, mods, blocks, homePageId, blogBlocks, blogPageId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save";
    res.status(message.includes("Custom CSS") ? 400 : 500).json({ error: message });
  }
});

router.delete("/themes/customize", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  try {
    const id = siteId(req);
    const theme = await getActiveTheme(id);
    if (!theme) {
      res.status(404).json({ error: "No active theme" });
      return;
    }
    await clearThemeDraft(theme.theme_id);
    await clearThemeHomeDraft(theme.theme_id);
    await clearThemeBlogDraft(theme.theme_id);
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "manage.themes", err);
  }
});

/* ---------------------------- reusable blocks --------------------------- */

router.get("/reusable-blocks", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    sendJson(req, res, { items: await listReusableBlocks(siteId(req)) });
  } catch (err) {
    sendServerError(res, "manage.reusable-blocks", err);
  }
});

router.put("/reusable-blocks", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = ReusableSaveSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid reusable block");
  try {
    const item = await saveReusableBlock(siteId(req), body.data);
    await revalidateOnUpdate("content");
    res.json({ item });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

router.delete("/reusable-blocks/:id", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  try {
    await deleteReusableBlock(siteId(req), param(req.params.id));
    await revalidateOnUpdate("content");
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "manage.reusable-blocks", err);
  }
});

/* -------------------------------- patterns ------------------------------ */

router.get("/patterns", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    const id = siteId(req);
    const locale = localeQuery(req.query.locale);
    const theme = await activeTheme(id);
    const themePatterns = listThemePatterns(theme?.themeId ?? "justflows.default", theme?.installedPath ?? null, locale);
    const sitePatterns = await listSitePatterns(id, locale);
    const pluginPatterns = (getPluginLoader()?.patternRegistry.all() ?? []).map((registered) => {
      const { blocks: _blocks, locales: _locales, pluginId: _pluginId, registryId, ...meta } = registered;
      return { ...meta, id: registryId, source: "plugin" as const };
    });
    sendJson(req, res, {
      patterns: [
        ...sitePatterns.map(({ blocks: _blocks, locales: _locales, ...meta }) => meta),
        ...themePatterns,
        ...pluginPatterns,
      ],
    });
  } catch (err) {
    sendServerError(res, "manage.patterns", err);
  }
});

router.get("/patterns/export", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  try {
    sendJson(req, res, await exportPatternSet(siteId(req)));
  } catch (err) {
    sendServerError(res, "manage.patterns", err);
  }
});

router.post("/patterns/import", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = PatternSetSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid pattern set");
  try {
    res.json({ patterns: await importPatternSet(siteId(req), body.data) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid pattern set" });
  }
});

router.put("/patterns", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = PatternSaveSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Could not save pattern");
  try {
    res.json({ pattern: await saveSitePattern(siteId(req), body.data) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save pattern" });
  }
});

router.get("/patterns/:source/:id", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  const source = param(req.params.source);
  const patternId = param(req.params.id);
  const locale = localeQuery(req.query.locale);
  try {
    const id = siteId(req);
    const theme = await activeTheme(id);
    if (source === "theme" && theme) {
      const pattern = loadThemePattern(theme.themeId, patternId, theme.installedPath, locale);
      if (!pattern) {
        res.status(404).json({ error: "Pattern not found" });
        return;
      }
      sendJson(req, res, { pattern });
      return;
    }
    if (source === "site") {
      const pattern = (await listSitePatterns(id, locale)).find((item) => item.id === patternId);
      if (!pattern) {
        res.status(404).json({ error: "Pattern not found" });
        return;
      }
      sendJson(req, res, { pattern });
      return;
    }
    if (source === "plugin") {
      const registered = getPluginLoader()?.patternRegistry.get(patternId);
      if (!registered) {
        res.status(404).json({ error: "Pattern not found" });
        return;
      }
      sendJson(req, res, {
        pattern: {
          ...registered,
          id: registered.registryId,
          source,
          blocks: sanitizeBlockDocument({ version: 1, blocks: registered.blocks }).blocks,
        },
      });
      return;
    }
    res.status(404).json({ error: "Pattern not found" });
  } catch (err) {
    sendServerError(res, "manage.patterns", err);
  }
});

router.delete("/patterns/:id", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  try {
    await deleteSitePattern(siteId(req), param(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "manage.patterns", err);
  }
});

/* ------------------------------ error pages ----------------------------- */

router.get("/error-pages", fileLimit, async (req, res) => {
  if (!(await ensureKeyCan(req, res, "content:read"))) return;
  try {
    const id = siteId(req);
    const theme = await activeTheme(id);
    const config = await getErrorPageConfig(id);
    const slots = theme ? await listTemplateSlots(id, theme.themeId, theme.installedPath) : [];
    const themeSlots = slots
      .filter((slot) => (PICKER_ERROR_CLASSES as readonly string[]).includes(slot.slug) || slot.slug === "error")
      .map((slot) => slot.slug);
    sendJson(req, res, { config, themeSlots, pages: await listErrorPagePickerOptions(id) });
  } catch (err) {
    sendServerError(res, "manage.error-pages", err);
  }
});

router.put("/error-pages", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = ErrorPageConfigSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid error page settings");
  try {
    const config = await setErrorPageConfig(siteId(req), body.data);
    res.json({ ok: true, config });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save" });
  }
});

/* ------------------------------- permalinks ----------------------------- */

router.get("/permalinks", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:read"))) return;
  try {
    const id = siteId(req);
    const state = await getPermalinkState(id);
    const db = await getDb();
    const taxonomies = await db.query<{ slug: string; name: string }>(
      "SELECT slug, name FROM taxonomies WHERE site_id = ? ORDER BY slug",
      [id],
    );
    sendJson(req, res, { ...state, presets: PERMALINK_PRESETS, types: await listContentTypes(id), taxonomies });
  } catch (err) {
    sendServerError(res, "manage.permalinks", err);
  }
});

router.put("/permalinks", async (req, res) => {
  if (!(await ensureKeyCan(req, res, "settings:manage"))) return;
  const body = PermalinkSettingsSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, body.error.issues[0]?.message ?? "Invalid permalinks");
  try {
    const redirectsCreated = await savePermalinks(siteId(req), body.data);
    auditFromRequest(req, "settings.changed", { detail: "permalinks" });
    res.json({ ok: true, redirectsCreated });
  } catch (err) {
    if (err instanceof PermalinkConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    sendServerError(res, "manage.permalinks", err);
  }
});

export default router;
