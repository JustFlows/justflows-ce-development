import express from "express";
import { rateLimit } from "express-rate-limit";
import { isInstalled, requireInstalled, blockIfInstalled } from "./middleware/install-guard.js";
import { publicApiGuard } from "./middleware/public-api.js";
import { publicApiCors } from "./middleware/public-api-cors.js";
import { publicApiRateLimit } from "./middleware/public-api-rate-limit.js";
import { logSafe } from "./lib/log-safe.js";
import { adminClientDir, renderAdminPage } from "./lib/admin-ssr.js";
import { adminAccessGate } from "./middleware/admin-access.js";
import { getAdminPathConfig, toInternalAdminPath } from "./lib/admin-path.js";

/** Admin SPA document routes, including the common trailing-slash root. */
export const ADMIN_PAGE_PATH_RE = /^\/admin(?:\/.*)?$/;

/** Register heavy routes (dynamic import — keeps Passenger startup fast). */
export async function registerDeferredRoutes(app: express.Application): Promise<void> {
  // .env can be lost (an ephemeral container, a botched restore) while the
  // database is intact. Confirm against the schema so the install wizard cannot
  // reopen on a live site.
  const { confirmInstalledFromDatabase } = await import("./middleware/install-guard.js");
  await confirmInstalledFromDatabase();

  if (isInstalled()) {
    try {
      const { applyPendingMigrations } = await import("./lib/run-migrations.js");
      await applyPendingMigrations();
    } catch (err) {
      // A half-migrated schema must not serve traffic. Surface the failure so the
      // worker refuses to finish booting instead of running against stale tables.
      console.error("[justflows] Pending migrations failed:", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
    const { startRevisionJobs } = await import("./lib/revision-jobs.js");
    startRevisionJobs();
    const { startCoreAutoUpdateJob } = await import("./lib/core-auto-update.js");
    startCoreAutoUpdateJob();
    const { startTrashPurgeJob } = await import("./lib/trash.js");
    startTrashPurgeJob();
    try {
      const { getSiteId } = await import("./lib/site-settings.js");
      const siteId = await getSiteId();
      if (siteId) {
        const { migrateTemplatePartsFromSettings } =
          await import("./lib/template-parts-migrate.js");
        await migrateTemplatePartsFromSettings(siteId);
        const { migrateThemeDesignsFromSettings } = await import("./lib/theme-designs-migrate.js");
        await migrateThemeDesignsFromSettings(siteId);
        const { backfillSiteHeaderLibrary } = await import("./lib/site-header-backfill.js");
        await backfillSiteHeaderLibrary(siteId);
      }
    } catch (err) {
      console.error("[justflows] template-part / theme-design / header backfill failed:", err);
    }
    // Refresh the site-root .htaccess so existing installs pick up hardening
    // changes on their next boot (fresh installs get it from markInstalled()).
    try {
      const { writeRootHtaccess } = await import("./lib/root-htaccess.js");
      await writeRootHtaccess();
    } catch {
      // Non-fatal: read-only filesystem, nginx host, or a hand-edited file.
    }
  }

  const { ensurePluginRuntime } = await import("./lib/plugin-runtime.js");
  await ensurePluginRuntime();
  if (isInstalled()) {
    const { getSiteId: getSearchSiteId } = await import("./lib/site-settings.js");
    const searchSiteId = await getSearchSiteId();
    if (searchSiteId) await (await import("./lib/search-db.js")).startSearchIndex(searchSiteId);
    const { startWebhookJobs } = await import("./lib/webhooks.js");
    await startWebhookJobs();
    const { installStaticExportAutoRebuild } = await import("./lib/static-export/auto.js");
    installStaticExportAutoRebuild();
    const { startContentScheduleJobs } = await import("./lib/content-scheduling-db.js");
    startContentScheduleJobs();
  }

  const [
    { default: contentRoutes },
    { default: mediaRoutes },
    { default: commentsRoutes },
    { default: usersRoutes },
    { default: settingsRoutes },
    { default: securityRoutes },
    { default: themesRoutes },
    { default: cssProvidersRoutes, cssProviderAssetsRouter },
    { default: pluginsRoutes },
    { default: marketplaceRoutes },
    { default: publicApiRoutes, healthRouter },
    { default: updatesRoutes, dbRouter },
    { default: cacheRoutes },
    { default: performanceRoutes },
    { default: importRoutes },
    { default: siteRoutes, serveThemeCss },
    { default: publicSiteRoutes, sendPublicNotFound },
    { default: languagesRoutes },
    { default: menusRoutes },
    { default: blocksRoutes },
    { default: analyticsRoutes },
    { default: contentTypesRoutes },
    { default: reusableBlocksRoutes, templatePartsRouter },
    { default: siteHeaderRoutes },
    { default: auditRoutes },
    { default: webhooksRoutes },
    { default: preferencesRoutes },
    { default: diagnosticsRoutes },
    { default: cookiesRoutes },
    { default: rolesRoutes },
    { default: trashRoutes },
    { default: emailsRoutes },
    { default: templatesRoutes },
    { default: patternsRoutes },
    { default: staticExportRoutes },
    { default: apiKeysRoutes },
    { default: manageApiRoutes },
  ] = await Promise.all([
    import("./routes/content.js"),
    import("./routes/media.js"),
    import("./routes/comments.js"),
    import("./routes/users.js"),
    import("./routes/settings.js"),
    import("./routes/security.js"),
    import("./routes/themes.js"),
    import("./routes/css-providers.js"),
    import("./routes/plugins.js"),
    import("./routes/marketplace.js"),
    import("./routes/public-api.js"),
    import("./routes/updates.js"),
    import("./routes/cache.js"),
    import("./routes/performance.js"),
    import("./routes/import.js"),
    import("./routes/site.js"),
    import("./routes/public-site.js"),
    import("./routes/languages.js"),
    import("./routes/menus.js"),
    import("./routes/blocks.js"),
    import("./routes/analytics.js"),
    import("./routes/content-types.js"),
    import("./routes/reusable-blocks.js"),
    import("./routes/site-header.js"),
    import("./routes/audit.js"),
    import("./routes/webhooks.js"),
    import("./routes/preferences.js"),
    import("./routes/diagnostics.js"),
    import("./routes/cookies.js"),
    import("./routes/roles.js"),
    import("./routes/trash.js"),
    import("./routes/emails.js"),
    import("./routes/templates.js"),
    import("./routes/patterns.js"),
    import("./routes/static-export.js"),
    import("./routes/api-keys.js"),
    import("./routes/manage-api/index.js"),
  ]);

  const { apiKeyAuth } = await import("./middleware/api-key-auth.js");
  const { manageApiRateLimit } = await import("./middleware/manage-api-rate-limit.js");
  const { manageApiCors, manageApiPreflight } = await import("./middleware/manage-api-cors.js");

  app.use(blockIfInstalled);

  app.use("/api/search", requireInstalled, (await import("./routes/search.js")).default);
  app.use("/api/content", requireInstalled, contentRoutes);
  app.use("/api/trash", requireInstalled, trashRoutes);
  app.use("/api/media", requireInstalled, mediaRoutes);
  app.use("/api/comments", requireInstalled, commentsRoutes);
  app.use("/api/users", requireInstalled, usersRoutes);
  app.use("/api/settings", requireInstalled, settingsRoutes);
  app.use("/api/emails", requireInstalled, emailsRoutes);
  app.use("/api/security", requireInstalled, securityRoutes);
  app.use("/api/themes", requireInstalled, themesRoutes);
  app.use("/api/css-providers", requireInstalled, cssProvidersRoutes);
  app.use("/css-providers", requireInstalled, cssProviderAssetsRouter);
  app.use("/api/plugins", requireInstalled, pluginsRoutes);
  app.use("/api/marketplace", requireInstalled, marketplaceRoutes);
  app.use("/api/health", requireInstalled, healthRouter);
  app.use("/api/updates", requireInstalled, updatesRoutes);
  app.use("/api/cache", requireInstalled, cacheRoutes);
  app.use("/api/performance", requireInstalled, performanceRoutes);
  app.use("/api/db", requireInstalled, dbRouter);
  app.use("/api/import", requireInstalled, importRoutes);
  app.use("/api/static-export", requireInstalled, staticExportRoutes);
  app.use("/api/languages", requireInstalled, languagesRoutes);
  app.use("/api/menus", requireInstalled, menusRoutes);
  app.use("/api/reusable-blocks", requireInstalled, reusableBlocksRoutes);
  app.use("/api/template-parts", requireInstalled, templatePartsRouter);
  app.use("/api/templates", requireInstalled, templatesRoutes);
  app.use("/api/patterns", requireInstalled, patternsRoutes);
  app.use("/api/headers", requireInstalled, siteHeaderRoutes);
  app.use("/api/blocks", requireInstalled, blocksRoutes);
  app.use("/api/analytics", requireInstalled, analyticsRoutes);
  app.use("/api/content-types", requireInstalled, contentTypesRoutes);
  app.use("/api/audit", requireInstalled, auditRoutes);
  app.use("/api/redirects", requireInstalled, (await import("./routes/redirects.js")).default);
  app.use("/api/webhooks", requireInstalled, webhooksRoutes);
  app.use("/api/preferences", requireInstalled, preferencesRoutes);
  app.use("/api/diagnostics", requireInstalled, diagnosticsRoutes);
  app.use("/api/cookies", requireInstalled, cookiesRoutes);
  app.use("/api/roles", requireInstalled, rolesRoutes);

  // Cookie-authenticated management of API keys (Admin → Settings → API).
  app.use("/api/api-keys", requireInstalled, apiKeysRoutes);
  // The federated management API (#135): Bearer-key auth, per-key + per-IP rate
  // limiting, and explicit-origin CORS (never `*`). Preflight runs before auth
  // because a browser sends no Authorization on OPTIONS.
  app.use(
    "/api/manage/v1",
    requireInstalled,
    manageApiPreflight,
    apiKeyAuth,
    ...manageApiRateLimit,
    manageApiCors,
    manageApiRoutes,
  );

  // Everything below is public-facing: one switch (Settings → Public API) takes
  // the whole surface offline. Mounted on the prefix so future public routes
  // inherit the guard automatically.
  app.use("/api/v1", publicApiGuard, publicApiCors, publicApiRateLimit);
  app.use("/api/site", publicApiGuard);

  app.use("/api/v1", publicApiRoutes);
  app.use("/api/site", siteRoutes);
  app.get("/theme.css", serveThemeCss);

  // A statically-exported page submits forms/comments by `fetch()` back to this
  // origin. Answer the CORS preflight for vouched-for origins so that works.
  const { applyFormCors } = await import("./lib/static-export/cors.js");
  const submitPreflight = (req: express.Request, res: express.Response) => {
    if (applyFormCors(req.get("origin"), (n, v) => res.setHeader(n, v))) {
      res.status(204).end();
    } else {
      res.status(403).end();
    }
  };
  // `/justflows-forms/*` is owned by the standalone Forms plugin (its own
  // `ctx.http` routes), but CORS remains a host security policy: plugins cannot
  // set Access-Control-* response headers. Apply it before plugin dispatch so a
  // pure-static site can fetch config and submit back to the Node origin.
  app.use(
    ["/justflows-forms/config", "/justflows-forms/submit"],
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      applyFormCors(req.get("origin"), (n, v) => res.setHeader(n, v));
      next();
    },
  );
  app.options("/justflows-forms/submit", submitPreflight);
  // `applyFormCors` advertises this endpoint too — it needs its own preflight
  // responder or a JSON `Content-Type` fetch is blocked by the browser.
  app.options("/justflows-forms/config", submitPreflight);

  // `POST /justflows-forms/submit` is CSRF-exempt (public, cross-origin form
  // posts from a static export) and dispatched into the out-of-tree Forms
  // plugin. Keep a host-side per-IP ceiling here so an absent or lax
  // plugin-side limiter cannot leave the endpoint an unbounded spam / SMTP sink.
  {
    const { clientIp, consumeRateLimit } = await import("./lib/rate-limit.js");
    app.post(
      "/justflows-forms/submit",
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!consumeRateLimit(`form:ip:${clientIp(req)}`, 10, 10 * 60_000)) {
          res.status(429).type("text/plain").send("Too many submissions — try again later.");
          return;
        }
        next();
      },
    );
  }

  // Only comments keep a host-level submit endpoint.
  app.options("/justflows-comments/submit", submitPreflight);

  app.post("/justflows-comments/submit", requireInstalled, async (req, res) => {
    applyFormCors(req.get("origin"), (n, v) => res.setHeader(n, v));
    try {
      const { acceptCommentSubmission } = await import("./lib/comments-public.js");
      const { clientIp } = await import("./lib/rate-limit.js");
      const { getSession } = await import("./lib/session.js");
      const session = getSession(req);
      const result = await acceptCommentSubmission({
        body: (req.body ?? {}) as Record<string, unknown>,
        host: req.get("host") ?? undefined,
        origin: req.get("origin") ?? undefined,
        referer: req.get("referer") ?? undefined,
        clientIp: clientIp(req),
        session: session
          ? { userId: session.userId, siteId: session.siteId, email: session.email }
          : null,
      });
      if (result.location) {
        res.status(303).location(result.location).end();
        return;
      }
      res
        .status(result.status)
        .type("text/plain")
        .send(result.error ?? "Unable to submit");
    } catch (err) {
      console.error("[justflows] comment submission failed:", err);
      res.status(500).type("text/plain").send("Internal server error");
    }
  });

  // Client pageview beacon — a statically-exported page fires this on load so
  // the first-party analytics counter still works with no server render.
  const SAFE_BEACON_PATH = /^\/[^\s?#]{0,512}$/;
  app.options("/justflows-analytics/collect", submitPreflight);
  app.post("/justflows-analytics/collect", requireInstalled, async (req, res) => {
    applyFormCors(req.get("origin"), (n, v) => res.setHeader(n, v));
    try {
      // Only count a beacon from the site's own origin or a vouched-for export
      // origin. A cross-origin `fetch` from an unrelated page still carries an
      // `Origin` header; drop those so a third-party site cannot inflate this
      // site's pageview / referrer counters. (A non-browser client that omits
      // Origin is still rate-limited below.)
      const beaconOrigin = req.get("origin");
      if (beaconOrigin) {
        const { isAllowedFormOrigin } = await import("./lib/static-export/cors.js");
        const self = `${req.protocol}://${req.get("host") ?? ""}`.toLowerCase();
        if (beaconOrigin.toLowerCase() !== self && !isAllowedFormOrigin(beaconOrigin)) {
          res.status(204).end();
          return;
        }
      }
      const { clientIp, consumeRateLimit } = await import("./lib/rate-limit.js");
      if (!consumeRateLimit(`beacon:ip:${clientIp(req)}`, 120, 60_000)) {
        res.status(204).end();
        return;
      }
      const body = (req.body ?? {}) as { path?: unknown; ref?: unknown };
      let path = typeof body.path === "string" ? body.path : "";
      if (!SAFE_BEACON_PATH.test(path) || path.includes("..")) {
        try {
          path = new URL(req.get("referer") ?? "").pathname;
        } catch {
          path = "";
        }
      }
      if (SAFE_BEACON_PATH.test(path) && !path.includes("..")) {
        // `ref` is the visitor's document.referrer sent by the beacon (the HTTP
        // Referer header is just the page itself on a cross-origin fetch).
        const ref =
          typeof body.ref === "string" && body.ref.length <= 2048 && /^https?:\/\//i.test(body.ref)
            ? body.ref
            : undefined;
        const { recordBeaconPageview } = await import("./lib/analytics-public.js");
        await recordBeaconPageview({
          path,
          userAgent: String(req.headers["user-agent"] ?? ""),
          referer: ref,
          host: req.get("host") ?? undefined,
        });
      }
    } catch (err) {
      console.error("[justflows] analytics beacon failed:", err);
    }
    res.status(204).end();
  });

  app.get("/justflows-comments/unsubscribe", requireInstalled, async (req, res) => {
    try {
      const { clearCommentNotify } = await import("./lib/comments-public.js");
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const ok = await clearCommentNotify(token);
      res
        .status(ok ? 200 : 400)
        .type("text/html")
        .send(
          `<!doctype html><meta charset="utf-8"><title>Comment notifications</title>` +
            `<div style="font:16px/1.5 system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
            (ok
              ? `<h1>Unsubscribed</h1><p>You will no longer receive email about replies to that comment.</p>`
              : `<h1>Link not recognised</h1><p>This unsubscribe link is invalid or has already been used.</p>`) +
            `</div>`,
        );
    } catch (err) {
      console.error("[justflows] comment unsubscribe failed:", err);
      res.status(500).type("text/plain").send("Internal server error");
    }
  });

  // RFC 9116. Served from both the well-known location and the legacy root path.
  const { buildSecurityTxt, securityTxtOrigin } = await import("./lib/security-txt.js");
  for (const route of ["/.well-known/security.txt", "/security.txt"]) {
    app.get(route, (_req, res) => {
      // Built per request so Expires cannot go stale on a long-lived process.
      res.type("text/plain").send(buildSecurityTxt(securityTxtOrigin()));
    });
  }

  app.get("/sitemap.xml", requireInstalled, async (_req, res, next) => {
    try {
      const { buildSitemapXml } = await import("./lib/seo-public.js");
      const { getSiteId } = await import("./lib/themes-db.js");
      const siteId = await getSiteId();
      if (!siteId) {
        next();
        return;
      }
      res.type("application/xml").send(await buildSitemapXml(siteId));
    } catch (err) {
      console.error("[justflows] sitemap build failed:", err);
      res.status(500).type("text/plain").send("Internal server error");
    }
  });

  // Map the configurable public entry path to the stable internal /admin route.
  // APIs stay fixed so a bad proxy rule can always be rolled back safely.
  app.use(async (req, res, next) => {
    try {
      const config = await getAdminPathConfig();
      if (config.path === "/admin") return next();
      if (req.path === "/admin" || req.path.startsWith("/admin/")) {
        if (config.oldPathBehavior === "redirect") {
          res.redirect(302, `${config.path}${req.path.slice("/admin".length)}`);
        } else {
          await sendPublicNotFound(req, res);
        }
        return;
      }
      const internal = toInternalAdminPath(req.path, config.path);
      if (internal) req.url = `${internal}${req.url.slice(req.path.length)}`;
      next();
    } catch (e) {
      next(e);
    }
  });

  app.use("/admin/assets", express.static(`${adminClientDir()}/assets`));

  app.use("/admin", requireInstalled, adminAccessGate);

  app.get(ADMIN_PAGE_PATH_RE, requireInstalled, (req, res, next) => {
    if (req.path.match(/\.\w+$/)) {
      next();
      return;
    }
    void renderAdminPage(req, res);
  });

  app.use(requireInstalled, (await import("./lib/plugin-http.js")).dispatchPluginHttp);

  // Static assets a plugin ships in its package (`manifest.assets`). Runs after
  // the dynamic `ctx.http` routes so a plugin can still override a path.
  const { resolvePluginAssetFile, getPluginBundle, clearPluginAssetsCache } =
    await import("./lib/plugin-assets.js");
  const { resolvePluginAdminFile, clearPluginAdminAppCache } =
    await import("./lib/plugin-admin-app.js");
  const pluginAssetLimit = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many asset requests" },
  });

  // A plugin admin app is an admin-only surface. Its build files (HTML, JS,
  // source maps, JSON config) must not be readable anonymously — unlike the
  // public `/ext/<id>/**` asset route below. Mirrors `adminAccessGate` but
  // gates every file, not just pages, and answers JSON rather than redirecting.
  const { getSession } = await import("./lib/session.js");
  const { getEffectiveAccess } = await import("./lib/access-policy.js");
  const requirePluginAdminAccess = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (session.role !== "subscriber") {
      next();
      return;
    }
    getEffectiveAccess(session.userId, session.siteId, session.role)
      .then((access) => {
        if (access.capabilities.some((capability) => capability !== "content:read")) next();
        else res.status(403).json({ error: "Forbidden" });
      })
      .catch(() => res.status(403).json({ error: "Forbidden" }));
  };

  // The concatenated plugin bundle: /jf-plugins.<hash>.js  /  .css
  app.get(
    /^\/jf-plugins\.([0-9a-f]{6,40})\.(js|css)$/,
    requireInstalled,
    pluginAssetLimit,
    async (req, res, next) => {
      try {
        // Express 5 exposes RegExp captures as an object ({ "0": …, "1": … }),
        // not an array — index it like the sibling /ext handlers below.
        const params = req.params as unknown as string[];
        const hash = params[0] ?? "";
        const ext = (params[1] ?? "js") as "js" | "css";
        const bundle = await getPluginBundle(ext, hash);
        if (!bundle) {
          next();
          return;
        }
        res.type(bundle.contentType);
        res.setHeader(
          "Cache-Control",
          bundle.immutable
            ? "public, max-age=31536000, immutable"
            : "public, max-age=0, must-revalidate",
        );
        res.send(bundle.code);
      } catch {
        next();
      }
    },
  );

  // A plugin's self-contained admin app (`manifest.adminApp`), served under the
  // reserved `admin/` sub-namespace. HTML is same-origin-frameable only
  // (`frame-ancestors 'self'`) and never cached; other build files get a short
  // TTL. Registered before the generic asset route so `admin/**` always wins.
  app.get(
    /^\/ext\/([a-z0-9]+(?:\.[a-z0-9-]+)+)\/admin\/(.+)$/,
    requireInstalled,
    requirePluginAdminAccess,
    pluginAssetLimit,
    async (req, res, next) => {
      try {
        const params = req.params as unknown as string[];
        const file = await resolvePluginAdminFile(params[0] ?? "", params[1] ?? "");
        if (!file) {
          next();
          return;
        }
        res.type(file.contentType);
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", file.isHtml ? "private, no-store" : "public, max-age=300");
        res.sendFile(file.absPath, (err) => {
          if (err && !res.headersSent) next();
        });
      } catch {
        next();
      }
    },
  );

  app.get(
    /^\/ext\/([a-z0-9]+(?:\.[a-z0-9-]+)+)\/(.+)$/,
    requireInstalled,
    pluginAssetLimit,
    async (req, res, next) => {
      try {
        const params = req.params as unknown as string[];
        const file = await resolvePluginAssetFile(params[0] ?? "", params[1] ?? "");
        if (!file) {
          next();
          return;
        }
        res.type(file.contentType);
        res.setHeader("Cache-Control", "public, max-age=300");
        res.sendFile(file.absPath, (err) => {
          if (err && !res.headersSent) next();
        });
      } catch {
        next();
      }
    },
  );
  if (isInstalled()) {
    const { getRuntimeHooks } = await import("./lib/plugin-runtime.js");
    const hooks = getRuntimeHooks();
    for (const hook of ["plugin.activated", "plugin.deactivated", "plugin.uninstalled"] as const) {
      hooks.action(hook, () => {
        clearPluginAssetsCache();
        clearPluginAdminAppCache();
      });
    }
  }

  // Anything under /api or /ext that reached here matched no route. Without this
  // it falls through to the public-site handler and comes back as the site's
  // HTML 404 — callers doing `res.json()` then fail with
  // "Unexpected token '<', "<!DOCTYPE"". /ext is the plugin HTTP surface, so an
  // unregistered route (typically a plugin that failed to activate) must read
  // as a 404 in JSON, not a page.
  app.use((req, res, next) => {
    if (res.headersSent) {
      next();
      return;
    }
    if (req.path === "/api" || req.path.startsWith("/api/") || req.path.startsWith("/ext/")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  });

  // Managed rules override public content, but never platform or plugin routes.
  app.use(
    requireInstalled,
    rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false }),
    (await import("./middleware/redirects.js")).managedRedirects,
  );
  app.use(requireInstalled, publicSiteRoutes);

  // Backstop. Express's default handler prints the stack into the response body
  // in development, and any handler that throws without its own catch would
  // otherwise leak internals to an anonymous caller.
  app.use(
    (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error(
        "[justflows] unhandled error",
        JSON.stringify({ method: logSafe(req.method), path: logSafe(req.path) }),
        err,
      );
      if (res.headersSent) return;
      if (req.path.startsWith("/api/") || req.path.startsWith("/ext/")) {
        res.status(500).json({ error: "Internal server error" });
        return;
      }
      res.status(500).type("text/plain").send("Internal server error");
    },
  );
}
