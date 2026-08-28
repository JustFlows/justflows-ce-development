import { Router } from "express";
import { applyCoreUpdate, applyCoreUpdateFromRelease } from "../lib/core-updater.js";
import { runAllMigrations } from "../lib/run-migrations.js";
import { getDb } from "../lib/db.js";
import { getJustflowsVersion } from "../lib/version.js";
import { requireRole } from "../middleware/auth.js";
import { auditFromRequest } from "../lib/audit-log.js";
import { getAvailableCoreUpdate } from "../lib/core-release-check.js";
import {
  AUTO_UPDATE_MAX_SCOPE,
  isAutoUpdateKillSwitchOn,
  isCoreAutoUpdateEnabled,
  setCoreAutoUpdateEnabled,
} from "../lib/core-auto-update.js";
import multer from "multer";
import { sendServerError } from "../lib/send-error.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

/**
 * This route is prefetched during admin SSR, so it must return fast. Give
 * discovery a short budget; if the gateway is slow the lookup keeps running and
 * warms the module cache for the next call (and for "Check for updates").
 */
const SSR_DISCOVERY_BUDGET_MS = 2500;

router.get("/", requireRole("administrator"), async (_req, res) => {
  const version = getJustflowsVersion();
  const update = await Promise.race([
    getAvailableCoreUpdate().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_DISCOVERY_BUDGET_MS)),
  ]);
  let autoUpdateEnabled = false;
  try {
    autoUpdateEnabled = await isCoreAutoUpdateEnabled();
  } catch {
    /* no site yet */
  }

  res.json({
    version,
    currentVersion: version,
    updateAvailable: update !== null,
    updates: update
      ? [
          {
            id: update.id,
            name: update.name,
            type: update.type,
            currentVersion: update.currentVersion,
            availableVersion: update.availableVersion,
            notesUrl: update.notesUrl,
            publishedAt: update.publishedAt,
            autoUpdatable: update.autoUpdatable,
          },
        ]
      : [],
    autoUpdate: {
      enabled: autoUpdateEnabled,
      available: !isAutoUpdateKillSwitchOn(),
      maxScope: AUTO_UPDATE_MAX_SCOPE,
    },
  });
});

router.post("/check", requireRole("administrator"), async (_req, res) => {
  const version = getJustflowsVersion();
  try {
    const update = await getAvailableCoreUpdate({ force: true });
    res.json({
      updateAvailable: update !== null,
      currentVersion: version,
      latestVersion: update?.availableVersion ?? version,
    });
  } catch (err) {
    res.status(503).json({ error: `Update check failed: ${String(err)}`, currentVersion: version });
  }
});

router.post("/upload", requireRole("administrator"), upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }

  // Replacing the core is the most consequential thing an administrator can
  // do, and it left no trace at all.
  auditFromRequest(req, "core.updated", {
    target: file.originalname,
    detail: `${Math.round(file.size / 1024 / 1024)}MB`,
  });
  const result = await applyCoreUpdate(file.buffer, file.originalname, {
    signature:
      typeof req.body?.signature === "string"
        ? req.body.signature
        : typeof req.headers["x-justflows-update-signature"] === "string"
          ? req.headers["x-justflows-update-signature"]
          : undefined,
  });
  res.json(result);
});

/** Download + verify + install the latest published release (the "Update" button). */
router.post("/remote", requireRole("administrator"), async (req, res) => {
  const version = getJustflowsVersion();
  let update: Awaited<ReturnType<typeof getAvailableCoreUpdate>>;
  try {
    update = await getAvailableCoreUpdate({ force: true });
  } catch (err) {
    res.status(503).json({ error: `Update check failed: ${String(err)}` });
    return;
  }
  if (!update) {
    res.status(409).json({ error: "No newer release is available" });
    return;
  }

  const requested = typeof req.body?.version === "string" ? req.body.version : undefined;
  if (requested && requested !== update.availableVersion) {
    res.status(409).json({
      error: `Requested v${requested} but the available release is v${update.availableVersion}`,
    });
    return;
  }

  auditFromRequest(req, "core.updated", {
    target: `justflows@${update.availableVersion}`,
    detail: `remote ${update.currentVersion} -> ${update.availableVersion}`,
  });

  const result = await applyCoreUpdateFromRelease(update);
  res.status(result.ok ? 200 : 500).json(result);
});

router.get("/settings", requireRole("administrator"), async (_req, res) => {
  try {
    res.json({
      autoUpdate: {
        enabled: await isCoreAutoUpdateEnabled(),
        available: !isAutoUpdateKillSwitchOn(),
        maxScope: AUTO_UPDATE_MAX_SCOPE,
      },
    });
  } catch (err) {
    sendServerError(res, "updates", err);
  }
});

router.put("/settings", requireRole("administrator"), async (req, res) => {
  const enabled = req.body?.autoUpdate?.enabled ?? req.body?.enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  if (enabled && isAutoUpdateKillSwitchOn()) {
    res.status(409).json({ error: "Automatic updates are disabled by JUSTFLOWS_DISABLE_AUTO_UPDATE" });
    return;
  }
  try {
    await setCoreAutoUpdateEnabled(enabled);
    auditFromRequest(req, "core.auto_update_toggled", {
      target: "core.auto_update",
      detail: enabled ? "enabled" : "disabled",
    });
    res.json({ autoUpdate: { enabled, available: !isAutoUpdateKillSwitchOn(), maxScope: AUTO_UPDATE_MAX_SCOPE } });
  } catch (err) {
    sendServerError(res, "updates", err);
  }
});

const dbRouter = Router();
dbRouter.post("/migrate", requireRole("administrator"), async (_req, res) => {
  try {
    const db = await getDb();
    const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb";
    await runAllMigrations(db, driver);
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "updates", err);
  }
});

export { dbRouter };
export default router;
