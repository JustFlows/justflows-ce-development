// SPDX-License-Identifier: MIT

import { QuotaRefusalError } from "../../lib/tenancy/quotas.js";
import { randomUUID } from "node:crypto";
import { getTenantContext } from "../../lib/tenancy/context.js";
import type { StaticExportSummary } from "../../lib/static-export/index.js";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireInstallationRoot, requireRole } from "../../middleware/auth.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { getJfRoot } from "../../lib/runtime/jf-root.js";
import { isInstallationRootRequest } from "../../lib/tenancy/access.js";
import {
  clearStaticExport,
  getStaticExportStatus,
  runStaticExport,
} from "../../lib/static-export/index.js";
import {
  applyStaticExportSettings,
  readStaticExportSettings,
  StaticExportSettingsSchema,
} from "../../lib/static-export/settings.js";
import {
  assertExportOrigin,
  noteListenerPort,
  siteLoopbackOrigin,
} from "../../lib/static-export/config.js";
import { setCurrentSiteStaticExportEnabled } from "../../lib/static-export/site-enabled.js";

const router = Router();

/**
 * The crawl origin is normally resolved from the environment; the request-body
 * override exists only for dev / a hybrid proxy. `assertExportOrigin` restricts
 * it to loopback or an origin the operator has already configured, so a
 * compromised admin session cannot turn the exporter into an SSRF probe / DoS
 * cannon against arbitrary hosts.
 */
function isAllowedCrawlBase(raw: string): boolean {
  try {
    assertExportOrigin(raw);
    return true;
  } catch {
    return false;
  }
}

/** A customer site must not learn the server directory the export is written to. */
function hideInstallPaths<T>(value: T): T {
  if (isInstallationRootRequest()) return value;
  const root = getJfRoot();
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (!item.includes(root) && !item.includes("static-export-sites")) return item;
      return item
        .split(root)
        .join("")
        .replace(/\/?static-export-sites\/\S+/g, "this website's export");
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        out[key] = key === "outDir" || key === "envPath" ? "" : walk(child);
      }
      return out;
    }
    return item;
  };
  return walk(value) as T;
}

const runLimit = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many export runs — wait a minute and retry." },
});

router.use(requireRole("administrator"), (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

/** One export runs at a time per process — the crawl is I/O heavy. */
let inProgress: Promise<unknown> | null = null;
interface ExportJob {
  id: string;
  state: "running" | "completed" | "failed";
  log: string[];
  summary?: StaticExportSummary;
  error?: string;
}
const jobs = new Map<string, ExportJob>();
const currentJobSite = () => getTenantContext()?.siteId ?? "root";

router.get("/status", async (_req, res) => {
  try {
    const status = await getStaticExportStatus();
    res.json(
      hideInstallPaths({
        ...status,
        running: inProgress != null,
        job: jobs.get(currentJobSite()) ?? null,
      }),
    );
  } catch (err) {
    sendServerError(res, "static-export", err);
  }
});

router.post("/run", runLimit, async (req, res) => {
  if (inProgress) {
    res.status(409).json({ ok: false, error: "An export is already running." });
    return;
  }

  const body = (req.body ?? {}) as {
    mode?: unknown;
    baseUrl?: unknown;
    publicUrl?: unknown;
    async?: unknown;
  };
  const mode = body.mode === "incremental" ? "incremental" : "full";
  const baseUrlRaw =
    typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : "";
  noteListenerPort(req.socket.localPort);
  // Only the installation's operator chooses where the crawler connects; a
  // customer site always crawls itself.
  if (baseUrlRaw && !isInstallationRootRequest()) {
    res.status(400).json({ ok: false, error: "baseUrl can only be set on the main site." });
    return;
  }
  if (baseUrlRaw && !isAllowedCrawlBase(baseUrlRaw)) {
    res.status(400).json({
      ok: false,
      error: "baseUrl must be loopback or an origin already configured for this site.",
    });
    return;
  }
  const baseUrl = baseUrlRaw || undefined;
  const publicUrl = typeof body.publicUrl === "string" ? body.publicUrl.trim() : undefined;
  if (publicUrl && !/^https?:\/\/[^\s"'<>`\\]+$/i.test(publicUrl)) {
    res.status(400).json({ ok: false, error: "publicUrl must be an http(s) URL." });
    return;
  }

  // Off production, crawl over loopback on the port this connection arrived on,
  // so a non-default dev port just works. On production the crawl origin is
  // resolved from STATIC_EXPORT_CRAWL_URL / APP_URL in getStaticExportConfig —
  // a raw 127.0.0.1:PORT is not this app behind a proxy (Passenger, Plesk).
  const isProd = process.env.NODE_ENV === "production";
  const localPort = req.socket.localPort;
  // With more than one site, a bare 127.0.0.1 matches no site, so address this
  // site by its own hostname on that port.
  const resolvedBase =
    baseUrl ?? (!isProd && localPort ? siteLoopbackOrigin(localPort) : undefined);

  const job: ExportJob = { id: randomUUID(), state: "running", log: [] };
  const site = currentJobSite();
  // Keep the latest result per site without allowing unbounded process memory.
  if (!jobs.has(site) && jobs.size >= 100) jobs.delete(jobs.keys().next().value!);
  jobs.set(site, job);
  const run = (async () => {
    try {
      job.summary = await runStaticExport({
        mode,
        baseUrl: resolvedBase,
        publicUrl,
        reason: "admin",
        log: (line) => {
          if (job.log.length < 1000) job.log.push(line);
        },
      });
      job.state = job.summary.ok ? "completed" : "failed";
    } catch (err) {
      console.error(
        "[static-export] run failed:",
        JSON.stringify(String(err).replace(/\n/g, "").replace(/\r/g, "")),
      );
      job.state = "failed";
      job.error = err instanceof QuotaRefusalError ? err.message : "Static export failed. Check the server logs and storage connection, then retry.";
      job.log.push("✗ Static export failed.");
    }
  })();
  inProgress = run;
  void run.finally(() => {
    if (inProgress === run) inProgress = null;
  });
  if (body.async === true) {
    res.status(202).json({ ok: true, jobId: job.id });
    return;
  }
  // Preserve the synchronous contract used by existing CLI/API clients.
  await run;
  res.status(job.error ? 500 : 200).json(
    hideInstallPaths({
      ok: job.state === "completed",
      summary: job.summary,
      error: job.error,
      log: job.log,
    }),
  );
});

/** Delete the whole export directory. */
router.post("/clear", runLimit, async (req, res) => {
  if (inProgress) {
    res.status(409).json({ ok: false, error: "An export is running — try again shortly." });
    return;
  }
  try {
    const force = (req.body as { force?: unknown })?.force === true;
    const result = await clearStaticExport({ force });
    res.status(result.ok ? 200 : 400).json(hideInstallPaths(result));
  } catch (err) {
    sendServerError(res, "static-export", err);
  }
});

/** Read the editable STATIC_EXPORT_* settings (from .env, with live fallbacks). */
router.get("/settings", async (_req, res) => {
  try {
    res.json(hideInstallPaths(await readStaticExportSettings()));
  } catch (err) {
    sendServerError(res, "static-export", err);
  }
});

/** Turn static export off for this website. Does not change the installation `.env`. */
router.post("/site", async (req, res) => {
  if (isInstallationRootRequest()) {
    res.status(403).json({ error: "This is managed on the main site." });
    return;
  }
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be true or false." });
    return;
  }
  try {
    await setCurrentSiteStaticExportEnabled(enabled);
    res.json(hideInstallPaths({ ok: true, ...(await readStaticExportSettings()) }));
  } catch (err) {
    sendServerError(res, "static-export", err);
  }
});

/** Persist the settings to .env and apply them without a restart. */
// These settings live in the shared .env and describe the root site.
router.post("/settings", requireInstallationRoot, async (req, res) => {
  const parsed = StaticExportSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid settings" });
    return;
  }
  try {
    res.json({ ok: true, ...(await applyStaticExportSettings(parsed.data)) });
  } catch (err) {
    sendServerError(res, "static-export", err);
  }
});

export default router;
