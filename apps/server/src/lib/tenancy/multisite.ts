// SPDX-License-Identifier: MIT

import type { RequestHandler } from "express";
import { getControlDb } from "../database/db.js";
import { isMissingTableError } from "../database/schema-errors.js";

/**
 * Multisite (the platform: workspaces, extra sites, public signup, platform
 * domains, owner workspace pages) is on only with `JF_MULTISITE=true`.
 * Unset or any other value keeps it fully off.
 *
 * Off never deletes data. The tenancy layer still runs because a single-site
 * install is one workspace with one site; only the root site is served and
 * every surface that creates or manages more of them is unreachable.
 */

/** `JF_MULTISITE` as a boolean. Only an explicit true value enables it. */
export function multisiteEnvFlag(value = process.env.JF_MULTISITE): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function multisiteEnabled(): boolean {
  return multisiteEnvFlag();
}

/**
 * Warn at boot when multisite is off but the registry holds more sites than
 * the root site, so the operator knows why those sites answer "Site not found".
 */
export async function warnIfMultisiteDataDisabled(): Promise<void> {
  if (multisiteEnabled()) return;
  try {
    const db = await getControlDb();
    const rows = await db.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM sites WHERE status <> 'deleted'");
    const count = Number(rows[0]?.count ?? 0) || 0;
    if (count > 1) {
      console.warn(
        `[justflows] Multisite is off, so only the root site is served. ${count - 1} other site(s) are kept but unreachable. Set JF_MULTISITE=true in .env to turn multisite on.`,
      );
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
}

/** Answers 404 for platform routes while multisite is off, as if they did not exist. */
export const requireMultisite: RequestHandler = (_req, res, next) => {
  if (multisiteEnabled()) {
    next();
    return;
  }
  res.status(404).json({ error: "Not found" });
};
