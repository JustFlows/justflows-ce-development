// SPDX-License-Identifier: MIT

import { contentTypeCacheMiddleware } from "./middleware/content-type-cache.js";
import { visibilityRequestContext } from "./lib/content/visibility-viewer.js";
import { accountPagesRouter } from "./routes/public/account-pages.js";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { getJfRoot, viewsDir } from "./lib/runtime/jf-root.js";
import { HASHED_PUBLIC_SCRIPT } from "./lib/rendering/page-scripts.js";
import { resolvePathUnderBase } from "./lib/security/safe-path.js";
import { uploadsHandler } from "./lib/media/upload-serve.js";
import { isInstalled } from "./middleware/install-guard.js";
import { installToken, installTokenRequired } from "./lib/installation/install-token.js";
import { serveAdminI18n } from "./lib/i18n/admin-catalog.js";
import { pluginApiCsrf } from "./middleware/plugin-api-csrf.js";
import { setCsrfCookie } from "./lib/auth/session.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { cacheTraceMiddleware } from "./middleware/cache-trace.js";
import { createGzipMiddleware } from "./middleware/gzip.js";
import { browserCacheMiddleware, staticMaxAgeMs } from "./middleware/browser-cache.js";
import { rateLimit } from "express-rate-limit";
import { adminClientDir, adminClientIndex } from "./lib/admin/admin-ssr.js";
import { requestContext } from "./middleware/request-context.js";
import { rejectForeignSiteId, tenantContext, uploadsSiteGuard } from "./middleware/tenant-context.js";
import { getPluginLoader } from "./lib/plugins/plugin-runtime.js";
import { trustedProxyValue } from "./lib/security/trusted-proxy.js";

let corePromise: Promise<void> | null = null;
let deferredLoaded = false;
let deferredPromise: Promise<void> | null = null;

function ensureCoreRoutes(app: express.Application): Promise<void> {
  if (!corePromise) {
    corePromise = (async () => {
      const [{ default: authRoutes }, { default: installRoutes }] = await Promise.all([
        import("./routes/auth/auth.js"),
        import("./routes/system/install.js"),
      ]);

      app.use("/api/auth", authRoutes);
      app.use("/api/install", installRoutes);
    })();
  }
  return corePromise;
}

function loadDeferredRoutes(app: express.Application): Promise<void> {
  if (deferredLoaded) return Promise.resolve();
  if (!deferredPromise) {
    deferredPromise = import("./register-routes.js")
      .then((m) => m.registerDeferredRoutes(app))
      .then(() => {
        deferredLoaded = true;
      });
  }
  return deferredPromise;
}

export function createApp(): express.Application {
  const app = express();

  /** Only named ranges and explicit proxy addresses/subnets may supply client IPs. */
  const trustProxy = trustedProxyValue(process.env.TRUST_PROXY);
  app.set("trust proxy", trustProxy);

  app.disable("x-powered-by");
  app.use(requestContext);
  app.use((_req, res, next) => {
    res.setHeader("X-Powered-By", "Justflows");
    next();
  });
  app.use(cookieParser());
  // A plugin route with `binaryBody` takes raw bytes (file uploads) up to its own limit.
  app.use((req, res, next) => {
    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next();
    const url = req.url?.split("?")[0] ?? "";
    if (!url.startsWith("/ext/") && !getPluginLoader()?.httpRouter.isPublicApiPath(url)) return next();
    const binary = getPluginLoader()?.httpRouter.match(req.method, url)?.route.binaryBody;
    if (!binary) return next();
    express.raw({ type: () => true, limit: binary.maxBytes })(req, res, next);
  });
  app.use(express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      // A plugin route that opts in (`rawBody: true`) signs these bytes.
      // Parsed JSON cannot be verified. The lookup is synchronous because
      // this callback is.
      const method = req.method ?? "";
      const url = req.url?.split("?")[0] ?? "";
      if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return;
      const loader = getPluginLoader();
      const matched = loader?.httpRouter.match(method, url);
      if (matched?.route.rawBody === true) {
        Object.assign(req, { rawBody: buf.toString("utf8") });
        return;
      }
      // Passenger can parse the body before plugin routes exist. Keep a small
      // copy; dispatch forwards it only when the matched route asked for it.
      if (!loader && buf.length <= 65_536 && (url.startsWith("/ext/") || url.startsWith("/api/"))) {
        Object.assign(req, { rawBody: buf.toString("utf8") });
      }
    },
  }));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      void import("./lib/plugins/plugin-runtime.js")
        .then(({ getRuntimeHooks }) =>
          getRuntimeHooks().dispatchAction(
            "request.after",
            {
              method: req.method,
              path: req.path,
              statusCode: res.statusCode,
              durationMs: Date.now() - started,
            },
            { source: "http" },
          ),
        )
        .catch(() => undefined);
    });
    next();
  });
  app.use(createGzipMiddleware());
  app.use(cacheTraceMiddleware);
  app.use(browserCacheMiddleware);
  // The site has to be known before security headers and the object cache,
  // both of which are stored per site. csrfProtection still runs after the
  // headers, so its own 403 keeps the policy.
  app.use(tenantContext);
  app.use(rejectForeignSiteId);
  app.use(visibilityRequestContext);
  app.use(securityHeaders);

  app.use((req, res, next) => { if (!isInstalled()) { next(); return; } accountPagesRouter(req, res, next); });
  app.use((req, res, next) => { if (!isInstalled()) { next(); return; } void contentTypeCacheMiddleware(req, res, next); });
  app.use("/api", pluginApiCsrf);

  const staticMaxAge = staticMaxAgeMs();
  /**
   * Uploads read files off disk. CodeQL's js/missing-rate-limiting only models
   * express-rate-limit on this same chain.
   */
  const uploadsRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: "Too many requests",
  });
  // Local folder or S3 bucket, per STORAGE_DRIVER (see lib/media/upload-serve.ts).
  app.use("/uploads", uploadsRateLimit, uploadsSiteGuard, uploadsHandler(staticMaxAge));
  const publicDir = path.join(getJfRoot(), "public");
  const servePublicFiles = express.static(publicDir, {
      maxAge: staticMaxAge,
      setHeaders: (res, filePath) => {
        /**
         * Scripts under `public/js` are compiled from
         * apps/server/public-scripts/src/*.ts (see docs/CONVENTIONS.md). Pages
         * link the content-hashed `<name>-<hash>.js` from the build manifest,
         * which never changes under its URL, so it is cached for good. Every
         * other script, stylesheet, or map here has a stable URL (the
         * `<name>.js` copy, hand-written CSS) and gets `no-cache`: kept, but
         * revalidated with the ETag, so an edit is never pinned behind a long
         * max-age.
         */
        if (HASHED_PUBLIC_SCRIPT.test(`/js/${path.basename(filePath)}`) && path.dirname(filePath) === path.join(publicDir, "js")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (/\.(?:js|mjs|css|map)$/i.test(filePath)) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    });
  app.use((req, res, next) => {
    if (res.locals.jfBypassStatic) { next(); return; }
    servePublicFiles(req, res, next);
  });
  /**
   * A page cached before a deploy or core update still links the previous
   * build's hashed script. That file is gone, so answer with the current
   * build's `<name>.js` (revalidated, never immutable) instead of a 404.
   */
  const previousBuildLimit = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: "Too many requests",
  });
  app.get(HASHED_PUBLIC_SCRIPT, previousBuildLimit, (req, res, next) => {
    if (res.locals.jfBypassStatic) { next(); return; }
    const match = HASHED_PUBLIC_SCRIPT.exec(req.path);
    const file = match ? resolvePathUnderBase(path.join(publicDir, "js"), `${match[1]}.js${match[2] ?? ""}`) : null;
    if (!file) { next(); return; }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) next();
    });
  });

  app.set("view engine", "ejs");
  app.set("views", viewsDir());

  app.get("/api/healthz", (_req, res) => {
    res.json({ ok: true, installed: isInstalled(), boot: deferredLoaded ? "ready" : "loading" });
  });

  app.get("/api/i18n/:locale", serveAdminI18n);

  const sendAdminSpa = (_req: express.Request, res: express.Response) => {
    const indexPath = adminClientIndex();
    res.sendFile(indexPath, (err) => {
      if (!err || res.headersSent) return;
      res.status(503).send("Admin UI not built.");
    });
  };

  const adminStatic = adminClientDir();
  if (fs.existsSync(adminStatic)) {
    app.use("/assets", express.static(path.join(adminStatic, "assets")));
  }

  // Login is no longer exempt from CSRF, so the page that submits it needs a
  // token before a session exists. Issuing it with the HTML means the attacker
  // has to be able to write a cookie on this domain, not merely post a form.
  // CodeQL js/missing-rate-limiting only models express-rate-limit (not a
  // custom consumeRateLimit helper) as middleware that guards sendFile.
  const authPageRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: "Too many requests",
  });

  const withCsrfCookie = (req: express.Request, res: express.Response) => {
    if (!req.cookies?.jf_csrf) setCsrfCookie(res);
    sendAdminSpa(req, res);
  };

  app.get("/install", authPageRateLimit, withCsrfCookie);
  // Members use the site's own themed `auth` pages; staff use the admin's own
  // pages under `<admin path>/` instead (see register-routes.ts). The bare form
  // remains the fallback for a site with no such page yet, or when rendering fails.
  const themedAuthPage = (slug: "login" | "register" | "forgot-password" | "reset-password") =>
    (req: express.Request, res: express.Response) => {
      if (slug === "reset-password") res.setHeader("Referrer-Policy", "no-referrer");
      if (!isInstalled()) { withCsrfCookie(req, res); return; }
      let csrfIssued = false;
      const fallback = () => {
        if (res.headersSent) return;
        if (csrfIssued) sendAdminSpa(req, res);
        else withCsrfCookie(req, res);
      };
      const failed = (err: unknown) => {
        console.error(`[justflows] themed /${slug} page failed:`, err);
        fallback();
      };
      Promise.all([ensureCoreRoutes(app), loadDeferredRoutes(app)])
        .then(() => Promise.all([
          import("./routes/public/auth-pages.js"),
          import("./middleware/auth.js"),
          import("./routes/public/public-site.js"),
        ]))
        .then(([{ serveAuthPage }, { optionalSession }, { ensureSiteIsPublic }]) => {
          optionalSession(req, res, (error?: unknown) => {
            if (error) { fallback(); return; }
            // While the site is offline or in maintenance only the staff surface
            // stays open; these member pages get the same closed page as the rest
            // of the site, plain-form fallback included.
            ensureSiteIsPublic(req, res).then((open) => {
              if (open) continueAuthPage();
            }).catch((err: unknown) => {
              // Fail closed: never fall back to a sign-in form we could not gate.
              console.error(`[justflows] site visibility check for /${slug} failed:`, err);
              if (!res.headersSent) res.status(503).setHeader("Cache-Control", "private, no-store").type("text/plain").send("Service unavailable");
            });
          });
          const continueAuthPage = () => {
            // One session serves the admin and the site, so anyone already signed
            // in — on either surface — has no use for these pages and goes to their
            // account. An editor previewing the page in the builder still sees it.
            // A reset link can be opened while signed in, so that page stays.
            if (req.session && slug !== "reset-password" && req.query.preview !== "1") {
              const next = typeof req.query.next === "string" ? req.query.next : "";
              if (slug === "login" && next.startsWith("/oauth/consent?")) {
                res.redirect(302, next);
                return;
              }
              import("./lib/account/pages.js")
                .then(({ accountHomeUrl }) => accountHomeUrl(req.session!.siteId))
                .then((url) => {
                  res.setHeader("Cache-Control", "private, no-store");
                  res.redirect(302, url);
                })
                .catch(failed);
              return;
            }
            // A signed-in visitor already has a session-bound token (synced above).
            if (!req.session && !req.cookies?.jf_csrf) { setCsrfCookie(res); csrfIssued = true; }
            serveAuthPage(slug, req, res, fallback).catch(failed);
          };
        })
        .catch(failed);
    };
  app.get("/login", authPageRateLimit, themedAuthPage("login"));
  app.get("/register", authPageRateLimit, themedAuthPage("register"));
  app.get("/forgot-password", authPageRateLimit, themedAuthPage("forgot-password"));
  app.get("/reset-password", authPageRateLimit, themedAuthPage("reset-password"));
  app.get("/signup", authPageRateLimit, withCsrfCookie);
  // The OAuth consent screen for MCP connectors (#159). Like /login it is served
  // without SSR data; the page signs the user in first when needed.
  app.get("/oauth/consent", authPageRateLimit, (req: express.Request, res: express.Response) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    withCsrfCookie(req, res);
  });

  app.get("/", (req, res, next) => {
    if (isInstalled()) {
      next();
      return;
    }
    res.redirect("/install");
  });

  if (isPassenger()) {
    app.use((req, res, next) => {
      if (deferredLoaded) {
        next();
        return;
      }
      Promise.all([ensureCoreRoutes(app), loadDeferredRoutes(app)])
        .then(() => {
          (
            app as unknown as {
              handle: (
                req: express.Request,
                res: express.Response,
                next: express.NextFunction,
              ) => void;
            }
          ).handle(req, res, next);
        })
        .catch(next);
    });
  }

  return app;
}

/** Load all routes before handling requests (used by Passenger after spawn). */
export async function createFullApp(): Promise<express.Application> {
  const app = createApp();
  await ensureCoreRoutes(app);
  await loadDeferredRoutes(app);
  return app;
}

export async function startServer(): Promise<void> {
  if (isPassenger()) {
    throw new Error("startServer() must not run under Passenger — use root server.js");
  }

  if (!process.env.JF_ROOT) {
    process.env.JF_ROOT = getJfRoot();
  }

  const app = createApp();
  await ensureCoreRoutes(app);
  await loadDeferredRoutes(app);

  if (!isInstalled() && installTokenRequired()) {
    installToken();
  }

  const port = parseInt(process.env.PORT ?? "3000", 10);
  const hostname = process.env.HOSTNAME ?? "0.0.0.0";

  // 0.0.0.0 / :: mean "bind every interface" — they are not usable in a browser
  // and are not a secure context (crypto.randomUUID is undefined there), so show
  // localhost in the URLs while still listening on the given hostname.
  const displayHost = ["0.0.0.0", "::", ""].includes(hostname) ? "localhost" : hostname;

  app.listen(port, hostname, () => {
    console.log(`> Justflows ready on http://${displayHost}:${port}`);
    console.log(`> Install: http://${displayHost}:${port}/install`);
  });
}

export function isPassenger(): boolean {
  return !!(
    process.env.PASSENGER_APP_ENV ||
    process.env.PASSENGER_LISTEN_PORT ||
    process.env.PHUSION_PASSENGER ||
    process.env.PASSENGER_APP_ENV_NAME ||
    process.env._PASSENGER_APP_ROOT
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
