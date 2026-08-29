import { Router, type Request, type Response } from "express";
import ejs from "ejs";
import path from "node:path";
import {
  getPublishedContentBySlug,
  getTranslationAlternates,
} from "../lib/content-public.js";
import {
  getActiveLocaleCodes,
  getDefaultLocale,
  listLanguages,
  resolveContentLocale,
} from "../lib/i18n/languages-db.js";
import { localePath, matchActiveLocale, displayLocaleCode } from "../lib/i18n/locales.js";
import { formatContentDate, getGeneralSettings } from "../lib/general-settings.js";
import { hydrateSiteWidgets } from "../lib/site-widgets.js";
import { applyContentBlocks, applyContentRender } from "../lib/content-render.js";
import { createTranslator, type MessageCatalog } from "../lib/i18n/translate.js";
import {
  defaultModsFromSchema,
  getNavigationMenuSlugs,
  getSiteIdentity,
  getThemeMods,
  mergeMods,
} from "../lib/theme-customize.js";
import { getNavItemsForMenuSlug } from "../lib/menus-db.js";
import { getEffectiveHomeBlocks } from "../lib/theme-home-blocks.js";
import { getHomeContent, isHomeContentSlug } from "../lib/home-page.js";
import { headerBrandFlags, headerFromContentFields, resolveHeaderMenuSlug, type PageHeaderConfig } from "../lib/page-header.js";
import { ensureCssProvidersTable, getActiveCssProvider } from "../lib/css-providers-db.js";
import { resolveProviderAssets } from "../lib/css-providers-files.js";
import { ensureThemesTable, getActiveTheme, getSiteId } from "../lib/themes-db.js";
import { viewsDir } from "../lib/jf-root.js";
import { getJustflowsVersion } from "../lib/version.js";
import { parseLocalePrefix, setLocaleCookie, LOCALE_COOKIE } from "../middleware/locale.js";
import { isPreviewAllowed } from "../lib/auth-session.js";
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
  THEME_MODS_PREFIX,
} from "../lib/public-cache.js";
import { getJfCache } from "../lib/jf-cache.js";
import { getRuntimeBlockRegistry } from "../lib/runtime-blocks.js";
import type { BlockNode } from "../lib/types.js";
import { withBlockChrome } from "@justflows/blocks";
import { FORMS_BLOCK_TYPE, renderFormBlockHtml } from "../lib/forms-public.js";
import { isGalleryPluginEnabled, registerGalleryBlock, unregisterGalleryBlock } from "../lib/gallery-public.js";
import {
  BLOG_POST_LIST_BLOCK_TYPE,
  registerBlogPostListBlock,
  renderBlogPostListBlockHtml,
  type BlogPostListRenderContext,
} from "../lib/blog-public.js";
import { getSiteSetting } from "../lib/site-settings.js";
import { buildFaviconHeadHtml } from "../lib/favicon.js";

const templateDir = viewsDir();
const router = Router();
const blockRegistry = getRuntimeBlockRegistry();
registerBlogPostListBlock();

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
  return rememberPublic(`${THEME_MODS_PREFIX}${preview ? "preview" : "live"}`, async () => {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) return defaultModsFromSchema();

    const theme = await getActiveTheme(siteId);
    const themeId = theme?.theme_id ?? "justflows.default";
    const defaults = defaultModsFromSchema();
    const published = (await getThemeMods(themeId, false)) ?? {};
    const draft = preview ? ((await getThemeMods(themeId, true)) ?? {}) : {};
    return mergeMods(mergeMods(defaults, published), draft);
  }, preview);
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
): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === FORMS_BLOCK_TYPE) {
      parts.push(withBlockChrome(await renderFormBlockHtml(block.props ?? {}, submittedFormId), block));
      continue;
    }
    if (block.type === BLOG_POST_LIST_BLOCK_TYPE && blogCtx) {
      try {
        parts.push(withBlockChrome(await renderBlogPostListBlockHtml(block.props ?? {}, blogCtx), block));
      } catch {
        parts.push("");
      }
      continue;
    }
    const def = blockRegistry.get(block.type);
    const children = Array.isArray(block.children) ? block.children : [];
    if (def?.supportsChildren && children.length > 0) {
      try {
        const childHtml = await renderBlockTree(children, submittedFormId, blogCtx);
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
    (block) => block.type === "core.reusable" || (block.children?.length ? containsReusable(block.children) : false),
  );
}

async function renderBlocksHtml(
  blocks: BlockNode[],
  submittedFormId?: string,
  blogCtx?: BlogPostListRenderContext,
): Promise<string> {
  if (await isGalleryPluginEnabled()) registerGalleryBlock();
  else unregisterGalleryBlock();
  const resolved = await withReusables(blocks);
  try {
    return await renderBlockTree(resolved, submittedFormId, blogCtx);
  } catch {
    return renderBlockTree(resolved, submittedFormId, blogCtx);
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

function withSiteWidgets(
  html: string,
  ctx: { languageLinks: Array<{ code: string; name: string; href: string; current: boolean; displayCode?: string }>; usersCanRegister: boolean; t: (key: string) => string },
): string {
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
    html = hooks.applyFilterSync(
      "site.underConstruction.render",
      html,
      hookContext,
      { siteId, source: "http" },
    );
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

async function loadNavItems(
  menuSlug: string,
  locale: string,
  defaultLocale: string,
  preview: boolean,
): Promise<Awaited<ReturnType<typeof getNavItemsForMenuSlug>>> {
  return rememberPublic(
    `${MENUS_PREFIX}${menuSlug}:${locale}:${defaultLocale}:${preview ? "preview" : "live"}`,
    () => getNavItemsForMenuSlug(menuSlug, locale, defaultLocale, preview),
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
  const bypass = preview || isFormConfirmation(req);
  if (bypass || !getJfCache().enabled) {
    res.locals.jfPageCache = "BYPASS";
  }
  const html = await getCachedPageHtml(pageKey, bypass, render);
  res.status(status).type("html").send(html);
  if (!preview && status < 400) {
    void import("../lib/analytics-public.js")
      .then(({ recordPublicPageview }) => recordPublicPageview(req))
      .catch(() => undefined);
  }
}

async function renderPage(view: string, data: Record<string, unknown>): Promise<string> {
  const pageData = { ...data, localePath, justflowsVersion: getJustflowsVersion() };
  const hooks = getRuntimeHooks();
  const siteId = (await getSiteId()) ?? "";
  const content = data.content as
    | { title?: string; excerpt?: string | null; fields?: Record<string, unknown> }
    | undefined;
  const seoFromContent = content ? seoTextFromContent(content) : { title: "", description: "", canonical: "", image: "" };
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
  if (hooks.has("html.head")) {
    headExtra = hooks.applyFilterSync(
      "html.head",
      headExtra,
      {
        siteId,
        path: String(data.restPath ?? "/"),
        title: pageTitle,
        contentId: typeof data.content === "object" && data.content && "id" in (data.content as object)
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
  return ejs.renderFile(path.join(templateDir, "layout.ejs"), {
    ...pageData,
    body,
    headExtra,
    analyticsHead,
    analyticsBody,
    title: documentTitle,
  });
}

function languageLinksFor(
  languages: Array<{ code: string; nativeName: string }>,
  currentLocale: string,
  restPath: string,
  defaultLocale: string,
  translations: Array<{ locale: string; slug: string }> = [],
): Array<{ code: string; name: string; href: string; current: boolean; displayCode: string }> {
  const slugByLocale = new Map(translations.map((tr) => [tr.locale, tr.slug]));
  return languages.map((lang) => {
    const translatedSlug = slugByLocale.get(lang.code);
    const path = translatedSlug ? `/${translatedSlug}` : restPath;
    return {
      code: lang.code,
      name: lang.nativeName,
      href: localePath(lang.code, path, defaultLocale),
      current: lang.code === currentLocale,
      displayCode: displayLocaleCode(lang.code),
    };
  });
}

async function buildPageContext(reqPath: string, preview = false) {
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
  const navItems = await loadNavItems(headerMenuSlug ?? "primary", locale, defaultLocale, preview);
  const footerNavItems = await loadNavItems(footerMenuSlug ?? "footer", locale, defaultLocale, preview);

  const languageLinks = languageLinksFor(languages, locale, restPath, defaultLocale);
  const publicPath = localePath(locale, restPath, defaultLocale);
  const header = headerFromContentFields(undefined);
  const general = await getGeneralSettings();

  // Site-wide chrome edited as blocks. Empty means the site never customised
  // one, so the layout keeps its built-in footer rather than rendering nothing.
  const siteId = await getSiteId();
  const footerBlocks = siteId
    ? await rememberPublic(
        `template-part:footer:${preview ? "preview" : "live"}`,
        async () => {
          const { getEffectiveTemplatePart } = await import("../lib/template-parts.js");
          return getEffectiveTemplatePart(siteId, "footer", preview);
        },
        preview,
      )
    : [];
  const footerBlocksHtml = footerBlocks.length > 0
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
    footerNavItems,
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
    usersCanRegister: general.usersCanRegister,
  };
}

async function applyPageHeader<T extends Awaited<ReturnType<typeof buildPageContext>>>(
  ctx: T,
  fields: Record<string, unknown> | undefined,
  preview: boolean,
  submittedFormId?: string,
): Promise<T & { header: PageHeaderConfig; headerBlocksHtml: string }> {
  const header = headerFromContentFields(fields);
  const menuSlug = resolveHeaderMenuSlug(header, ctx.headerMenuSlug);
  const navItems = menuSlug
    ? await loadNavItems(menuSlug, ctx.locale, ctx.defaultLocale, preview)
    : [];
  const withHeader = {
    ...ctx,
    header,
    headerBrand: headerBrandFlags(header, ctx.identity.logoUrl),
    navItems,
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

async function renderHomeHtml(req: Request, reqPath: string, preview: boolean): Promise<string> {
  const ctx = await buildPageContext(reqPath, preview);
  const siteId = await getSiteId();
  const home = siteId ? await getHomeContent(siteId, ctx.locale, preview) : null;
  const withHeader = await applyPageHeader(ctx, home?.fields, preview, submittedFormIdFrom(req));
  const blogCtx = await buildBlogRenderContext(ctx.locale, 1, reqPath);
  if (home) {
    const bodyHtml = withSiteWidgets(
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
    return renderPage("home", {
      ...withHeader,
      content: home,
      bodyHtml,
      seoDescription: ctx.identity.tagline,
      title: home.title,
    });
  }
  const demoBlocks = await loadHomeDemoBlocks(preview);
  const bodyHtml = demoBlocks?.length
    ? withSiteWidgets(await renderBlocksHtml(demoBlocks, submittedFormIdFrom(req), blogCtx), withHeader)
    : undefined;
  return renderPage("home", {
    ...withHeader,
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

router.get("/", async (req, res, next) => {
  if (req.path !== "/") {
    next();
    return;
  }

  try {
    if (!(await ensureSiteIsPublic(req, res))) return;
    const preview = await isPreviewAllowed(req, res);
    await sendPublicHtml(req, res, req.path || "/", preview, () => renderHomeHtml(req, "/", preview));
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
  reqPath: string,
  slug: string,
  locale: string,
  preview: boolean,
  alternates: Array<{ locale: string; slug: string; href: string }>,
  pageNumber: number,
  basePath: string,
): Promise<string> {
  const pageCtx = await buildPageContext(reqPath, preview);
  const pageContent = await getPublishedContentBySlug(slug, locale, preview);
  if (!pageContent) {
    return renderPage("404", { ...pageCtx, title: pageCtx.t("404.title") });
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
  const withHeader = await applyPageHeader(withTranslations, pageContent.fields, preview, submittedFormIdFrom(req));
  const blogCtx = await buildBlogRenderContext(pageCtx.locale, pageNumber, basePath);
  const bodyHtml = withSiteWidgets(
    await applyContentRender(
      await renderBlocksHtml(
        await applyContentBlocks(pageContent.blocks.blocks, pageContent),
        submittedFormIdFrom(req),
        blogCtx,
      ),
      pageContent,
    ),
    withHeader,
  );
  return renderPage("single", {
    ...withHeader,
    content: pageContent,
    bodyHtml,
    alternates,
    formattedDate: pageContent.publishedAt ? await formatContentDate(pageContent.publishedAt) : null,
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
    const ctx = await buildPageContext(req.path, preview);

    if (matchActiveLocale(segment, activeLocales) && req.path === `/${segment}`) {
      await sendPublicHtml(req, res, req.path, preview, () => renderHomeHtml(req, req.path, preview));
      return;
    }

    const slug = matchActiveLocale(segment, activeLocales) ? "" : segment;
    if (!slug) {
      next();
      return;
    }

    const content = await getPublishedContentBySlug(slug, ctx.locale, preview);
    if (!content) {
      await sendPublicHtml(req, res, `${req.path}:404`, preview, async () => {
        const ctx404 = await buildPageContext(req.path, preview);
        return renderPage("404", { ...ctx404, title: ctx404.t("404.title") });
      }, 404);
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
      renderSinglePageHtml(req, req.path, slug, ctx.locale, preview, alternates, 1, req.path),
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
    const ctx = await buildPageContext(req.path, preview);
    const basePath = `/${segment}`;

    const content = await getPublishedContentBySlug(segment, ctx.locale, preview);
    if (!content) {
      await sendPublicHtml(req, res, `${req.path}:404`, preview, async () => {
        const ctx404 = await buildPageContext(req.path, preview);
        return renderPage("404", { ...ctx404, title: ctx404.t("404.title") });
      }, 404);
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
      renderSinglePageHtml(req, req.path, segment, ctx.locale, preview, alternates, num, basePath),
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
      await sendPublicHtml(req, res, `${req.path}:404`, preview, async () => {
        const ctx404 = await buildPageContext(req.path, preview);
        return renderPage("404", { ...ctx404, title: ctx404.t("404.title") });
      }, 404);
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
      renderSinglePageHtml(req, req.path, slug, locale, preview, alternates, 1, req.path),
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
      await sendPublicHtml(req, res, `${req.path}:404`, preview, async () => {
        const ctx404 = await buildPageContext(req.path, preview);
        return renderPage("404", { ...ctx404, title: ctx404.t("404.title") });
      }, 404);
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
      renderSinglePageHtml(req, req.path, slug, locale, preview, alternates, num, basePath),
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

export { LOCALE_COOKIE };
export default router;
