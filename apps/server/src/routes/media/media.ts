import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireInstallationRoot, requireRole } from "../../middleware/auth.js";
import { requireSiteFeature } from "../../lib/tenancy/site-features.js";
import { MEDIA_WRITE_ROLES, ROLES } from "../../lib/auth/rbac.js";
import { userCan } from "../../lib/auth/access-policy.js";
import type { UserCapability } from "@justflows/sdk";
import { formatMb, maxUploadBytes } from "../../lib/media/media-quota.js";
import multer, { MulterError } from "multer";
import { sendServerError } from "../../lib/http/send-error.js";
import { param } from "../../lib/http/params.js";
import {
  getMediaItem,
  isMediaListKind,
  listMediaItems,
  storeMediaUpload,
  trashMediaItem,
  updateMediaMetadata,
} from "../../lib/media/media-write.js";
import { readMediaSettings, applyMediaSettings } from "../../lib/media/media-settings.js";
import { regenerateStatus, startRegenerate } from "../../lib/media/media-regenerate.js";
import { admitUpload, multipartLimits } from "../../lib/security/upload-admission.js";

const router = Router();
const mediaUploadRequestLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
// Regeneration walks the whole library and re-encodes every image; keep it to a
// trickle even though only administrators can reach it.
const regenerateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const upload = multer({ storage: multer.memoryStorage(), limits: multipartLimits(maxUploadBytes()) });

/** Role gates the route. The capability decides the operation, before any library read or write. */
async function allowMedia(
  session: { userId: string; siteId: string; role: string },
  capability: UserCapability,
): Promise<boolean> {
  return userCan(session, capability, { siteId: session.siteId });
}
const admitMediaUpload = admitUpload({ name: "media", maxBytes: maxUploadBytes(), perSite: 4, global: 16 });

/**
 * multer rejects an oversized file by throwing, which the global handler turns
 * into a flat 500 — so the one thing the uploader needs to know (the file is
 * too big, and by how much) was the one thing they were not told.
 */
function uploadSingle(field: string) {
  return (
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: `File is too large (limit ${formatMb(maxUploadBytes())}).` });
        return;
      }
      if (err instanceof MulterError) {
        res.status(400).json({ error: "The upload has unexpected or too many fields." });
        return;
      }
      next(err);
    });
  };
}

router.get("/", requireRole(...MEDIA_WRITE_ROLES), async (req, res) => {
  const session = req.session!;
  if (!(await allowMedia(session, "media:read"))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const kind = isMediaListKind(req.query.kind) ? req.query.kind : undefined;
    const items = await listMediaItems(session.siteId, Number(req.query.limit ?? "40"), kind);
    res.json({ items });
  } catch (err) {
    sendServerError(res, "media", err);
  }
});

router.post(
  "/",
  mediaUploadRequestLimit,
  requireRole(...MEDIA_WRITE_ROLES),
  admitMediaUpload,
  uploadSingle("file"),
  async (req, res) => {
    const session = req.session!;
    if (!(await allowMedia(session, "media:upload"))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    try {
      const result = await storeMediaUpload(
        {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          buffer: file.buffer,
        },
        { siteId: session.siteId, userId: session.userId, role: session.role },
      );
      res.status(result.status).json(result.body);
    } catch (err) {
      sendServerError(res, "media", err);
    }
  },
);

// --- Responsive-image configuration (administrators only) ------------------
// Declared before `/:id` so the literal path is not captured as an id.

router.get("/settings", requireRole(ROLES.ADMIN), async (_req, res) => {
  try {
    res.json(await readMediaSettings());
  } catch (err) {
    sendServerError(res, "media.settings", err);
  }
});

router.post("/settings", requireRole(ROLES.ADMIN), requireInstallationRoot, async (req, res) => {
  try {
    res.json(await applyMediaSettings(req.body));
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid settings", detail: err.issues });
      return;
    }
    sendServerError(res, "media.settings", err);
  }
});

router.post("/regenerate", regenerateLimit, requireRole(ROLES.ADMIN), requireSiteFeature("feature.responsiveImages"), (req, res) => {
  const started = startRegenerate(req.session!.siteId);
  if (!started) {
    res
      .status(409)
      .json({ error: "A regeneration run is already in progress", ...regenerateStatus() });
    return;
  }
  res.status(202).json({ started: true, ...regenerateStatus() });
});

router.get("/regenerate/status", requireRole(ROLES.ADMIN), (_req, res) => {
  res.json(regenerateStatus());
});

// --- Per-item ------------------------------------------------------------------

router.get("/:id", requireRole(...MEDIA_WRITE_ROLES), async (req, res) => {
  const session = req.session!;
  if (!(await allowMedia(session, "media:read"))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const item = await getMediaItem(session.siteId, param(req.params.id));
    if (!item) {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    res.json(item);
  } catch (err) {
    sendServerError(res, "media", err);
  }
});

router.patch("/:id", requireRole(...MEDIA_WRITE_ROLES), async (req, res) => {
  const session = req.session!;
  if (!(await allowMedia(session, "media:upload"))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const result = await updateMediaMetadata(
      param(req.params.id),
      {
        siteId: session.siteId,
        userId: session.userId,
        role: session.role,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
      {
        ...(body.altText !== undefined ? { altText: body.altText as string | null } : {}),
        ...(body.caption !== undefined ? { caption: body.caption as string | null } : {}),
        ...(body.focalX !== undefined ? { focalX: body.focalX as number | null } : {}),
        ...(body.focalY !== undefined ? { focalY: body.focalY as number | null } : {}),
      },
    );
    res.status(result.status).json(result.body);
  } catch (err) {
    sendServerError(res, "media", err);
  }
});

router.delete("/:id", requireRole(...MEDIA_WRITE_ROLES), async (req, res) => {
  const session = req.session!;
  if (!(await allowMedia(session, "media:delete"))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const result = await trashMediaItem(param(req.params.id), {
      siteId: session.siteId,
      userId: session.userId,
      role: session.role,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    sendServerError(res, "media", err);
  }
});

export default router;
