import { Router, type Response } from "express";
import { startCoreUpdate, UpdateInProgressError } from "../lib/core-updater.js";
import { readUpdateStatus } from "../lib/core-update-status.js";
import { runAllMigrations } from "../lib/run-migrations.js";
import { getDb } from "../lib/db.js";
import { getJustflowsVersion } from "../lib/version.js";
import { requireRole } from "../middleware/auth.js";
import { auditFromRequest } from "../lib/audit-log.js";
import {
  getAvailableCoreUpdate,
  getLatestCoreReleaseForReinstall,
} from "../lib/core-release-check.js";
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

/** Live progress of a running (or the last) core update — polled by the admin UI. */
router.get("/status", requireRole("administrator"), (_req, res) => {
  res.json(readUpdateStatus());
});

function handleStartError(res: Response, err: unknown): void {
  if (err instanceof UpdateInProgressError) {
    res.status(409).json({ error: "A core update is already running", status: readUpdateStatus() });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
}

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

  try {
    const { mode, status, result } = await startCoreUpdate({
      source: "upload",
      siteId: req.session!.siteId,
      filename: file.originalname,
      buffer: file.buffer,
      signature:
        typeof req.body?.signature === "string"
          ? req.body.signature
          : typeof req.headers["x-justflows-update-signature"] === "string"
            ? req.headers["x-justflows-update-signature"]
            : undefined,
    });
    if (mode === "background") {
      res.status(202).json({ started: true, background: true, status });
      return;
    }
    res.status(result?.ok ? 200 : 500).json({ ...result, background: false, status });
  } catch (err) {
    handleStartError(res, err);
  }
});

/**
 * Download + verify + install the latest published release (the "Update"
 * button). With `force: true` in the body, skip the "must be newer" gate and
 * re-download + reapply whatever the gateway currently publishes as latest —
 * even if that's the version already installed. This is the "force reinstall"
 * path: it repairs a corrupted install (bad copy, interrupted `npm install`,
 * a manually edited file) without waiting on a new release, and runs the same
 * verified pipeline as a normal remote update.
 */
router.post("/remote", requireRole("administrator"), async (req, res) => {
  const force = req.body?.force === true;

  let update: Awaited<ReturnType<typeof getAvailableCoreUpdate>>;
  try {
    update = force
      ? await getLatestCoreReleaseForReinstall()
      : await getAvailableCoreUpdate({ force: true });
  } catch (err) {
    res.status(503).json({ error: `Update check failed: ${String(err)}` });
    return;
  }
  if (!update) {
    res.status(409).json({
      error: force ? "No published release found to reinstall" : "No newer release is available",
    });
    return;
  }

  const requested = typeof req.body?.version === "string" ? req.body.version : undefined;
  if (!force && requested && requested !== update.availableVersion) {
    res.status(409).json({
      error: `Requested v${requested} but the available release is v${update.availableVersion}`,
    });
    return;
  }

  auditFromRequest(req, "core.updated", {
    target: `justflows@${update.availableVersion}`,
    detail: force
      ? `force reinstall v${update.availableVersion}`
      : `remote ${update.currentVersion} -> ${update.availableVersion}`,
  });

  try {
    const { mode, status, result } = await startCoreUpdate({
      source: "remote",
      siteId: req.session!.siteId,
      release: {
        availableVersion: update.availableVersion,
        downloadUrl: update.downloadUrl,
        sha256Url: update.sha256Url,
      },
    });
    if (mode === "background") {
      res.status(202).json({ started: true, background: true, status });
      return;
    }
    res.status(result?.ok ? 200 : 500).json({ ...result, background: false, status });
  } catch (err) {
    handleStartError(res, err);
  }
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
    res
      .status(409)
      .json({ error: "Automatic updates are disabled by JUSTFLOWS_DISABLE_AUTO_UPDATE" });
    return;
  }
  try {
    await setCoreAutoUpdateEnabled(enabled);
    auditFromRequest(req, "core.auto_update_toggled", {
      target: "core.auto_update",
      detail: enabled ? "enabled" : "disabled",
    });
    res.json({
      autoUpdate: {
        enabled,
        available: !isAutoUpdateKillSwitchOn(),
        maxScope: AUTO_UPDATE_MAX_SCOPE,
      },
    });
  } catch (err) {
    sendServerError(res, "updates", err);
  }
});

const dbRouter = Router();
dbRouter.post("/migrate", requireRole("administrator"), async (_req, res) => {
  try {
    const db = await getDb();
    const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb";
    const result = await runAllMigrations(db, driver);
    res.json({ ok: true, applied: result.applied.length, skipped: result.skipped.length });
  } catch (err) {
    sendServerError(res, "updates", err);
  }
});

export { dbRouter };
export default router;
