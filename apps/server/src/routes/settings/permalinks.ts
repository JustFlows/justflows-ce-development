// SPDX-License-Identifier: MIT

import { Router, type Request, type Response } from "express";
import { publicPageRateLimit } from "../../middleware/public-page-rate-limit.js";
import {
  getPermalinkState,
  permalinkContent,
  reservedPermalinkPath,
  listPermalinkTerms,
  taxonomyPermalink,
} from "../../lib/navigation/permalinks-db.js";
import { permalinkPath, slashPath } from "../../lib/navigation/permalinks.js";
import { getSiteId } from "../../lib/settings/site-settings.js";
import { getDefaultLocale, getActiveLocaleCodes } from "../../lib/i18n/languages-db.js";
import { localePath, parseLocalePrefix } from "../../lib/i18n/locales.js";
import { getHomeContent } from "../../lib/content/home-page.js";
import { getVisibilityScope } from "../../lib/content/visibility-scope.js";
import type { ContentResponse } from "../../lib/content/content-api.js";

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
      /** Set when a locale-prefixed URL renders untranslated default-locale content. */
      canonicalPath?: string;
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
    publicPageRateLimit,
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
        /** A hidden item leaves this list, so its URL, id, redirects, and archive entries all act as if it never existed. */
        const visibility = preview ? null : await getVisibilityScope(siteId);
        const items = candidates.filter(
          (item) =>
            activeLocales.includes(item.locale) &&
            (item.status === "published" || (preview && item.status === "draft")) &&
            (!visibility || visibility.allows(item)),
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
                comparable(permalinkPath(item, state.settings, defaultLocale, state.layoutScopes)) ===
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
          const path = permalinkPath(item, state.settings, defaultLocale, state.layoutScopes);
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
          if (match) target = permalinkPath(match, state.settings, defaultLocale, state.layoutScopes);
        }
        // `/nl-NL/product/x` with no Dutch translation: show the default-locale
        // entry under the Dutch URL (Dutch chrome, links stay in /nl-NL) instead
        // of a 404, with canonical pointing at the original. A translation that
        // lives at another slug gets a redirect to its own URL.
        if (!match && !identity && root.locale && root.locale !== defaultLocale) {
          const rest = parseLocalePrefix(requestedPath, activeLocales).restPath;
          const source =
            rest === "/"
              ? undefined
              : items.find(
                  (item) =>
                    item.locale === defaultLocale &&
                    comparable(permalinkPath(item, state.settings, defaultLocale, state.layoutScopes)) ===
                      comparable(rest),
                );
          const sourcePath = source
            ? permalinkPath(source, state.settings, defaultLocale, state.layoutScopes)
            : "";
          if (source && !sourcePath.includes("?")) {
            if (!(await handlers.canView(req, res))) return;
            const translation = source.translationGroupId
              ? items.find(
                  (item) =>
                    item.translationGroupId === source.translationGroupId &&
                    item.locale === root.locale,
                )
              : undefined;
            if (translation) {
              res.redirect(
                preview ? 302 : 301,
                permalinkPath(translation, state.settings, defaultLocale, state.layoutScopes),
              );
              return;
            }
            const home = await getHomeContent(siteId, defaultLocale, false);
            const basePath = slashPath(
              localePath(root.locale, home?.id === source.id ? "/" : sourcePath, defaultLocale),
              state.settings.trailingSlash,
            );
            const localizedTarget =
              pagination && pageNumber > 1
                ? slashPath(`${basePath.replace(/\/$/, "")}/page/${pageNumber}`, state.settings.trailingSlash)
                : basePath;
            if (req.path !== localizedTarget || home?.id === source.id) {
              res.redirect(preview ? 302 : 301, localizedTarget);
              return;
            }
            const alternates = items
              .filter(
                (item) =>
                  source.translationGroupId && item.translationGroupId === source.translationGroupId,
              )
              .map((item) => ({
                locale: item.locale,
                slug: item.slug,
                href: permalinkPath(item, state.settings, defaultLocale, state.layoutScopes),
              }));
            await handlers.renderContent(req, res, {
              content: source,
              path: localizedTarget,
              basePath,
              pageNumber,
              alternates,
              canonicalPath: sourcePath,
            });
            return;
          }
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
              path: permalinkPath(item, state.settings, defaultLocale, state.layoutScopes),
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
            href: permalinkPath(item, state.settings, defaultLocale, state.layoutScopes),
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
