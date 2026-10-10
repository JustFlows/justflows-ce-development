// SPDX-License-Identifier: MIT

import { contentTypeCacheMiddleware } from "./middleware/content-type-cache.js";
import { accountPagesRouter } from "./routes/public/account-pages.js";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { getJfRoot, viewsDir } from "./lib/runtime/jf-root.js";
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

  // Justflows is normally deployed behind nginx, Passenger, or a Docker proxy.
  // Without this, req.ip is the proxy's address for every request, which
  // collapses per-IP rate limiting into one shared bucket and makes req.secure
  // always false. Defaults to "loopback" — the reverse proxy on the same host —
  // and TRUST_PROXY accepts anything Express does ("1", a subnet, "false").
  const trustProxy = process.env.TRUST_PROXY ?? "loopback";
  if (trustProxy !== "false") {
    app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  }

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
  app.use(securityHeaders);

  app.use((req, res, next) => { if (!isInstalled()) { next(); return; } accountPagesRouter(req, res, next); });
  app.use((req, res, next) => { if (!isInstalled()) { next(); return; } void contentTypeCacheMiddleware(req, res, next); });
  app.use("/api", pluginApiCsrf);

  const staticMaxAge = staticMaxAgeMs();
  // Local folder or S3 bucket, per STORAGE_DRIVER (see lib/media/upload-serve.ts).
  app.use("/uploads", uploadsSiteGuard, uploadsHandler(staticMaxAge));
  const servePublicFiles = express.static(path.join(getJfRoot(), "public"), {
      maxAge: staticMaxAge,
      setHeaders: (res, filePath) => {
        // Every script under `public/js` is compiled from
        // apps/server/public-scripts/src/*.ts (see docs/CONVENTIONS.md) and
        // any hand-written CSS lives alongside it — all served at a stable,
        // unversioned URL (site-nav.js, site-chrome.js, …). A long max-age
        // would pin stale copies until it expires (the "my edit isn't
        // showing up" trap), and none of these files are content-hashed, so the
        // blanket downgrade to `no-cache` is correct for the whole set, not just
        // today's list. `no-cache` still keeps the file cached and revalidates
        // with the ETag — the server answers 304 until the bytes change.
        // Content-hashed bundles live under the admin app's own asset path, not
        // here, and keep their long max-age.
        if (/\.(?:js|mjs|css|map)$/i.test(filePath)) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    });
  app.use((req, res, next) => {
    if (res.locals.jfBypassStatic) { next(); return; }
    servePublicFiles(req, res, next);
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
  app.get("/login", authPageRateLimit, withCsrfCookie);
  app.get("/register", authPageRateLimit, withCsrfCookie);
  app.get("/forgot-password", authPageRateLimit, withCsrfCookie);
  app.get("/signup", authPageRateLimit, withCsrfCookie);
  // The OAuth consent screen for MCP connectors (#159). Like /login it is served
  // without SSR data; the page signs the user in first when needed.
  app.get("/oauth/consent", authPageRateLimit, (req: express.Request, res: express.Response) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    withCsrfCookie(req, res);
  });
  // The reset link carries a token in the query string. Keep it out of any
  // Referer header the page would otherwise send when it loads a subresource or
  // the user clicks away; the page itself also strips it from the URL on load.
  app.get(
    "/reset-password",
    authPageRateLimit,
    (req: express.Request, res: express.Response) => {
      res.setHeader("Referrer-Policy", "no-referrer");
      withCsrfCookie(req, res);
    },
  );

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
