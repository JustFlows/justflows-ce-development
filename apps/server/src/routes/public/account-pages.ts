// SPDX-License-Identifier: MIT

import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { getAdminPathConfig } from "../../lib/admin/admin-path.js";
import { accountPages } from "../../lib/account/pages.js";
import { getSiteId } from "../../lib/settings/site-settings.js";
import { optionalSession } from "../../middleware/auth.js";
import { privateAccountResponse } from "../../middleware/account-cache.js";
import { securityHeaders } from "../../middleware/security-headers.js";
import { withoutSharedCache } from "../../lib/cache/jf-cache.js";
import { isPreviewAllowed } from "../../lib/auth/auth-session.js";
import type { ContentResponse } from "../../lib/content/content-api.js";

const reads = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
export const accountPagesRouter = Router();

export async function serveAccountContent(req: Request, res: Response, content: ContentResponse, url: string, pageNumber = 1): Promise<void> {
  privateAccountResponse(res); res.locals.jfPrivateContent = true;
  if (!req.session) { res.redirect("/login"); return; }
  const requestPath = req.originalUrl.split("?")[0] || req.path;
  const pagination = requestPath.match(/^(.*)\/page\/([1-9][0-9]*)\/?$/);
  const requested = (pagination?.[1] ?? requestPath).replace(/\/$/, "");
  if (requested !== url.split("?")[0]!.replace(/\/$/, "")) {
    const target = pageNumber > 1 ? `${url.replace(/\/$/, "")}/page/${pageNumber}` : url;
    const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    res.redirect(302, target + query); return;
  }
  const preview = await isPreviewAllowed(req, res);
  if (content.status !== "published" && !preview) { res.status(404).send("Not found"); return; }
  await new Promise<void>((resolve, reject) => securityHeaders(req, res, error => error ? reject(error) : resolve()));
  const html = await withoutSharedCache(async () => {
    const { renderSinglePageHtml } = await import("./public-site.js");
    return renderSinglePageHtml(req, res, requestPath, content.slug, content.locale, preview, [], pageNumber, url, content, false, url);
  });
  const assets = '<link rel="stylesheet" href="/css/account.css"><script src="/js/account.js" defer></script>';
  res.type("html").send(html.includes('id="initial-account"') ? html.replace("</head>", assets + "</head>") : html);
}

/** Classify private content before static export serving or public page-cache lookup. */
accountPagesRouter.use(async (req, res, next) => {
  if (!["GET", "HEAD"].includes(req.method) || req.path.includes(".") || /^\/(api|ext|assets|js|css|public|css-providers|uploads|install|login|register)(\/|$)/.test(req.path)) { next(); return; }
  try {
    const siteId = await getSiteId(); if (!siteId) { next(); return; }
    const admin = (await getAdminPathConfig()).path;
    if (req.path === admin || req.path.startsWith(`${admin}/`)) { next(); return; }
    const pages = await accountPages(siteId);
    const pagination = req.path.match(/^(.*)\/page\/([1-9][0-9]*)\/?$/);
    const pageNumber = pagination ? Number(pagination[2]) : 1;
    const normalized = (pagination?.[1] ?? req.path).replace(/\/$/, "") || "/";
    const page = pages.find(page => [page.url, ...page.aliases].some(url => (url.split("?")[0]!.replace(/\/$/, "") || "/") === normalized) || req.query.p === page.content.id);
    if (!page) { next(); return; }
    privateAccountResponse(res);
    if (!Number.isSafeInteger(pageNumber)) { res.status(404).send("Not found"); return; }
    reads(req, res, error => {
      if (error) { next(error); return; }
      optionalSession(req, res, error => {
        if (error) { next(error); return; }
        void serveAccountContent(req, res, page.content, page.url, pageNumber).catch(next);
      });
    });
  } catch (error) { next(error); }
});
