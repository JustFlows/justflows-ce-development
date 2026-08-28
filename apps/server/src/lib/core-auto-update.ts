// SPDX-License-Identifier: MIT

// Unattended core updates.
//
// When an administrator has opted in (Admin -> Updates -> Automatic updates), a
// daily job installs a newer release *only* when it stays inside the current
// major line. A major bump can break a site, so it always waits for a human.
// `JUSTFLOWS_DISABLE_AUTO_UPDATE=1` is an operator-level kill switch that
// overrides the stored preference.

import { auditLog } from "./audit-log.js";
import { applyCoreUpdateFromRelease } from "./core-updater.js";
import { getAvailableCoreUpdate } from "./core-release-check.js";
import { getSiteId, getSiteSetting, setSiteSetting } from "./site-settings.js";

export const AUTO_UPDATE_SETTING_KEY = "core.auto_update";

/** Auto-update never crosses a major version — this is shown in the UI. */
export const AUTO_UPDATE_MAX_SCOPE = "minor";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;

export function isAutoUpdateKillSwitchOn(): boolean {
  return process.env.JUSTFLOWS_DISABLE_AUTO_UPDATE === "1";
}

export async function isCoreAutoUpdateEnabled(): Promise<boolean> {
  const siteId = await getSiteId();
  if (!siteId) return false;
  return (await getSiteSetting<boolean>(siteId, AUTO_UPDATE_SETTING_KEY)) === true;
}

export async function setCoreAutoUpdateEnabled(enabled: boolean): Promise<void> {
  const siteId = await getSiteId();
  if (!siteId) throw new Error("No site found");
  await setSiteSetting(siteId, AUTO_UPDATE_SETTING_KEY, enabled);
}

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function runAutoUpdate(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (isAutoUpdateKillSwitchOn()) return;
    if (!(await isCoreAutoUpdateEnabled())) return;

    const update = await getAvailableCoreUpdate({ force: true });
    if (!update) return;

    const siteId = await getSiteId();
    if (!update.autoUpdatable) {
      if (siteId) {
        void auditLog({
          siteId,
          action: "core.auto_update_skipped",
          detail: `${update.currentVersion} -> ${update.availableVersion} (major change needs manual approval)`,
        });
      }
      return;
    }

    if (siteId) {
      void auditLog({
        siteId,
        action: "core.auto_update_started",
        detail: `${update.currentVersion} -> ${update.availableVersion}`,
      });
    }

    const result = await applyCoreUpdateFromRelease(update);

    if (siteId) {
      void auditLog({
        siteId,
        action: result.ok ? "core.auto_update_completed" : "core.auto_update_failed",
        detail: result.ok
          ? `${result.currentVersion} -> ${result.newVersion}`
          : (result.steps.find((s) => !s.ok)?.detail ?? "Update failed"),
      });
    }
  } catch (err) {
    console.error("[justflows] Auto-update check failed:", String(err).replace(/\n/g, " "));
  } finally {
    running = false;
  }
}

/** Runs shortly after boot, then once a day. No-op until an admin opts in. */
export function startCoreAutoUpdateJob(): void {
  if (timer || bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void runAutoUpdate();
  }, BOOT_DELAY_MS);
  timer = setInterval(() => {
    void runAutoUpdate();
  }, CHECK_INTERVAL_MS);
}

export function stopCoreAutoUpdateJob(): void {
  if (timer) clearInterval(timer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
}
