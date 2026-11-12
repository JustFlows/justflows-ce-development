// SPDX-License-Identifier: MIT

import { Router } from "express";
import accessRoutes from "./access.js";
import commentsRoutes from "./comments.js";
import contentRoutes from "./content.js";
import eventsRoutes from "./events.js";
import mediaRoutes from "./media.js";
import openapiRoutes from "./openapi.js";
import designRoutes from "./design.js";
import settingsRoutes from "./settings.js";
import siteAdminRoutes from "./site-admin.js";
import systemRoutes from "./system.js";
import tenantsRoutes, { siteQuotaRoutes } from "./tenants.js";
import taxonomyRoutes from "./taxonomy.js";
import webhooksRoutes from "./webhooks.js";
import { requireMultisite } from "../../lib/tenancy/multisite.js";

/**
 * `/api/manage/v1` — the federated management API (#135).
 *
 * Mounted in `register-routes.ts` behind `apiKeyAuth` (Bearer key → synthetic
 * session), `manageApiRateLimit` (per key + per IP, express-rate-limit) and
 * `manageApiCors` (explicit-origin echo only, never `*`). Every handler runs
 * `ensureKeyCan` for the same capability its cookie-authenticated counterpart
 * requires and calls the shared service layer — no parallel business logic.
 */
const router = Router();

router.get("/", (_req, res) => {
  res.json({
    name: "Justflows Federated Management API",
    version: "manage/v1",
    documentation: "/api/manage/v1/openapi.json",
  });
});

router.use("/openapi.json", openapiRoutes);
router.use("/events", eventsRoutes);
router.use("/content", contentRoutes);
router.use("/media", mediaRoutes);
router.use("/comments", commentsRoutes);
router.use("/settings", settingsRoutes);
router.use("/", designRoutes);
router.use("/", siteAdminRoutes);
router.use("/tenants", requireMultisite, tenantsRoutes);
router.use("/sites/:id/quotas", requireMultisite);
router.use("/sites", siteQuotaRoutes);
router.use("/webhooks", webhooksRoutes);
// Flat sub-paths (menus, content-types, languages, redirects / users, roles /
// plugins, themes, cache, static-export, diagnostics, health).
router.use("/", taxonomyRoutes);
router.use("/", accessRoutes);
router.use("/", systemRoutes);

export default router;
