// SPDX-License-Identifier: MIT

import { contentCacheRules, contentCacheExclusions } from "../../lib/cache/content-type-cache.js";
import { accountPageExclusions } from "../../lib/account/pages.js";
import { Router, type Request, type Response } from "express";
import { getSiteId } from "../../lib/settings/site-settings.js";
import { getPwaSettings } from "../../lib/pwa/pwa-settings.js";
import { buildManifestJson } from "../../lib/pwa/pwa-manifest.js";
import { buildServiceWorkerScript, buildRetirementServiceWorkerScript } from "../../lib/pwa/pwa-service-worker.js";
import { buildOfflinePageHtml } from "../../lib/pwa/pwa-offline-page.js";
import { siteOrigin } from "../../lib/rendering/seo-public.js";
import { etagFor } from "../manage-api/envelope.js";

/**
 * Public PWA surfaces (#127): the generated web app manifest, the service
 * worker (real when enabled, a retirement worker at the same URL when not —
 * so an already-installed client can still reach it and clean itself up),
 * and the precached offline fallback page. None of these touch the
 * filesystem or perform expensive work — they build small strings from
 * already-loaded settings — so they need no `express-rate-limit`, matching
 * the unthrottled `/sitemap.xml` route.
 */

function sendWithEtag(
  req: Request,
  res: Response,
  contentType: string,
  body: string,
  cacheControl: string,
): void {
  const etag = etagFor(req, body);
  res.setHeader("Cache-Control", cacheControl);
  if (etag) {
    res.setHeader("ETag", etag);
    if (req.get("if-none-match") === etag) {
      res.status(304).end();
      return;
    }
  }
  res.type(contentType).send(body);
}

const router = Router();

router.get("/manifest.webmanifest", async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) return void res.status(404).end();
    const { siteFeatureEnabled } = await import("../../lib/tenancy/site-features.js");
    if (!(await siteFeatureEnabled("feature.pwa", siteId))) return void res.status(404).end();
    const settings = await getPwaSettings(siteId);
    if (!settings.enabled) return void res.status(404).end();
    const manifest = buildManifestJson(settings, siteOrigin(), String(req.locale ?? "en"));
    sendWithEtag(
      req,
      res,
      "application/manifest+json",
      JSON.stringify(manifest),
      "public, max-age=300, stale-while-revalidate=86400",
    );
  } catch (err) {
    console.error("[justflows] pwa manifest build failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

router.get("/sw.js", async (req, res) => {
  try {
    const siteId = await getSiteId();
    const settings = siteId ? await getPwaSettings(siteId) : null;
    const { siteFeatureEnabled } = await import("../../lib/tenancy/site-features.js");
    const allowed = siteId ? await siteFeatureEnabled("feature.pwa", siteId) : false;
    const script =
      settings && settings.enabled && allowed
        ? buildServiceWorkerScript(settings, siteId ? [...await accountPageExclusions(siteId), ...contentCacheExclusions(await contentCacheRules(siteId))] : [])
        : buildRetirementServiceWorkerScript();
    // A service worker byte stream must always be revalidated — browsers
    // already special-case SW update checks, and `immutable`/long max-age
    // would prevent an install/disable change from ever being noticed.
    sendWithEtag(req, res, "application/javascript", script, "no-cache");
  } catch (err) {
    console.error("[justflows] pwa service worker build failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

router.get("/pwa-offline.html", async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) return void res.status(404).end();
    const { siteFeatureEnabled } = await import("../../lib/tenancy/site-features.js");
    if (!(await siteFeatureEnabled("feature.pwa", siteId))) return void res.status(404).end();
    const settings = await getPwaSettings(siteId);
    if (!settings.enabled) return void res.status(404).end();
    sendWithEtag(
      req,
      res,
      "text/html",
      buildOfflinePageHtml(settings),
      "public, max-age=300, stale-while-revalidate=86400",
    );
  } catch (err) {
    console.error("[justflows] pwa offline page build failed:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
});

export default router;
