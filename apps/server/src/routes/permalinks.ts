// SPDX-License-Identifier: MIT

import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import {
  getPermalinkState,
  permalinkContent,
  reservedPermalinkPath,
  listPermalinkTerms,
  taxonomyPermalink,
} from "../lib/permalinks-db.js";
import { permalinkPath, slashPath } from "../lib/permalinks.js";
import { getSiteId } from "../lib/site-settings.js";
import { getDefaultLocale, getActiveLocaleCodes } from "../lib/i18n/languages-db.js";
import { localePath, parseLocalePrefix } from "../lib/i18n/locales.js";
import { getHomeContent } from "../lib/home-page.js";
import type { ContentResponse } from "../lib/content-api.js";

interface PermalinkHandlers {
  canView(req: Request, res: Response): Promise<boolean>;
  previewAllowed?(req: Request, res: Response): Promise<boolean>;
  renderContent(
    req: Request,
    res: Response,
    data: {
      content: ContentResponse;
      path: string;
      basePath: string;
      pageNumber: number;
      alternates: Array<{ locale: string; slug: string; href: string }>;
    },
  ): Promise<void>;
  renderArchive(
    req: Request,
    res: Response,
    data: {
      path: string;
      name: string;
      items: Array<{ title: string; path: string }>;
    },
  ): Promise<void>;
}

/** Resolves identity and canonical redirects before the legacy locale-aware routes. */
export function createPermalinkRouter(handlers: PermalinkHandlers): Router {
  const router = Router();
  router.use(
    rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false }),
    async (req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        next();
        return;
      }
      try {
        if (await reservedPermalinkPath(req.path)) {
          next();
          return;
        }
        const siteId = await getSiteId();
        if (!siteId) {
          next();
          return;
        }
        const preview = (await handlers.previewAllowed?.(req, res)) ?? false;
        const [state, candidates, defaultLocale, activeLocales] = await Promise.all([
          getPermalinkState(siteId),
          permalinkContent(siteId, !preview),
          getDefaultLocale(siteId),
          getActiveLocaleCodes(),
        ]);
        const items = candidates.filter(
          (item) =>
            activeLocales.includes(item.locale) &&
            (item.status === "published" || (preview && item.status === "draft")),
        );
        const identity = typeof req.query.p === "string" ? req.query.p : null;
        let pagination = req.path.match(/^(.*)\/page\/([1-9][0-9]*)\/?$/);
        let pageNumber = pagination ? Number(pagination[2]) : 1;
        if (!Number.isSafeInteger(pageNumber)) {
          next();
          return;
        }
        const requestedPath = pagination ? pagination[1] || "/" : req.path;
        let incoming = requestedPath + (identity ? `?p=${encodeURIComponent(identity)}` : "");
        const root = parseLocalePrefix(req.path, activeLocales);
        if (!identity && root.locale && root.restPath === "/") {
          const canonical = slashPath(
            localePath(root.locale, "/", defaultLocale),
            state.settings.trailingSlash,
          );
          if (req.path !== canonical) {
            if (!(await handlers.canView(req, res))) return;
            const query = req.originalUrl.includes("?") ? `?${req.originalUrl.split("?")[1]}` : "";
            res.redirect(301, canonical + query);
            return;
          }
        }
        const comparable = (path: string) => {
          const [pathname, query] = path.split("?");
          const { locale, restPath } = parseLocalePrefix(pathname!, activeLocales);
          return slashPath(
            localePath(locale ?? defaultLocale, restPath, defaultLocale) +
              (query ? `?${query}` : ""),
            "never",
          );
        };
        // A real content URL ending in /page/2 takes precedence over pagination.
        const fullIncoming = req.path + (identity ? `?p=${encodeURIComponent(identity)}` : "");
        if (
          pagination &&
          (state.redirects[fullIncoming] ||
            items.some(
              (item) =>
                comparable(permalinkPath(item, state.settings, defaultLocale)) ===
                comparable(fullIncoming),
            ))
        ) {
          pagination = null;
          pageNumber = 1;
          incoming = fullIncoming;
        }
        let match: (typeof items)[number] | undefined;
        let target = "";
        for (const item of items) {
          const path = permalinkPath(item, state.settings, defaultLocale);
          if (comparable(incoming) === comparable(path)) {
            match = item;
            target = path;
            break;
          }
        }
        if (!match) {
          const historicalId =
            state.redirects[incoming] ??
            state.redirects[slashPath(incoming, "never")] ??
            state.redirects[slashPath(incoming, "always")];
          match = items.find((item) => item.id === historicalId);
          if (!match) {
            const legacy = items.filter(
              (item) =>
                comparable(localePath(item.locale, `/${item.slug}`, defaultLocale)) ===
                comparable(incoming),
            );
            if (legacy.length > 1) {
              res.sendStatus(404);
              return;
            }
            match = legacy[0];
          }
          if (match) target = permalinkPath(match, state.settings, defaultLocale);
        }
        if (!match) {
          if (identity) {
            res.sendStatus(404);
            return;
          }
          const terms = await listPermalinkTerms(siteId);
          const parsed = parseLocalePrefix(req.path, activeLocales);
          const locale = parsed.locale ?? defaultLocale;
          let archive = terms.find(
            (term) =>
              comparable(taxonomyPermalink(term, locale, state.settings, defaultLocale)) ===
              comparable(incoming),
          );
          const historical =
            state.archiveRedirects?.[incoming] ??
            state.archiveRedirects?.[slashPath(incoming, "never")] ??
            state.archiveRedirects?.[slashPath(incoming, "always")];
          if (!archive && historical)
            archive = terms.find((term) => `${locale}:${term.id}` === historical);
          if (!archive || pagination) {
            next();
            return;
          }
          if (!(await handlers.canView(req, res))) return;
          const archivePath = taxonomyPermalink(archive, locale, state.settings, defaultLocale);
          if (incoming !== archivePath) {
            res.redirect(301, archivePath);
            return;
          }
          const archiveItems = items.filter(
            (item) =>
              item.status === "published" &&
              item.locale === locale &&
              archive!.contentIds.includes(item.id),
          );
          await handlers.renderArchive(req, res, {
            path: archivePath,
            name: archive.name,
            items: archiveItems.map((item) => ({
              title: item.title,
              path: permalinkPath(item, state.settings, defaultLocale),
            })),
          });
          return;
        }
        if (!(await handlers.canView(req, res))) return;
        const home = await getHomeContent(siteId, match.locale, false);
        if (home?.id === match.id)
          target = slashPath(
            localePath(match.locale, "/", defaultLocale),
            state.settings.trailingSlash,
          );
        const baseTarget = target;
        if (pagination && pageNumber > 1 && !target.includes("?"))
          target = slashPath(
            `${target.replace(/\/$/, "")}/page/${pageNumber}`,
            state.settings.trailingSlash,
          );
        const actualIncoming = req.path + (identity ? `?p=${encodeURIComponent(identity)}` : "");
        if (actualIncoming !== target) {
          const query = new URLSearchParams(req.originalUrl.split("?")[1] ?? "");
          query.delete("p");
          const suffix = query.toString();
          res.redirect(
            preview ? 302 : 301,
            target + (suffix ? `${target.includes("?") ? "&" : "?"}${suffix}` : ""),
          );
          return;
        }
        if (home?.id === match.id) {
          next();
          return;
        }
        const alternates = items
          .filter(
            (item) =>
              match!.translationGroupId && item.translationGroupId === match!.translationGroupId,
          )
          .map((item) => ({
            locale: item.locale,
            slug: item.slug,
            href: permalinkPath(item, state.settings, defaultLocale),
          }));
        await handlers.renderContent(req, res, {
          content: match,
          path: target,
          basePath: baseTarget,
          pageNumber,
          alternates,
        });
      } catch (err) {
        next(err);
      }
    },
  );
  return router;
}
