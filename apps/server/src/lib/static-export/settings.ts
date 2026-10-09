// SPDX-License-Identifier: MIT

import { s3UploadConfig } from "../media/upload-store.js";
import path from "node:path";
import { z } from "zod";
import { parseEnvBool } from "@justflows/core";
import { getJfRoot } from "../runtime/jf-root.js";
import { applyEnvToProcess, readEnvMap, updateEnvKeys } from "../settings/env-file.js";
import { getStaticExportConfig, intFromEnv } from "./config.js";
import { isStaticExportAutoArmed, refreshStaticExportAutoRebuild } from "./auto.js";
import { isCurrentSiteStaticExportEnabled } from "./site-enabled.js";

/** An http(s) URL with no characters that could break out of an HTML attribute
 *  or an inline `<script>` when the value is later stamped into exported pages. */
function isSafeHttpUrl(v: string): boolean {
  if (v === "") return true;
  if (v.length > 500 || !/^https?:\/\/[^\s"'<>`\\]+$/i.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const URL_MSG = "Must be an http(s) URL (no spaces or quotes) or empty";

/** A relative path with no `..` segments and no drive/root prefix. */
function isSafeRelDir(v: string): boolean {
  if (v === "") return true;
  if (path.isAbsolute(v)) return false;
  const segments = v.split(/[\\/]+/);
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && /^[\w.-]+$/.test(s));
}

/**
 * Editable `STATIC_EXPORT_*` settings. Everything is read fresh from
 * `process.env` on each export, so a save applies immediately — no restart, the
 * auto-rebuild listener is re-armed in place.
 */
export const StaticExportSettingsSchema = z.object({
  enabled: z.boolean(),
  storageDriver: z.enum(["local", "s3"]).default("local"),
  dir: z
    .string()
    .trim()
    .max(500)
    .refine(isSafeRelDir, "Must be a relative path with no '..' segments"),
  baseUrl: z.string().trim().max(500).refine(isSafeHttpUrl, URL_MSG),
  /** Origin the crawler fetches from. Blank = loopback (dev) / `APP_URL` (prod). */
  crawlUrl: z.string().trim().max(500).refine(isSafeHttpUrl, URL_MSG),
  originUrl: z.string().trim().max(500).refine(isSafeHttpUrl, URL_MSG),
  /** Comma-separated origins allowed to cross-origin POST the submit endpoints. */
  allowedOrigins: z
    .string()
    .trim()
    .max(2000)
    .refine(
      (v) =>
        v === "" ||
        v
          .split(",")
          .map((s) => s.trim())
          .every((s) => s === "" || isSafeHttpUrl(s)),
      "Each origin must be an http(s) URL",
    ),
  maxPages: z.coerce.number().int().min(1).max(100_000),
  concurrency: z.coerce.number().int().min(1).max(32),
  auto: z.boolean(),
  debounceMs: z.coerce.number().int().min(250).max(600_000),
});

export type StaticExportSettings = z.infer<typeof StaticExportSettingsSchema>;

function envGet(map: Map<string, string>, key: string): string | undefined {
  return map.get(key) ?? process.env[key];
}

/** Current values, preferring the .env file over the live process. */
export async function readStaticExportSettings(): Promise<{
  settings: StaticExportSettings;
  runtime: {
    outDir: string;
    publicUrl: string;
    autoArmed: boolean;
    revalidateEnabled: boolean;
    /** `APP_URL`, offered as the one-click value for the dynamic-endpoint origin. */
    appUrl: string;
  };
  envPath: string;
  /** False when this website has turned static export off. The installation site is always true. */
  siteEnabled: boolean;
}> {
  const map = await readEnvMap();
  const settings: StaticExportSettings = {
    storageDriver: envGet(map, "STATIC_EXPORT_STORAGE_DRIVER") === "s3" ? "s3" : "local",
    enabled: parseEnvBool(envGet(map, "STATIC_EXPORT_ENABLED"), true),
    dir: (envGet(map, "STATIC_EXPORT_DIR") ?? "").trim(),
    baseUrl: (envGet(map, "STATIC_EXPORT_BASE_URL") ?? "").trim(),
    crawlUrl: (envGet(map, "STATIC_EXPORT_CRAWL_URL") ?? "").trim(),
    originUrl: (envGet(map, "STATIC_EXPORT_ORIGIN_URL") ?? "").trim(),
    allowedOrigins: (envGet(map, "STATIC_EXPORT_ALLOWED_ORIGINS") ?? "").trim(),
    maxPages: intFromEnv(envGet(map, "STATIC_EXPORT_MAX_PAGES"), 2000, 1, 100_000),
    concurrency: intFromEnv(envGet(map, "STATIC_EXPORT_CONCURRENCY"), 4, 1, 32),
    auto: parseEnvBool(envGet(map, "STATIC_EXPORT_AUTO"), false),
    debounceMs: intFromEnv(envGet(map, "STATIC_EXPORT_DEBOUNCE_MS"), 5000, 250, 600_000),
  };

  const resolved = getStaticExportConfig();
  return {
    settings,
    runtime: {
      outDir: resolved.outDir,
      publicUrl: resolved.publicUrl,
      autoArmed: isStaticExportAutoArmed(),
      revalidateEnabled: parseEnvBool(process.env.CACHE_REVALIDATE_ENABLED, false),
      appUrl: (process.env.APP_URL ?? "").trim().replace(/\/+$/, ""),
    },
    envPath: path.join(getJfRoot(), ".env"),
    siteEnabled: await isCurrentSiteStaticExportEnabled(),
  };
}

function toEnvUpdates(body: StaticExportSettings): Record<string, string | null> {
  return {
    STATIC_EXPORT_STORAGE_DRIVER: body.storageDriver,
    STATIC_EXPORT_ENABLED: body.enabled ? "1" : "0",
    STATIC_EXPORT_DIR: body.dir ? body.dir : null,
    STATIC_EXPORT_BASE_URL: body.baseUrl ? body.baseUrl : null,
    STATIC_EXPORT_CRAWL_URL: body.crawlUrl ? body.crawlUrl : null,
    STATIC_EXPORT_ORIGIN_URL: body.originUrl ? body.originUrl : null,
    STATIC_EXPORT_ALLOWED_ORIGINS: body.allowedOrigins ? body.allowedOrigins : null,
    STATIC_EXPORT_MAX_PAGES: String(body.maxPages),
    STATIC_EXPORT_CONCURRENCY: String(body.concurrency),
    STATIC_EXPORT_AUTO: body.auto ? "1" : "0",
    STATIC_EXPORT_DEBOUNCE_MS: String(body.debounceMs),
  };
}

export async function applyStaticExportSettings(
  body: StaticExportSettings,
): Promise<Awaited<ReturnType<typeof readStaticExportSettings>>> {
  const parsed = StaticExportSettingsSchema.parse(body);
  if (parsed.storageDriver === "s3") s3UploadConfig();
  const updates = toEnvUpdates(parsed);
  await updateEnvKeys(updates);
  applyEnvToProcess(updates);
  // Pick up (or drop) the auto-rebuild listener without a restart.
  refreshStaticExportAutoRebuild();
  return readStaticExportSettings();
}
