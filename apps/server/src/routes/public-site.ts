import { verifyContentPreview } from "../lib/content-preview.js";
import { serializeContentRow } from "../lib/content-api.js";
import { rateLimit } from "express-rate-limit";
import { SearchQuerySchema } from "@justflows/content";
import { searchContent } from "../lib/search-db.js";
import { renderSearchPage } from "../lib/search-render.js";
import { esc } from "@justflows/blocks";
import type { ContentResponse } from "../lib/content-api.js";
import { createPermalinkRouter } from "./permalinks.js";
import { Router, type Request, type Response } from "express";
import ejs from "ejs";
import path from "node:path";
import { getPublishedContentBySlug, getTranslationAlternates } from "../lib/content-public.js";
import {
  getActiveLocaleCodes,
  getDefaultLocale,
  listLanguages,
  resolveContentLocale,
} from "../lib/i18n/languages-db.js";
import {
  localePath,
  matchActiveLocale,
  displayLocaleCode,
  localePresentation,
} from "../lib/i18n/locales.js";
import { formatContentDate, getGeneralSettings } from "../lib/general-settings.js";
import { hydrateSiteWidgets } from "../lib/site-widgets.js";
import { applyContentBlocks, applyContentRender } from "../lib/content-render.js";
import { withResponsiveImages } from "../lib/responsive-blocks.js";
import { createTranslator, type MessageCatalog } from "../lib/i18n/translate.js";
import {
  defaultModsFromSchema,
  getNavigationMenuSlugs,
  getSiteIdentity,
  getThemeMods,
  mergeMods,
} from "../lib/theme-customize.js";
import {
  getEffectiveMenuDesign,
  getEffectiveMenuItems,
  getMenuBySlug,
  getNavItemsForMenuSlug,
  menuHasVisibilityRules,
  type MenuDesign,
  type MenuVisibilityContext,
  type ResolvedNavItem,
} from "../lib/menus-db.js";
import { getEffectiveHomeBlocks } from "../lib/theme-home-blocks.js";
import { getHomeContent, isHomeContentSlug } from "../lib/home-page.js";
import {
  headerBrandFlags,
  headerRefFromContentFields,
  resolveHeaderMenuSlug,
  SITE_DEFAULT_HEADER_REF,
  type PageHeaderConfig,
} from "../lib/page-header.js";
import {
  emptyLibrary,
  getEffectiveSiteHeaderLibrary,
  type SiteHeaderLibrary,
} from "../lib/site-header.js";
import { resolveHeaderConfig } from "../lib/header-resolve.js";
import { ensureCssProvidersTable, getActiveCssProvider } from "../lib/css-providers-db.js";
import { resolveProviderAssets } from "../lib/css-providers-files.js";
import {
  ensureThemesTable,
  getActiveTheme,
  getSiteId,
  themeInstalledPath,
} from "../lib/themes-db.js";
import { getDb } from "../lib/db.js";
import { viewsDir } from "../lib/jf-root.js";
import { getJustflowsVersion } from "../lib/version.js";
import { parseLocalePrefix, setLocaleCookie, LOCALE_COOKIE } from "../middleware/locale.js";
import { isPreviewAllowed, resolveSession } from "../lib/auth-session.js";
import {
  canViewUnpublishedSite,
  isSitePublic,
  shouldDiscourageSearchEngines,
} from "../lib/site-visibility.js";
import { getRuntimeHooks } from "../lib/plugin-runtime.js";
import {
  buildSeoHeadHtml,
  buildSitemapXml,
  getSeoSettings,
  resolveSeoTitle,
  seoTextFromContent,
  siteOrigin,
} from "../lib/seo-public.js";
import {
  CSS_PROVIDER_PREFIX,
  getCachedPageHtml,
  MENUS_PREFIX,
  rememberPublic,
  SITE_CTX_PREFIX,
  THEME_MODS_PREFIX,
} from "../lib/public-cache.js";
import { getJfCache } from "../lib/jf-cache.js";
import { getRuntimeBlockRegistry } from "../lib/runtime-blocks.js";
import type { BlockNode } from "../lib/types.js";
import { withBlockChrome } from "@justflows/blocks";
import {
  isGalleryPluginEnabled,
  registerGalleryBlock,
  unregisterGalleryBlock,
} from "../lib/gallery-public.js";
import {
  BLOG_POST_LIST_BLOCK_TYPE,
  registerBlogPostListBlock,
  renderBlogPostListBlockHtml,
  type BlogPostListRenderContext,
} from "../lib/blog-public.js";
import {
  COMMENTS_BLOCK_TYPE,
  registerCommentsBlock,
  renderCommentsBlockHtml,
  type CommentsBannerState,
  type CommentsRenderContext,
} from "../lib/comments-public.js";
import {
  registerTemplateBlocks,
  renderTemplateBlockHtml,
  TEMPLATE_BLOCK_TYPES,
  type TemplateBlockContext,
} from "../lib/template-blocks.js";
import { resolvePublicTemplate, resolveThemePartBlocks } from "../lib/template-render.js";
import type { TemplateQuery } from "../lib/template-hierarchy.js";
import { getSession } from "../lib/session.js";
import { getSiteSetting } from "../lib/site-settings.js";
import { buildFaviconHeadHtml } from "../lib/favicon.js";
import { currentRequestTrace, debugMode, recordCompletedRequestTrace } from "../lib/diagnostics.js";
import { formatCacheSummary, getRequestCacheEvents, pageCacheStatus } from "../lib/cache-trace.js";
import { getAdminPathConfig, toPublicAdminPath } from "../lib/admin-path.js";

const templateDir = viewsDir();
const router = Router();

router.get("/preview/:token", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  const preview = verifyContentPreview(req.params.token);
  if (!preview || preview.siteId !== await getSiteId()) { res.status(404).send("Preview unavailable"); return; }
  try {
    const db = await getDb();
    const [row] = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? AND version = ? AND trashed_at IS NULL LIMIT 1",
      [preview.contentId, preview.siteId, preview.version],
    );
    if (!row) { res.status(404).send("Preview unavailable"); return; }
    const content = serializeContentRow(row);
    // Only this row is previewed; menus, templates and all other content stay public.
    const locale = await getDefaultLocale(content.siteId);
    const publicPath = localePath(content.locale, `/${content.slug}`, locale);
    res.type("html").send(await renderSinglePageHtml(req, res, publicPath, content.slug, content.locale, false, [], 1, publicPath, content, true));
  } catch { res.status(500).send("Preview unavailable"); }
});

const blockRegistry = getRuntimeBlockRegistry();
registerBlogPostListBlock();
registerCommentsBlock();
registerTemplateBlocks();

const RESERVED = new Set([
  "admin",
  "api",
  "install",
  "login",
  "register",
  "uploads",
  "assets",
  "css-providers",
  "favicon.ico",
]);

async function loadCatalog(locale: string): Promise<MessageCatalog> {
  const base = locale.split("-")[0] ?? locale;
  for (const code of [locale, base, "en"]) {
    try {
      return (await import(`../lib/i18n/site-catalogs/${code}.json`, { with: { type: "json" } }))
        .default as MessageCatalog;
    } catch {
      // try next
    }
  }
  return {};
}

async function loadThemeMods(preview = false): Promise<ReturnType<typeof mergeMods>> {
  return rememberPublic(
    `${THEME_MODS_PREFIX}${preview ? "preview" : "live"}`,
    async () => {
      await ensureThemesTable();
      const siteId = await getSiteId();
      if (!siteId) return defaultModsFromSchema();

      const theme = await getActiveTheme(siteId);
      const themeId = theme?.theme_id ?? "justflows.default";
      const defaults = defaultModsFromSchema();
      const published = (await getThemeMods(themeId, false)) ?? {};
      const draft = preview ? ((await getThemeMods(themeId, true)) ?? {}) : {};
      return mergeMods(mergeMods(defaults, published), draft);
    },
    preview,
  );
}

async function loadIdentity(
  preview = false,
  locale?: string,
): Promise<{ siteTitle: string; tagline: string; logoUrl: string; faviconUrl: string }> {
  const mods = await loadThemeMods(preview);
  const identity = await getSiteIdentity(mods, { preview });
  const siteId = await getSiteId();
  if (!siteId) return identity;

  const seo = await getSeoSettings(siteId, locale);
  return {
    siteTitle: seo.siteTitle || identity.siteTitle,
    tagline: seo.defaultDescription || identity.tagline,
    logoUrl: identity.logoUrl,
    faviconUrl: identity.faviconUrl,
  };
}

async function loadCssProviderAssets(): Promise<ReturnType<typeof resolveProviderAssets>> {
  return rememberPublic(`${CSS_PROVIDER_PREFIX}active`, async () => {
    await ensureCssProvidersTable();
    const siteId = await getSiteId();
    if (!siteId) return { stylesheets: [] };
    const provider = await getActiveCssProvider(siteId);
    return resolveProviderAssets(provider);
  });
}

/**
 * The form handler redirects back with ?submitted=<formId> so the confirmation
 * renders instead of the form. Any visitor can append it to any URL, so it is
 * constrained to a plausible form id and only honoured when the request also
 * carries a same-origin Referer — otherwise it is a free cache-bypass lever on
 * every page of the site.
 */
const FORM_ID_RE = /^[a-z0-9-]{1,40}$/i;

function submittedFormIdFrom(req: Request): string | undefined {
  const value = req.query.submitted;
  if (typeof value !== "string" || !FORM_ID_RE.test(value)) return undefined;
  return value;
}

function isFormConfirmation(req: Request): boolean {
  if (!submittedFormIdFrom(req)) return false;
  const referer = req.get("referer");
  if (!referer) return false;
  try {
    const host = new URL(referer).host;
    return host === req.get("host");
  } catch {
    return false;
  }
}

async function renderBlockTree(
  blocks: BlockNode[],
  submittedFormId?: string,
  blogCtx?: BlogPostListRenderContext,
  commentCtx?: CommentsRenderContext,
  templateCtx?: TemplateBlockContext,
): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    if (templateCtx && TEMPLATE_BLOCK_TYPES.has(block.type)) {
      try {
        parts.push(
          withBlockChrome(
            await renderTemplateBlockHtml(block.type, block.props ?? {}, templateCtx),
            block,
          ),
        );
      } catch {
        parts.push("");
      }
      continue;
    }
    if (block.type === BLOG_POST_LIST_BLOCK_TYPE && blogCtx) {
      try {
        parts.push(
          withBlockChrome(await renderBlogPostListBlockHtml(block.props ?? {}, blogCtx), block),
        );
      } catch {
        parts.push("");
      }
      continue;
    }
    if (block.type === COMMENTS_BLOCK_TYPE && commentCtx) {
      try {
        parts.push(
          withBlockChrome(await renderCommentsBlockHtml(block.props ?? {}, commentCtx), block),
        );
      } catch (err) {
        console.error("[justflows] comments block render failed:", err);
        parts.push("");
      }
      continue;
    }
    const def = blockRegistry.get(block.type);
    const children = Array.isArray(block.children) ? block.children : [];
    if (def?.supportsChildren && children.length > 0) {
      try {
        const childHtml = await renderBlockTree(
          children,
          submittedFormId,
          blogCtx,
          commentCtx,
          templateCtx,
        );
        parts.push(withBlockChrome(def.render(def.validateProps(block.props), childHtml), block));
      } catch {
        parts.push("");
      }
      continue;
    }
    try {
      parts.push(blockRegistry.renderNode(block));
    } catch {
      parts.push("");
    }
  }
  return parts.join("\n");
}

/**
 * Swap reusable references for their content before anything is rendered.
 *
 * Done here rather than at insert time so editing a saved block updates every
 * page that uses it, which is the only reason to have them.
 */
async function withReusables(blocks: BlockNode[]): Promise<BlockNode[]> {
  if (!containsReusable(blocks)) return blocks;
  const siteId = await getSiteId();
  if (!siteId) return blocks;
  const { listReusableBlocks, resolveReusableBlocks } = await import("../lib/reusable-blocks.js");
  // Cached as an array: a Map does not survive a serializing cache backend.
  const saved = await rememberPublic("reusable-blocks", () => listReusableBlocks(siteId), false);
  return resolveReusableBlocks(blocks, new Map(saved.map((item) => [item.id, item])));
}

function containsReusable(blocks: BlockNode[]): boolean {
  return blocks.some(
    (block) =>
      block.type === "core.reusable" ||
      (block.children?.length ? containsReusable(block.children) : false),
  );
}

async function renderBlocksHtml(
  blocks: BlockNode[],
  submittedFormId?: string,
  blogCtx?: BlogPostListRenderContext,
  commentCtx?: CommentsRenderContext,
  templateCtx?: TemplateBlockContext,
): Promise<string> {
  if (await isGalleryPluginEnabled()) registerGalleryBlock();
  else unregisterGalleryBlock();
  const resolved = await withResponsiveImages(await withReusables(blocks), await getSiteId());
  try {
    return await renderBlockTree(resolved, submittedFormId, blogCtx, commentCtx, templateCtx);
  } catch {
    return renderBlockTree(resolved, submittedFormId, blogCtx, commentCtx, templateCtx);
  }
}

/** Posts-per-page fallback for `justflows.blog.postList` blocks that don't override it. */
async function defaultPostsPerPage(): Promise<number> {
  const siteId = await getSiteId();
  if (!siteId) return 10;
  const stored = await getSiteSetting<number>(siteId, "posts_per_page");
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

async function buildBlogRenderContext(
  locale: string,
  page: number,
  basePath: string,
): Promise<BlogPostListRenderContext> {
  const [siteId, defaultLocale, postsPerPageDefault] = await Promise.all([
    getSiteId(),
    getDefaultLocale(),
    defaultPostsPerPage(),
  ]);
  return {
    siteId: siteId ?? "",
    locale,
    defaultLocale,
    page,
    basePath,
    postsPerPageDefault,
  };
}

const COMMENT_BANNERS = new Set<CommentsBannerState>(["posted", "pending", "error", "captcha"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameOriginReferer(req: Request): boolean {
  const referer = req.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).host === req.get("host");
  } catch {
    return false;
  }
}

/**
 * Per-request context for a `justflows.comments.thread` block. Built only for
 * single-content renders; the block itself resolves whether comments are on.
 */
async function buildCommentContext(
  req: Request,
  content: {
    id: string;
    type: string;
    slug?: string;
    publishedAt: Date | string | null;
    fields: unknown;
    translationGroupId?: string | null;
  },
  pageCtx: { locale: string; t: (key: string) => string },
  basePath: string,
): Promise<CommentsRenderContext> {
  const siteId = (await getSiteId()) ?? "";
  const session = getSession(req);
  let currentUser: CommentsRenderContext["currentUser"] = null;
  if (session?.userId && siteId) {
    try {
      const db = await getDb();
      const rows = await db.query<{ display_name: string; username: string; email: string }>(
        "SELECT display_name, username, email FROM users WHERE id = ? AND site_id = ? LIMIT 1",
        [session.userId, siteId],
      );
      const u = rows[0];
      if (u)
        currentUser = { id: session.userId, name: u.display_name || u.username, email: u.email };
    } catch {
      currentUser = null;
    }
  }

  const bannerRaw =
    typeof req.query.comment === "string" ? (req.query.comment as CommentsBannerState) : null;
  const banner =
    bannerRaw && COMMENT_BANNERS.has(bannerRaw) && sameOriginReferer(req) ? bannerRaw : null;
  const replyRaw = typeof req.query.reply === "string" ? req.query.reply : "";
  const replyTo = UUID_RE.test(replyRaw) ? replyRaw : null;
  const pageRaw = Number(req.query["comment-page"]);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(Math.trunc(pageRaw), 10_000) : 1;

  return {
    siteId,
    content,
    currentUser,
    banner,
    replyTo,
    page,
    basePath,
    locale: pageCtx.locale,
    t: pageCtx.t,
  };
}

/** True when this request must skip the shared page cache for comment state. */
function pageCacheBypassReason(req: Request, preview: boolean): string | null {
  if (preview) return "preview";
  if (isFormConfirmation(req)) return "form confirmation";
  if (getSession(req)) return "authenticated session";
  if (
    typeof req.query.comment === "string" ||
    typeof req.query.reply === "string" ||
    typeof req.query["comment-page"] === "string"
  )
    return "comment interaction";
  if (!getJfCache().enabled) return "page cache disabled";
  return null;
}

function withSiteWidgets(
  html: string,
  ctx: {
    languageLinks: Array<{
      code: string;
      name: string;
      href: string;
      current: boolean;
      displayCode?: string;
    }>;
    usersCanRegister: boolean;
    t: (key: string) => string;
  },
): string {
  html = html.replace(/<span data-jf-search-text="([a-z]+)">[^<]*<\/span>/g, (markup, key: string) =>
    ["type", "taxonomy", "term", "after", "before", "submit"].includes(key) ? `<span>${esc(ctx.t(`search.${key}`))}</span>` : markup);
  const searchLocale = ctx.languageLinks.find(link => link.current)?.code;
  if (searchLocale) html = html.replaceAll('action="/search"', `action="/${esc(searchLocale)}/search"`);
  return hydrateSiteWidgets(html, {
    languageLinks: ctx.languageLinks,
    usersCanRegister: ctx.usersCanRegister,
    labels: {
      login: ctx.t("auth.login"),
      register: ctx.t("auth.register"),
      language: ctx.t("language.label"),
    },
  });
}

async function renderUnderConstruction(): Promise<string> {
  const siteId = (await getSiteId()) ?? "";
  const identity = await loadIdentity(false);
  const hookContext = { siteId, siteTitle: identity.siteTitle, tagline: identity.tagline };

  let html = await ejs.renderFile(path.join(templateDir, "under-construction.ejs"), {
    siteTitle: identity.siteTitle,
    tagline: identity.tagline,
    faviconHead: buildFaviconHeadHtml(identity.faviconUrl),
    justflowsVersion: getJustflowsVersion(),
  });

  const hooks = getRuntimeHooks();
  if (hooks.has("site.underConstruction.render")) {
    html = hooks.applyFilterSync("site.underConstruction.render", html, hookContext, {
      siteId,
      source: "http",
    });
  }

  if (siteId) {
    void hooks.dispatchAction(
      "site.underConstruction.viewed",
      { siteId },
      { siteId, source: "http" },
    );
  }

  return html;
}

async function ensureSiteIsPublic(req: Request, res: Response): Promise<boolean> {
  if (await isSitePublic()) return true;
  if (await canViewUnpublishedSite(req, res)) return true;

  const html = await renderUnderConstruction();
  res.status(503).type("html").send(html);
  return false;
}

/** The visitor's admin-session state, for the (opt-in) role/auth menu-item visibility rules.
 * The public site has no separate front-end membership system — "authenticated" here means
 * "signed into the admin panel", the same signal `canViewUnpublishedSite`/`?preview=1` already use. */
async function resolvePublicMenuVisibility(
  req: Request,
  res: Response,
): Promise<MenuVisibilityContext> {
  const session = await resolveSession(req, res);
  return session ? { authState: "authenticated", role: session.role } : { authState: "guest" };
}

/** Whether a menu's *published* items are safe to serve from the shared public cache. A menu using
 * role/auth visibility rules is never cached — every request needs this visitor's real session — but
 * the answer itself is cached (under the same menus prefix, invalidated by every menu save) so the
 * common case (no visibility rules) still costs zero extra DB reads once warm. */
async function menuIsCacheable(siteId: string, menuSlug: string): Promise<boolean> {
  return rememberPublic(`${MENUS_PREFIX}${menuSlug}:cacheable`, async () => {
    const menu = await getMenuBySlug(siteId, menuSlug);
    return !menu || !menuHasVisibilityRules(getEffectiveMenuItems(menu, false));
  });
}

/** A resolved mega-menu region, its blocks already rendered to safe HTML for the template. */
export interface RenderableMegaRegion {
  id: string;
  heading?: string;
  span?: number;
  renderedHtml: string;
}

/** `ResolvedNavItem`, ready for `nav-menu.ejs`: mega-menu regions carry rendered HTML, not block JSON. */
export interface RenderableNavItem extends Omit<ResolvedNavItem, "children" | "megaMenu"> {
  megaMenu?: { regions: RenderableMegaRegion[] };
  children?: RenderableNavItem[];
}

/** Render each mega-menu region's sanitized block tree to HTML via the same pipeline (reusable-block
 * resolution included) page content uses, so menu content can never diverge from that safety net. */
async function withRenderedMegaMenus(items: ResolvedNavItem[]): Promise<RenderableNavItem[]> {
  const out: RenderableNavItem[] = [];
  for (const item of items) {
    const { megaMenu, children, ...rest } = item;
    const next: RenderableNavItem = { ...rest };
    if (megaMenu?.regions?.length) {
      next.megaMenu = {
        regions: await Promise.all(
          megaMenu.regions.map(async (region) => ({
            id: region.id,
            heading: region.heading,
            span: region.span,
            renderedHtml: await renderBlocksHtml(region.blocks),
          })),
        ),
      };
    }
    if (children?.length) {
      next.children = await withRenderedMegaMenus(children);
    }
    out.push(next);
  }
  return out;
}

async function loadNavItems(
  req: Request,
  res: Response,
  menuSlug: string,
  locale: string,
  defaultLocale: string,
  preview: boolean,
): Promise<RenderableNavItem[]> {
  const siteId = await getSiteId();
  let resolved: ResolvedNavItem[];
  if (!preview && siteId && !(await menuIsCacheable(siteId, menuSlug))) {
    const visibility = await resolvePublicMenuVisibility(req, res);
    resolved = await getNavItemsForMenuSlug(menuSlug, locale, defaultLocale, preview, visibility);
  } else {
    resolved = await rememberPublic(
      `${MENUS_PREFIX}${menuSlug}:${locale}:${defaultLocale}:${preview ? "preview" : "live"}`,
      () => getNavItemsForMenuSlug(menuSlug, locale, defaultLocale, preview),
      preview,
    );
  }
  return withRenderedMegaMenus(resolved);
}

/** The menu design for the menu `loadNavItems` just resolved — a separate, tiny cached read
 * (same prefix, same invalidation) so the common request path stays a cache-only lookup. */
async function loadMenuDesign(
  siteId: string,
  menuSlug: string,
  preview: boolean,
): Promise<MenuDesign | null> {
  return rememberPublic(
    `${MENUS_PREFIX}${menuSlug}:design:${preview ? "preview" : "live"}`,
    async () => {
      const menu = await getMenuBySlug(siteId, menuSlug);
      return menu ? getEffectiveMenuDesign(menu, preview) : null;
    },
    preview,
  );
}

async function sendPublicHtml(
  req: Request,
  res: Response,
  pageKey: string,
  preview: boolean,
  render: () => Promise<string>,
  status = 200,
): Promise<void> {
  const hooksBefore = getRuntimeHooks().inspect();
  const hookRunsBefore = hooksBefore.reduce((sum, hook) => sum + hook.runs, 0);
  const hookErrorsBefore = hooksBefore.reduce((sum, hook) => sum + hook.errors, 0);
  const bypassReason = pageCacheBypassReason(req, preview);
  const bypass = bypassReason !== null;
  if (bypass || !getJfCache().enabled) {
    res.locals.jfPageCache = "BYPASS";
  }
  let html = await getCachedPageHtml(pageKey, bypass, render);
  if (debugMode().enabled) {
    const session = await resolveSession(req, res);
    if (session?.role === "administrator") {
      const hookState = getRuntimeHooks().inspect();
      const trace = currentRequestTrace();
      const events = getRequestCacheEvents(req);
      const siteId = await getSiteId();
      const theme = siteId ? await getActiveTheme(siteId) : null;
      const adminPath = (await getAdminPathConfig()).path;
      const toolbarData = {
        requestId: req.requestId ?? "unknown",
        path: req.path,
        durationMs: trace ? performance.now() - trace.startedAt : 0,
        pageCache: String(res.locals.jfPageCache ?? pageCacheStatus(events) ?? "BYPASS"),
        pageCacheReason: bypassReason,
        objectCache: formatCacheSummary(events),
        databaseQueries: trace?.databaseQueries ?? 0,
        databaseMs: trace?.databaseMs ?? 0,
        hookRuns: hookState.reduce((sum, hook) => sum + hook.runs, 0) - hookRunsBefore,
        hookErrors: hookState.reduce((sum, hook) => sum + hook.errors, 0) - hookErrorsBefore,
        theme: theme?.theme_id ?? "justflows.default",
        template: pageKey,
        diagnosticsUrl: `${toPublicAdminPath("/admin/health", adminPath)}?requestId=${encodeURIComponent(req.requestId ?? "")}`,
      };
      recordCompletedRequestTrace({
        requestId: toolbarData.requestId,
        timestamp: new Date().toISOString(),
        path: toolbarData.path,
        durationMs: toolbarData.durationMs,
        pageCache: toolbarData.pageCache,
        pageCacheReason: toolbarData.pageCacheReason,
        objectCache: toolbarData.objectCache,
        databaseQueries: toolbarData.databaseQueries,
        databaseMs: toolbarData.databaseMs,
        hookRuns: toolbarData.hookRuns,
        hookErrors: toolbarData.hookErrors,
        theme: toolbarData.theme,
        template: toolbarData.template,
      });
      html = injectDebugToolbar(html, toolbarData);
      res.setHeader("Cache-Control", "private, no-store");
    }
  }
  res.status(status).type("html").send(html);
  if (!preview && status < 400) {
    void import("../lib/analytics-public.js")
      .then(({ recordPublicPageview }) => recordPublicPageview(req))
      .catch(() => undefined);
  }
}

function escapeDebugText(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

function injectDebugToolbar(
  html: string,
  data: {
    requestId: string;
    path: string;
    durationMs: number;
    pageCache: string;
    pageCacheReason: string | null;
    objectCache: string;
    databaseQueries: number;
    databaseMs: number;
    hookRuns: number;
    hookErrors: number;
    theme: string;
    template: string;
    diagnosticsUrl: string;
  },
): string {
  const payload = escapeDebugText(JSON.stringify(data));
  const toolbar =
    `<jf-debug-toolbar data-payload="${payload}"></jf-debug-toolbar>` +
    `<script src="/js/debug-toolbar.js" defer></script>`;
  const bodyEnd = html.lastIndexOf("</body>");
  return bodyEnd === -1
    ? `${html}${toolbar}`
    : `${html.slice(0, bodyEnd)}${toolbar}${html.slice(bodyEnd)}`;
}

/** Render the site's normal themed 404 for routes intercepted before this router. */
export async function sendPublicNotFound(req: Request, res: Response): Promise<void> {
  if (!(await ensureSiteIsPublic(req, res))) return;
  await sendPublicHtml(
    req,
    res,
    `${req.path}:404`,
    false,
    async () => {
      const ctx = await buildPageContext(req, res, req.path, false);
      return renderNotFoundHtml(ctx);
    },
    404,
  );
}

/**
 * hreflang alternates for a public page: one entry per active locale, plus an
 * `x-default` pointing at the default language. Every active locale is listed —
 * even one without its own translated row — because the site still serves that
 * locale's URL (falling back to the default language) and a page must always
 * reference itself. When a locale has a real translation with its own slug that
 * slug is used; otherwise the current locale-stripped path is reused under that
 * locale's prefix. Returns `[]` for single-language sites.
 */
export function hreflangAlternates(opts: {
  activeLocales: string[];
  defaultLocale: string;
  currentPath: string;
  translations: Array<{ locale: string; slug: string }>;
}): Array<{ locale: string; href: string }> {
  const { activeLocales, defaultLocale, translations } = opts;
  if (activeLocales.length < 2) return [];
  const currentPath = opts.currentPath.startsWith("/") ? opts.currentPath : `/${opts.currentPath}`;
  const slugByLocale = new Map(translations.map((t) => [t.locale, t.slug]));
  const links = activeLocales.map((locale) => {
    const slug = slugByLocale.get(locale);
    const localePathname = slug ? `/${slug}` : currentPath;
    return { locale, href: localePath(locale, localePathname, defaultLocale) };
  });
  const canonical = links.find((l) => l.locale === defaultLocale) ?? links[0];
  if (canonical) links.push({ locale: "x-default", href: canonical.href });
  return links;
}

async function renderPage(view: string, data: Record<string, unknown>): Promise<string> {
  const pageData = { ...data, localePath, justflowsVersion: getJustflowsVersion() };
  const hooks = getRuntimeHooks();
  const siteId = (await getSiteId()) ?? "";
  const content = data.content as
    { title?: string; excerpt?: string | null; fields?: Record<string, unknown> } | undefined;
  const seoFromContent = content
    ? seoTextFromContent(content)
    : { title: "", description: "", canonical: "", image: "" };
  const pageTitle = seoFromContent.title || String(data.title ?? "");
  const pageDescription = seoFromContent.description || String(data.seoDescription ?? "");
  let headExtra = "";
  let documentTitle = pageTitle;
  if (siteId) {
    const settings = await getSeoSettings(siteId, String(data.locale ?? ""));
    const page = {
      title: pageTitle,
      description: pageDescription,
      excerpt: content?.excerpt,
      path: String(data.publicPath ?? data.restPath ?? "/"),
      canonical: seoFromContent.canonical || undefined,
      image: seoFromContent.image || undefined,
    };
    documentTitle = resolveSeoTitle(page, settings);
    headExtra = buildSeoHeadHtml(page, settings);
  }
  const identity = data.identity as { faviconUrl?: string } | undefined;
  const faviconHead = buildFaviconHeadHtml(identity?.faviconUrl ?? "");
  if (faviconHead) {
    headExtra = headExtra ? `${faviconHead}\n${headExtra}` : faviconHead;
  }
  // Auto-enqueued client assets declared by active plugins (`manifest.assets`).
  const { renderPluginAssetHeadHtml } = await import("../lib/plugin-assets.js");
  const pluginAssetHead = await renderPluginAssetHeadHtml();
  if (pluginAssetHead) {
    headExtra = headExtra ? `${headExtra}\n${pluginAssetHead}` : pluginAssetHead;
  }
  // The Forms plugin ships its own enhancement script via `manifest.assets`,
  // so it is already in `pluginAssetHead` above — nothing forms-specific here.
  if (hooks.has("html.head")) {
    headExtra = hooks.applyFilterSync(
      "html.head",
      headExtra,
      {
        siteId,
        path: String(data.restPath ?? "/"),
        locale: String(data.locale ?? ""),
        title: pageTitle,
        contentId:
          typeof data.content === "object" && data.content && "id" in (data.content as object)
            ? String((data.content as { id?: string }).id ?? "")
            : undefined,
      },
      { siteId, source: "http" },
    );
  }
  const body = await ejs.renderFile(path.join(templateDir, `${view}.ejs`), pageData);
  let analyticsHead = "";
  let analyticsBody = "";
  if (!data.preview && siteId) {
    const { getConfiguredGoogleTagId } = await import("../lib/analytics-public.js");
    const { buildGoogleTagHead, buildGoogleTagBody } = await import("../lib/google-tag.js");
    const googleTagId = await getConfiguredGoogleTagId();
    if (googleTagId) {
      analyticsHead = buildGoogleTagHead(googleTagId);
      analyticsBody = buildGoogleTagBody(googleTagId);
    }
  }
  if (hooks.has("analytics.head")) {
    // A consent plugin can rewrite the analytics markup (e.g. defer it behind a
    // consent category) before it reaches the page. Sync — this is a render path.
    analyticsHead = hooks.applyFilterSync(
      "analytics.head",
      analyticsHead,
      { siteId, path: String(data.restPath ?? "/") },
      { siteId, source: "http" },
    );
  }
  const rawTranslations = Array.isArray(data.alternates)
    ? (data.alternates as Array<{ locale?: unknown; slug?: unknown }>).flatMap((t) =>
        t && typeof t.locale === "string"
          ? [{ locale: t.locale, slug: typeof t.slug === "string" ? t.slug : "" }]
          : [],
      )
    : [];
  const hreflangLinks =
    view === "404" || data.discourageSearchEngines === true || !Array.isArray(data.activeLocales)
      ? []
      : hreflangAlternates({
          activeLocales: data.activeLocales as string[],
          defaultLocale: String(data.defaultLocale ?? ""),
          currentPath: String(data.restPath ?? "/"),
          translations: rawTranslations,
        });

  return ejs.renderFile(path.join(templateDir, "layout.ejs"), {
    ...pageData,
    body,
    headExtra,
    analyticsHead,
    analyticsBody,
    hreflangLinks,
    title: documentTitle,
  });
}

type SiteWidgetCtx = Parameters<typeof withSiteWidgets>[1];

interface TemplateRenderOpts {
  submittedFormId?: string;
  blogCtx?: BlogPostListRenderContext;
  commentCtx?: CommentsRenderContext;
  preview?: boolean;
}

/**
 * Build the {@link TemplateBlockContext} for a request, wiring `core.template-part`
 * to render the active theme's `parts/<slug>.json` through the same header ctx
 * and widgets as the rest of the page.
 */
function templateBlockContext(
  base: Omit<TemplateBlockContext, "renderPart">,
  withHeader: SiteWidgetCtx,
  opts: TemplateRenderOpts = {},
): TemplateBlockContext {
  return {
    ...base,
    renderPart: async (slug) => {
      const partBlocks = await resolveThemePartBlocks(slug, opts.preview ?? false);
      if (!partBlocks?.length) return "";
      return withSiteWidgets(
        await renderBlocksHtml(partBlocks, opts.submittedFormId, opts.blogCtx, opts.commentCtx),
        withHeader,
      );
    },
  };
}

/**
 * When the active theme ships a `templates/<slug>.json` for this request, render
 * it through the block tree (context blocks resolving `templateCtx`) into the
 * `template` view. Returns `null` when the theme has no matching template, so
 * the caller falls back to its built-in EJS view (`single` / `home` / `404`).
 */
async function renderThemeTemplateHtml(
  query: TemplateQuery,
  withHeader: SiteWidgetCtx & Record<string, unknown>,
  templateCtx: TemplateBlockContext,
  viewData: Record<string, unknown>,
  opts: TemplateRenderOpts = {},
): Promise<string | null> {
  const tpl = await resolvePublicTemplate(query, opts.preview ?? false);
  if (!tpl) return null;
  const bodyHtml = withSiteWidgets(
    await renderBlocksHtml(
      tpl.blocks,
      opts.submittedFormId,
      opts.blogCtx,
      opts.commentCtx,
      templateCtx,
    ),
    withHeader,
  );
  return renderPage("template", { ...withHeader, ...viewData, bodyHtml });
}

type PageCtx = Awaited<ReturnType<typeof buildPageContext>>;

/** The themed 404 — a `templates/404.json` when the theme has one, else `404.ejs`. */
async function renderNotFoundHtml(ctx: PageCtx): Promise<string> {
  const notFoundOpts: TemplateRenderOpts = { preview: ctx.preview };
  const templateHtml = await renderThemeTemplateHtml(
    { kind: "notFound" },
    ctx,
    templateBlockContext(
      { content: null, formattedDate: null, contentBodyHtml: "" },
      ctx,
      notFoundOpts,
    ),
    { title: ctx.t("404.title"), mainClass: "site-main" },
    notFoundOpts,
  );
  return templateHtml ?? renderPage("404", { ...ctx, title: ctx.t("404.title") });
}

function languageLinksFor(
  languages: Array<{ code: string; nativeName: string }>,
  currentLocale: string,
  restPath: string,
  defaultLocale: string,
  translations: Array<{ locale: string; slug: string; href?: string }> = [],
): Array<{
  code: string;
  name: string;
  href: string;
  current: boolean;
  displayCode: string;
  shortCode: string;
  flag: string;
  countryName: string;
}> {
  const slugByLocale = new Map(translations.map((tr) => [tr.locale, tr.slug]));
  return languages.map((lang) => {
    const translatedSlug = slugByLocale.get(lang.code);
    const path = translatedSlug ? `/${translatedSlug}` : restPath;
    return {
      code: lang.code,
      name: lang.nativeName,
      href:
        translations.find((tr) => tr.locale === lang.code)?.href ??
        localePath(lang.code, path, defaultLocale),
      current: lang.code === currentLocale,
      displayCode: displayLocaleCode(lang.code),
      ...localePresentation(lang.code),
    };
  });
}

async function buildPageContext(req: Request, res: Response, reqPath: string, preview = false) {
  const activeLocales = await getActiveLocaleCodes();
  const defaultLocale = await getDefaultLocale();
  const languages = await listLanguages(undefined, true);
  const { locale: prefixLocale, restPath } = parseLocalePrefix(reqPath, activeLocales);

  let locale = prefixLocale ?? defaultLocale;
  locale = await resolveContentLocale(locale);

  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog);
  const identity = await loadIdentity(preview, locale);
  const cssProviderAssets = await loadCssProviderAssets();
  const mods = await loadThemeMods(preview);
  const discourageSearchEngines = await shouldDiscourageSearchEngines();
  const { header: headerMenuSlug, footer: footerMenuSlug } = getNavigationMenuSlugs(mods);
  const navMenuSlug = headerMenuSlug ?? "primary";
  const navFooterMenuSlug = footerMenuSlug ?? "footer";
  const navItems = await loadNavItems(req, res, navMenuSlug, locale, defaultLocale, preview);
  const footerNavItems = await loadNavItems(
    req,
    res,
    navFooterMenuSlug,
    locale,
    defaultLocale,
    preview,
  );
  const menuDesignSiteId = await getSiteId();
  const menuDesign = menuDesignSiteId
    ? await loadMenuDesign(menuDesignSiteId, navMenuSlug, preview)
    : null;
  const footerMenuDesign = menuDesignSiteId
    ? await loadMenuDesign(menuDesignSiteId, navFooterMenuSlug, preview)
    : null;

  const languageLinks = languageLinksFor(languages, locale, restPath, defaultLocale);
  const publicPath = localePath(locale, restPath, defaultLocale);
  const general = await getGeneralSettings();

  // Site-wide chrome edited as blocks. Empty means the site never customised
  // one, so the layout keeps its built-in footer rather than rendering nothing.
  const siteId = await getSiteId();

  // The site header library. A page without its own ref renders the library
  // default; pages resolve their chosen entry in applyPageHeader below.
  const headerLib: SiteHeaderLibrary = siteId
    ? await rememberPublic(
        `${SITE_CTX_PREFIX}header:lib:${preview ? "preview" : "live"}`,
        () => getEffectiveSiteHeaderLibrary(siteId, preview),
        preview,
      )
    : emptyLibrary();
  const header = await resolveHeaderConfig({
    siteId: siteId ?? "",
    library: headerLib,
    ref: SITE_DEFAULT_HEADER_REF,
    locale,
    defaultLocale,
  });
  const headerBlocksHtml = header.blocks.length
    ? withSiteWidgets(await renderBlocksHtml(header.blocks), {
        languageLinks,
        usersCanRegister: general.usersCanRegister,
        t,
      })
    : "";

  const activeTheme = siteId ? await getActiveTheme(siteId) : null;
  const footerBlocks = siteId
    ? await rememberPublic(
        `template-part:footer:${activeTheme?.theme_id ?? "none"}:${preview ? "preview" : "live"}`,
        async () => {
          const { getEffectiveTemplatePart } = await import("../lib/template-parts.js");
          const stored = await getEffectiveTemplatePart(siteId, "footer", preview);
          if (stored.length > 0) return stored;
          // Site never customised a footer — fall back to the active theme's
          // default (`demo/footer.json`), like the homepage falls back to
          // `demo/home.json`. Empty here means the layout keeps its built-in footer.
          if (!activeTheme) return [];
          const { loadThemeDemoFooter } = await import("../lib/theme-files.js");
          return loadThemeDemoFooter(activeTheme.theme_id, themeInstalledPath(activeTheme)) ?? [];
        },
        preview,
      )
    : [];
  const footerBlocksHtml =
    footerBlocks.length > 0
      ? withSiteWidgets(await renderBlocksHtml(footerBlocks), {
          languageLinks: languageLinksFor(languages, locale, restPath, defaultLocale),
          usersCanRegister: general.usersCanRegister,
          t,
        })
      : "";

  return {
    locale,
    defaultLocale,
    restPath,
    publicPath,
    activeLocales,
    languages,
    languageLinks,
    identity,
    navItems,
    menuDesign,
    footerNavItems,
    footerMenuDesign,
    footerBlocksHtml,
    headerMenuSlug,
    footerMenuSlug,
    t,
    title: identity.siteTitle,
    preview,
    discourageSearchEngines,
    cssProviderStylesheets: cssProviderAssets.stylesheets,
    header,
    headerBrand: headerBrandFlags(header, identity.logoUrl),
    headerBlocksHtml,
    headerLib,
    siteId: siteId ?? "",
    usersCanRegister: general.usersCanRegister,
  };
}

async function applyPageHeader<T extends Awaited<ReturnType<typeof buildPageContext>>>(
  req: Request,
  res: Response,
  ctx: T,
  fields: Record<string, unknown> | undefined,
  preview: boolean,
  submittedFormId?: string,
  content?: { id?: string; type?: string },
): Promise<T & { header: PageHeaderConfig; headerBlocksHtml: string }> {
  const header = await resolveHeaderConfig({
    siteId: ctx.siteId,
    library: ctx.headerLib,
    ref: headerRefFromContentFields(fields),
    locale: ctx.locale,
    defaultLocale: ctx.defaultLocale,
    content,
  });
  const menuSlug = resolveHeaderMenuSlug(header, ctx.headerMenuSlug);
  const navItems = menuSlug
    ? await loadNavItems(req, res, menuSlug, ctx.locale, ctx.defaultLocale, preview)
    : [];
  const menuDesign =
    menuSlug && ctx.siteId ? await loadMenuDesign(ctx.siteId, menuSlug, preview) : null;
  const withHeader = {
    ...ctx,
    header,
    headerBrand: headerBrandFlags(header, ctx.identity.logoUrl),
    navItems,
    menuDesign,
    headerMenuSlug: menuSlug,
  };
  const headerBlocksHtml = header.blocks.length
    ? withSiteWidgets(await renderBlocksHtml(header.blocks, submittedFormId), withHeader)
    : "";
  return { ...withHeader, headerBlocksHtml };
}

function previewQuery(req: Request): string {
  return req.query.preview === "1" ? "?preview=1" : "";
}

/** Send /nl-nl/about-us to /nl-NL/about-us when casing differs from the stored tag. */
function canonicalLocaleRedirect(
  reqPath: string,
  activeLocales: string[],
  defaultLocale: string,
): string | null {
  const { locale, restPath } = parseLocalePrefix(reqPath, activeLocales);
  if (!locale) return null;
  const canonical = localePath(locale, restPath, defaultLocale);
  const current = reqPath.replace(/\/+$/, "") || "/";
  const target = canonical.replace(/\/+$/, "") || "/";
  return current !== target ? canonical : null;
}

/** If this URL used another locale's slug, send the visitor to the translation's own slug. */
function translatedSlugPath(
  content: { locale: string; slug: string },
  requestedSlug: string,
  requestedLocale: string,
  defaultLocale: string,
): string | null {
  if (content.locale !== requestedLocale || content.slug === requestedSlug) return null;
  return localePath(content.locale, `/${content.slug}`, defaultLocale);
}

async function renderHomeHtml(
  req: Request,
  res: Response,
  reqPath: string,
  preview: boolean,
): Promise<string> {
  const ctx = await buildPageContext(req, res, reqPath, preview);
  const siteId = await getSiteId();
  const home = siteId ? await getHomeContent(siteId, ctx.locale, preview) : null;
  const withHeader = await applyPageHeader(
    req,
    res,
    ctx,
    home?.fields,
    preview,
    submittedFormIdFrom(req),
    {
      id: home ? String(home.id) : undefined,
      type: home ? String(home.type) : undefined,
    },
  );
  const blogCtx = await buildBlogRenderContext(ctx.locale, 1, reqPath);

  let bodyHtml: string | undefined;
  if (home) {
    bodyHtml = withSiteWidgets(
      await applyContentRender(
        await renderBlocksHtml(
          await applyContentBlocks(home.blocks.blocks, home),
          submittedFormIdFrom(req),
          blogCtx,
        ),
        home,
      ),
      withHeader,
    );
  } else {
    const demoBlocks = await loadHomeDemoBlocks(preview);
    bodyHtml = demoBlocks?.length
      ? withSiteWidgets(
          await renderBlocksHtml(demoBlocks, submittedFormIdFrom(req), blogCtx),
          withHeader,
        )
      : undefined;
  }

  const templateOpts: TemplateRenderOpts = {
    submittedFormId: submittedFormIdFrom(req),
    blogCtx,
    preview,
  };
  const templateHtml = await renderThemeTemplateHtml(
    {
      kind: "home",
      frontPageKind: home ? "page" : "posts",
      slug: home ? String(home.slug) : undefined,
    },
    withHeader,
    templateBlockContext(
      {
        content: home
          ? {
              id: String(home.id),
              type: String(home.type),
              title: home.title,
              slug: String(home.slug),
              excerpt: home.excerpt ?? null,
              fields: home.fields,
              publishedAt: home.publishedAt ?? null,
            }
          : null,
        formattedDate: null,
        contentBodyHtml: bodyHtml ?? "",
      },
      withHeader,
      templateOpts,
    ),
    {
      content: home ?? undefined,
      seoDescription: ctx.identity.tagline,
      title: home ? home.title : String(withHeader.title ?? ""),
      mainClass: home ? "site-main site-main--page" : "site-main",
    },
    templateOpts,
  );
  if (templateHtml) return templateHtml;

  return renderPage("home", {
    ...withHeader,
    ...(home ? { content: home, title: home.title } : {}),
    bodyHtml,
    seoDescription: ctx.identity.tagline,
  });
}

async function loadHomeDemoBlocks(preview = false): Promise<BlockNode[] | null> {
  await ensureThemesTable();
  const siteId = await getSiteId();
  const themeId = siteId
    ? ((await getActiveTheme(siteId))?.theme_id ?? "justflows.default")
    : "justflows.default";
  const doc = await getEffectiveHomeBlocks(themeId, preview);
  return doc.blocks.length ? doc.blocks : null;
}

router.get("/favicon.ico", async (_req, res) => {
  try {
    const identity = await loadIdentity(false);
    if (!identity.faviconUrl) {
      res.status(404).end();
      return;
    }
    res.redirect(302, identity.faviconUrl);
  } catch {
    res.status(404).end();
  }
});

router.get("/robots.txt", async (_req, res) => {
  try {
    const noindex = await shouldDiscourageSearchEngines();
    const origin = siteOrigin();
    const sitemapLine = origin ? `Sitemap: ${origin}/sitemap.xml\n` : "";
    const body = noindex
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nAllow: /\n${sitemapLine}`;
    res.type("text/plain").send(body);
  } catch {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  }
});

router.get("/sitemap.xml", async (_req, res, next) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      next();
      return;
    }
    const xml = await buildSitemapXml(siteId);
    res.type("application/xml").send(xml);
  } catch (err) {
    console.error("[justflows] sitemap render failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

router.get(["/search", "/:locale/search"], rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex, follow");
  if (!(await ensureSiteIsPublic(req, res))) return;
  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).type("text/plain").send("Invalid search parameters"); return; }
  try {
    const ctx = await buildPageContext(req, res, req.path);
    if (ctx.restPath !== "/search" && ctx.restPath !== "/search/") { res.status(404).type("text/plain").send("Not found"); return; }
    const query = { ...parsed.data, locale: ctx.locale };
    const result = await searchContent(ctx.siteId, query);
    const bodyHtml = renderSearchPage(query, result, ctx.publicPath, ctx.t);
    const viewData = { title: ctx.t("search.title"), discourageSearchEngines: true };
    const themed = await renderThemeTemplateHtml({ kind: "search" }, ctx,
      templateBlockContext({ content: null, formattedDate: null, contentBodyHtml: bodyHtml }, ctx, {}), viewData);
    res.type("html").send(themed ?? await renderPage("template", { ...ctx, ...viewData, bodyHtml }));
  } catch {
    res.status(500).type("text/plain").send("Search is temporarily unavailable");
  }
});

router.use(
  createPermalinkRouter({
    canView: ensureSiteIsPublic,
    previewAllowed: isPreviewAllowed,
    async renderContent(req, res, { content, path, basePath, pageNumber, alternates }) {
      const preview = await isPreviewAllowed(req, res);
      await sendPublicHtml(req, res, path, preview, () =>
        renderSinglePageHtml(
          req,
          res,
          path,
          content.slug,
          content.locale,
          preview,
          alternates,
          pageNumber,
          basePath,
          content,
        ),
      );
    },
    async renderArchive(req, res, { path, name, items }) {
      await sendPublicHtml(req, res, path, false, async () => {
        const ctx = await buildPageContext(req, res, path);
        const bodyHtml = `<h1>${esc(name)}</h1><ul>${items.map((item) => `<li><a href="${esc(item.path)}">${esc(item.title)}</a></li>`).join("")}</ul>`;
        return renderPage("template", { ...ctx, publicPath: path, title: name, bodyHtml });
      });
    },
  }),
);

router.get("/", async (req, res, next) => {
  if (req.path !== "/") {
    next();
    return;
  }

  try {
    if (!(await ensureSiteIsPublic(req, res))) return;
    const preview = await isPreviewAllowed(req, res);
    await sendPublicHtml(req, res, req.path || "/", preview, () =>
      renderHomeHtml(req, res, "/", preview),
    );
  } catch (err) {
    console.error("[justflows] home render failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

/**
 * Render a resolved page's own body — shared by the plain single-page routes
 * and the `/page/:num` pagination routes so a `justflows.blog.postList`
 * block embedded in the page's own blocks (not just a theme-provided "blog
 * page") can page through posts no matter which page it lives on.
 */
async function renderSinglePageHtml(
  req: Request,
  res: Response,
  reqPath: string,
  slug: string,
  locale: string,
  preview: boolean,
  alternates: Array<{ locale: string; slug: string; href: string }>,
  pageNumber: number,
  basePath: string,
  resolvedContent?: ContentResponse,
  scopedPreview = false,
): Promise<string> {
  const pageCtx = { ...(await buildPageContext(req, res, reqPath, preview)), publicPath: reqPath };
  let pageContent = resolvedContent ?? (await getPublishedContentBySlug(slug, locale, preview));
  if (resolvedContent) {
    const { getDb } = await import("../lib/db.js");
    const { serializeContentRow } = await import("../lib/content-api.js");
    const { overlayWorkingOnRow } = await import("../lib/content-revisions.js");
    const rows = await (
      await getDb()
    ).query<Record<string, unknown>>(
      `SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL AND ${preview || scopedPreview ? "status IN ('published', 'draft', 'scheduled')" : "status = 'published'"}`,
      [resolvedContent.id, resolvedContent.siteId],
    );
    pageContent = rows[0]
      ? serializeContentRow(preview || scopedPreview ? await overlayWorkingOnRow(rows[0], true) : rows[0])
      : null;
  }
  if (!pageContent) {
    return renderNotFoundHtml(pageCtx);
  }
  const withTranslations = {
    ...pageCtx,
    languageLinks: languageLinksFor(
      pageCtx.languages,
      pageCtx.locale,
      pageCtx.restPath,
      pageCtx.defaultLocale,
      alternates,
    ),
  };
  const withHeader = await applyPageHeader(
    req,
    res,
    withTranslations,
    pageContent.fields,
    preview,
    submittedFormIdFrom(req),
    { id: String(pageContent.id), type: String(pageContent.type) },
  );
  const blogCtx = await buildBlogRenderContext(pageCtx.locale, pageNumber, basePath);
  const commentCtx = await buildCommentContext(
    req,
    {
      id: String(pageContent.id),
      type: String(pageContent.type),
      slug: String(pageContent.slug ?? slug),
      publishedAt: pageContent.publishedAt ?? null,
      fields: pageContent.fields,
      translationGroupId: pageContent.translationGroupId,
    },
    pageCtx,
    reqPath,
  );
  const bodyHtml = withSiteWidgets(
    await applyContentRender(
      await renderBlocksHtml(
        await applyContentBlocks(pageContent.blocks.blocks, pageContent),
        submittedFormIdFrom(req),
        blogCtx,
        commentCtx,
      ),
      pageContent,
    ),
    withHeader,
  );
  const formattedDate = pageContent.publishedAt
    ? await formatContentDate(pageContent.publishedAt)
    : null;

  const templateOpts: TemplateRenderOpts = {
    submittedFormId: submittedFormIdFrom(req),
    blogCtx,
    commentCtx,
    preview,
  };
  const templateHtml = await renderThemeTemplateHtml(
    {
      kind: "singular",
      contentType: String(pageContent.type),
      slug: String(pageContent.slug ?? slug),
    },
    withHeader,
    templateBlockContext(
      {
        content: {
          id: String(pageContent.id),
          type: String(pageContent.type),
          title: pageContent.title,
          slug: String(pageContent.slug ?? slug),
          excerpt: pageContent.excerpt ?? null,
          fields: pageContent.fields,
          publishedAt: pageContent.publishedAt ?? null,
        },
        formattedDate,
        contentBodyHtml: bodyHtml,
      },
      withHeader,
      templateOpts,
    ),
    {
      content: pageContent,
      alternates,
      formattedDate,
      title: pageContent.title,
      mainClass: String(pageContent.type) === "page" ? "site-main site-main--page" : "site-main",
    },
    templateOpts,
  );
  if (templateHtml) return templateHtml;

  return renderPage("single", {
    ...withHeader,
    content: pageContent,
    bodyHtml,
    alternates,
    formattedDate,
    title: pageContent.title,
  });
}

/** Parses a `/page/:num` segment, rejecting anything but a plain positive integer. */
function parsePageNumber(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

router.get("/:segment", async (req, res, next) => {
  const segment = req.params.segment!;
  if (RESERVED.has(segment)) {
    next();
    return;
  }

  try {
    if (!(await ensureSiteIsPublic(req, res))) return;
    const activeLocales = await getActiveLocaleCodes();
    const defaultLocale = await getDefaultLocale();
    const preview = await isPreviewAllowed(req, res);
    const canonical = canonicalLocaleRedirect(req.path, activeLocales, defaultLocale);
    if (canonical) {
      res.redirect(302, canonical + previewQuery(req));
      return;
    }
    const ctx = await buildPageContext(req, res, req.path, preview);

    if (matchActiveLocale(segment, activeLocales) && req.path === `/${segment}`) {
      await sendPublicHtml(req, res, req.path, preview, () =>
        renderHomeHtml(req, res, req.path, preview),
      );
      return;
    }

    const slug = matchActiveLocale(segment, activeLocales) ? "" : segment;
    if (!slug) {
      next();
      return;
    }

    const content = await getPublishedContentBySlug(slug, ctx.locale, preview);
    if (!content) {
      await sendPublicHtml(
        req,
        res,
        `${req.path}:404`,
        preview,
        async () => {
          const ctx404 = await buildPageContext(req, res, req.path, preview);
          return renderNotFoundHtml(ctx404);
        },
        404,
      );
      return;
    }

    const translatedPath = translatedSlugPath(content, slug, ctx.locale, defaultLocale);
    if (translatedPath) {
      res.redirect(302, translatedPath + previewQuery(req));
      return;
    }

    const siteId = await getSiteId();
    const home = siteId ? await getHomeContent(siteId, ctx.locale, preview) : null;
    if (home && isHomeContentSlug(content, home) && !preview) {
      res.redirect(302, localePath(ctx.locale, "/", defaultLocale) + previewQuery(req));
      return;
    }

    let alternates: Array<{ locale: string; slug: string; href: string }> = [];
    if (content.translationGroupId) {
      const translations = await getTranslationAlternates(content.translationGroupId);
      alternates = translations.map((tr) => ({
        ...tr,
        href: localePath(tr.locale, `/${tr.slug}`, defaultLocale),
      }));
    }

    await sendPublicHtml(req, res, req.path, preview, () =>
      renderSinglePageHtml(req, res, req.path, slug, ctx.locale, preview, alternates, 1, req.path),
    );
  } catch (err) {
    console.error("[justflows] page render failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

router.get("/:segment/page/:num", async (req, res, next) => {
  const segment = req.params.segment!;
  const num = parsePageNumber(req.params.num!);
  if (RESERVED.has(segment) || num === null) {
    next();
    return;
  }

  try {
    if (!(await ensureSiteIsPublic(req, res))) return;
    const activeLocales = await getActiveLocaleCodes();
    if (matchActiveLocale(segment, activeLocales)) {
      next();
      return;
    }
    const preview = await isPreviewAllowed(req, res);
    const ctx = await buildPageContext(req, res, req.path, preview);
    const basePath = `/${segment}`;

    const content = await getPublishedContentBySlug(segment, ctx.locale, preview);
    if (!content) {
      await sendPublicHtml(
        req,
        res,
        `${req.path}:404`,
        preview,
        async () => {
          const ctx404 = await buildPageContext(req, res, req.path, preview);
          return renderNotFoundHtml(ctx404);
        },
        404,
      );
      return;
    }

    const translatedPath = translatedSlugPath(content, segment, ctx.locale, ctx.defaultLocale);
    if (translatedPath) {
      res.redirect(302, translatedPath + previewQuery(req));
      return;
    }

    if (num === 1) {
      const canonicalPath = localePath(content.locale, `/${content.slug}`, ctx.defaultLocale);
      res.redirect(302, canonicalPath + previewQuery(req));
      return;
    }

    let alternates: Array<{ locale: string; slug: string; href: string }> = [];
    if (content.translationGroupId) {
      const defaultLocale = await getDefaultLocale();
      const translations = await getTranslationAlternates(content.translationGroupId);
      alternates = translations.map((tr) => ({
        ...tr,
        href: localePath(tr.locale, `/${tr.slug}`, defaultLocale),
      }));
    }

    await sendPublicHtml(req, res, req.path, preview, () =>
      renderSinglePageHtml(
        req,
        res,
        req.path,
        segment,
        ctx.locale,
        preview,
        alternates,
        num,
        basePath,
      ),
    );
  } catch (err) {
    console.error("[justflows] paginated page render failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

router.get("/:locale/:slug", async (req, res, next) => {
  const localeSeg = req.params.locale!;
  const slug = req.params.slug!;

  if (RESERVED.has(localeSeg) || RESERVED.has(slug)) {
    next();
    return;
  }

  const activeLocales = await getActiveLocaleCodes();
  const locale = matchActiveLocale(localeSeg, activeLocales);
  if (!locale) {
    next();
    return;
  }

  try {
    if (!(await ensureSiteIsPublic(req, res))) return;
    const defaultLocale = await getDefaultLocale();
    const preview = await isPreviewAllowed(req, res);
    const canonical = canonicalLocaleRedirect(req.path, activeLocales, defaultLocale);
    if (canonical) {
      res.redirect(302, canonical + previewQuery(req));
      return;
    }
    const content = await getPublishedContentBySlug(slug, locale, preview);

    if (!content) {
      await sendPublicHtml(
        req,
        res,
        `${req.path}:404`,
        preview,
        async () => {
          const ctx404 = await buildPageContext(req, res, req.path, preview);
          return renderNotFoundHtml(ctx404);
        },
        404,
      );
      return;
    }

    const translatedPath = translatedSlugPath(content, slug, locale, defaultLocale);
    if (translatedPath) {
      res.redirect(302, translatedPath + previewQuery(req));
      return;
    }

    const siteId = await getSiteId();
    const home = siteId ? await getHomeContent(siteId, locale, preview) : null;
    if (home && isHomeContentSlug(content, home) && !preview) {
      res.redirect(302, localePath(locale, "/", defaultLocale) + previewQuery(req));
      return;
    }

    let alternates: Array<{ locale: string; slug: string; href: string }> = [];
    if (content.translationGroupId) {
      const translations = await getTranslationAlternates(content.translationGroupId);
      alternates = translations.map((tr) => ({
        ...tr,
        href: localePath(tr.locale, `/${tr.slug}`, defaultLocale),
      }));
    }

    await sendPublicHtml(req, res, req.path, preview, () =>
      renderSinglePageHtml(req, res, req.path, slug, locale, preview, alternates, 1, req.path),
    );
  } catch (err) {
    console.error("[justflows] localised page render failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

router.get("/:locale/:slug/page/:num", async (req, res, next) => {
  const localeSeg = req.params.locale!;
  const slug = req.params.slug!;
  const num = parsePageNumber(req.params.num!);

  if (RESERVED.has(localeSeg) || RESERVED.has(slug) || num === null) {
    next();
    return;
  }

  const activeLocales = await getActiveLocaleCodes();
  const locale = matchActiveLocale(localeSeg, activeLocales);
  if (!locale) {
    next();
    return;
  }

  try {
    if (!(await ensureSiteIsPublic(req, res))) return;
    const preview = await isPreviewAllowed(req, res);
    const defaultLocale = await getDefaultLocale();
    const canonical = canonicalLocaleRedirect(req.path, activeLocales, defaultLocale);
    if (canonical) {
      res.redirect(302, canonical + previewQuery(req));
      return;
    }
    const basePath = localePath(locale, `/${slug}`, defaultLocale);
    const content = await getPublishedContentBySlug(slug, locale, preview);

    if (!content) {
      await sendPublicHtml(
        req,
        res,
        `${req.path}:404`,
        preview,
        async () => {
          const ctx404 = await buildPageContext(req, res, req.path, preview);
          return renderNotFoundHtml(ctx404);
        },
        404,
      );
      return;
    }

    const translatedPath = translatedSlugPath(content, slug, locale, defaultLocale);
    if (translatedPath) {
      res.redirect(302, translatedPath + previewQuery(req));
      return;
    }

    if (num === 1) {
      const canonicalPath = localePath(locale, `/${content.slug}`, defaultLocale);
      res.redirect(302, canonicalPath + previewQuery(req));
      return;
    }

    let alternates: Array<{ locale: string; slug: string; href: string }> = [];
    if (content.translationGroupId) {
      const translations = await getTranslationAlternates(content.translationGroupId);
      alternates = translations.map((tr) => ({
        ...tr,
        href: localePath(tr.locale, `/${tr.slug}`, defaultLocale),
      }));
    }

    await sendPublicHtml(req, res, req.path, preview, () =>
      renderSinglePageHtml(req, res, req.path, slug, locale, preview, alternates, num, basePath),
    );
  } catch (err) {
    console.error("[justflows] localised paginated page render failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

router.post("/set-locale", async (req, res) => {
  const locale = String(req.body?.locale ?? "");
  const resolved = await resolveContentLocale(locale);
  setLocaleCookie(res, resolved);
  res.json({ ok: true, locale: resolved });
});

// Nothing above matched. The single-segment (`/:segment`) and localised
// (`/:locale/:slug`) handlers already answer unknown slugs with the themed 404,
// but a multi-segment path like `/foo/bar` — or a reserved first segment that no
// earlier route claimed — used to fall off the end of the router into Express's
// bare `Cannot GET`. Serve the site's normal 404 instead: the theme's
// `templates/404.json` when it ships one, otherwise the built-in JF `404` view.
router.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  void sendPublicNotFound(req, res).catch(next);
});

export { LOCALE_COOKIE };
export default router;
