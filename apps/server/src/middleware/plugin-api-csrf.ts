// SPDX-License-Identifier: MIT

import type { Request, Response, NextFunction } from "express";
import { isValidPluginApiNamespace } from "@justflows/sdk";
import { ensurePluginRuntime, getPluginLoader } from "../lib/plugins/plugin-runtime.js";
import { isInstalled } from "./install-guard.js";
import { csrfProtection } from "./csrf.js";

/** Registered aliases use the dispatcher policy; unmatched and core APIs keep the core guard. */
export async function pluginApiCsrf(req: Request, res: Response, next: NextFunction): Promise<void> {
  const path = req.originalUrl.split("?")[0] ?? "";
  const namespace = /^\/api\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  // Plugins load lazily; a webhook can be the first request after restart.
  if (isInstalled() && namespace && isValidPluginApiNamespace(namespace)) await ensurePluginRuntime();
  const router = getPluginLoader()?.httpRouter;
  if (router?.isPublicApiPath(path) && router.match(req.method, path)) { next(); return; }
  csrfProtection(req, res, next);
}
