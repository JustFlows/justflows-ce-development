// SPDX-License-Identifier: MIT
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { SearchQuerySchema } from "@justflows/content";
import { requireCapability, requireSession } from "../middleware/auth.js";
import { getEffectiveAccess } from "../lib/access-policy.js";
import {
  getSearchSettings,
  saveSearchSettings,
  rebuildSearchIndex,
  searchContent,
  SearchSettingsSchema,
} from "../lib/search-db.js";
import { sendServerError } from "../lib/send-error.js";

const router = Router();
router.get(
  "/",
  requireSession,
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }),
  async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid search parameters" });
      return;
    }
    try {
      const session = req.session!;
      const access = await getEffectiveAccess(session.userId, session.siteId, session.role);
      if (!access.capabilities.includes("content:read")) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const scope = access.policy.scopes?.["content:read"];
      if (scope?.siteIds?.length && !scope.siteIds.includes(session.siteId)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const status = req.query.status;
      if (
        status !== undefined &&
        (typeof status !== "string" ||
          !["draft", "published", "scheduled", "private", "archived"].includes(status))
      ) {
        res.status(400).json({ error: "Invalid status" });
        return;
      }
      res.json(
        await searchContent(session.siteId, parsed.data, {
          admin: {
            ...(scope?.ownership === "self" ? { ownerId: session.userId } : {}),
            ...(scope?.contentTypes?.length ? { types: scope.contentTypes } : {}),
            ...(scope?.locales?.length ? { locales: scope.locales } : {}),
            ...(typeof status === "string" ? { status } : {}),
          },
        }),
      );
    } catch (err) {
      sendServerError(res, "search", err);
    }
  },
);
router.get("/settings", requireCapability("settings:manage"), async (req, res) => {
  try {
    res.json(await getSearchSettings(req.session!.siteId));
  } catch (err) {
    sendServerError(res, "search", err);
  }
});
router.put("/settings", requireCapability("settings:manage"), async (req, res) => {
  const parsed = SearchSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid search settings" });
    return;
  }
  try {
    res.json(await saveSearchSettings(req.session!.siteId, parsed.data));
  } catch (err) {
    sendServerError(res, "search", err);
  }
});
router.post(
  "/rebuild",
  requireCapability("settings:manage"),
  rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: "draft-8", legacyHeaders: false }),
  async (req, res) => {
    try {
      res.json({ ok: true, indexed: await rebuildSearchIndex(req.session!.siteId) });
    } catch (err) {
      sendServerError(res, "search", err);
    }
  },
);
export default router;
