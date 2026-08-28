import type express from "express";
import { isInstalled, requireInstalled, blockIfInstalled } from "./middleware/install-guard.js";
import { publicApiGuard } from "./middleware/public-api.js";
import { publicApiCors } from "./middleware/public-api-cors.js";
import { publicApiRateLimit } from "./middleware/public-api-rate-limit.js";
import { logSafe } from "./lib/log-safe.js";
import { renderAdminPage } from "./lib/admin-ssr.js";
import { adminAccessGate } from "./middleware/admin-access.js";

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
      console.error("[justflows] Pending migrations failed:", err);
    }
    const { startRevisionJobs } = await import("./lib/revision-jobs.js");
    startRevisionJobs();
    const { startCoreAutoUpdateJob } = await import("./lib/core-auto-update.js");
    startCoreAutoUpdateJob();
  }

  const { ensurePluginRuntime } = await import("./lib/plugin-runtime.js");
  await ensurePluginRuntime();

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
    { default: publicSiteRoutes },
    { default: languagesRoutes },
    { default: menusRoutes },
    { default: blocksRoutes },
    { default: analyticsRoutes },
    { default: formsRoutes },
    { default: contentTypesRoutes },
    { default: reusableBlocksRoutes, templatePartsRouter },
    { default: headerPresetsRoutes },
    { default: auditRoutes },
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
    import("./routes/forms.js"),
    import("./routes/content-types.js"),
    import("./routes/reusable-blocks.js"),
    import("./routes/header-presets.js"),
    import("./routes/audit.js"),
  ]);

  app.use(blockIfInstalled);

  app.use("/api/content", requireInstalled, contentRoutes);
  app.use("/api/media", requireInstalled, mediaRoutes);
  app.use("/api/comments", requireInstalled, commentsRoutes);
  app.use("/api/users", requireInstalled, usersRoutes);
  app.use("/api/settings", requireInstalled, settingsRoutes);
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
  app.use("/api/languages", requireInstalled, languagesRoutes);
  app.use("/api/menus", requireInstalled, menusRoutes);
  app.use("/api/reusable-blocks", requireInstalled, reusableBlocksRoutes);
  app.use("/api/template-parts", requireInstalled, templatePartsRouter);
  app.use("/api/header-presets", requireInstalled, headerPresetsRoutes);
  app.use("/api/blocks", requireInstalled, blocksRoutes);
  app.use("/api/analytics", requireInstalled, analyticsRoutes);
  app.use("/api/forms", requireInstalled, formsRoutes);
  app.use("/api/content-types", requireInstalled, contentTypesRoutes);
  app.use("/api/audit", requireInstalled, auditRoutes);
  // Everything below is public-facing: one switch (Settings → Public API) takes
  // the whole surface offline. Mounted on the prefix so future public routes
  // inherit the guard automatically.
  app.use("/api/v1", publicApiGuard, publicApiCors, publicApiRateLimit);
  app.use("/api/site", publicApiGuard);

  app.use("/api/v1", publicApiRoutes);
  app.use("/api/site", siteRoutes);
  app.get("/theme.css", serveThemeCss);

  app.post("/justflows-forms/submit", requireInstalled, async (req, res) => {
    try {
      const { acceptFormSubmission } = await import("./lib/forms-public.js");
      const { clientIp } = await import("./lib/rate-limit.js");
      const result = await acceptFormSubmission({
        body: (req.body ?? {}) as Record<string, unknown>,
        referer: req.get("referer") ?? "/",
        clientIp: clientIp(req),
      });
      if (result.location) {
        res
          .status(result.status === 303 ? 303 : result.status)
          .location(result.location)
          .end();
        return;
      }
      res
        .status(result.status)
        .type("text/plain")
        .send(result.error ?? "Unable to submit");
    } catch (err) {
      console.error("[justflows] form submission failed:", err);
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

  app.use("/admin", requireInstalled, adminAccessGate);

  app.get(/^\/admin(\/.+)?$/, requireInstalled, (req, res, next) => {
    if (req.path.match(/\.\w+$/)) {
      next();
      return;
    }
    void renderAdminPage(req, res);
  });

  app.use(requireInstalled, (await import("./lib/plugin-http.js")).dispatchPluginHttp);
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
      if (req.path.startsWith("/api/")) {
        res.status(500).json({ error: "Internal server error" });
        return;
      }
      res.status(500).type("text/plain").send("Internal server error");
    },
  );
}
