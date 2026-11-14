import { Router } from "express";
import {
  defaultModsFromSchema,
  getEffectiveThemeCss,
  getNavigationMenuSlugs,
  getSiteIdentity,
  getThemeMods,
  mergeMods,
} from "../../lib/themes/theme-customize.js";
import { ensureThemesTable, getActiveTheme, getSiteId } from "../../lib/themes/themes-db.js";
import { isPreviewAllowed } from "../../lib/auth/auth-session.js";
import { getGeneralSettings } from "../../lib/settings/general-settings.js";
import { isSafeScopeSelector, scopeThemeCss } from "../../lib/rendering/scope-css.js";
import { activeThemeScripts, contentVersion, IMMUTABLE_CACHE_CONTROL } from "../../lib/themes/theme-asset-versions.js";
import { resolveThemeAssetFile, themePerPageStylesText } from "../../lib/themes/theme-block-assets.js";
import fs from "node:fs";
import fsp from "node:fs/promises";

const router = Router();

router.get("/identity", async (req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.json({ siteTitle: "My Site", tagline: "", logoUrl: "", faviconUrl: "" });
      return;
    }

    const preview = await isPreviewAllowed(req, res);
    const theme = await getActiveTheme(siteId);
    const themeId = theme?.theme_id ?? "justflows.default";

    const defaults = defaultModsFromSchema();
    const published = (await getThemeMods(themeId, false)) ?? {};
    const draft = preview ? ((await getThemeMods(themeId, true)) ?? {}) : {};
    const mods = mergeMods(mergeMods(defaults, published), draft);

    const identity = await getSiteIdentity(mods, { preview });
    const general = await getGeneralSettings(siteId);
    const nav = getNavigationMenuSlugs(mods);
    res.json({
      ...identity,
      headerMenu: nav.header ?? "primary",
      timezone: general.timezone,
      dateFormat: general.dateFormat,
      timeFormat: general.timeFormat,
      startOfWeek: general.startOfWeek,
    });
  } catch {
    res.json({ siteTitle: "My Site", tagline: "", logoUrl: "", faviconUrl: "" });
  }
});

export default router;

export async function serveThemeCss(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  const preview = await isPreviewAllowed(req, res);
  // `?scope=.jf-theme-surface` confines the whole sheet to one subtree so the
  // page builder can link it without repainting the admin chrome.
  const scopeParam = typeof req.query.scope === "string" ? req.query.scope : "";
  const scope = isSafeScopeSelector(scopeParam) ? scopeParam : "";
  try {
    let css = await getEffectiveThemeCss(preview);
    /**
     * The page builder canvas (the only `scope` caller) previews any block, so
     * it also gets every per-page plugin and theme stylesheet, ahead of the
     * theme as on a page.
     */
    if (scope) {
      const { pluginPerPageStylesText } = await import("../../lib/plugins/plugin-assets.js");
      const perPage = [await pluginPerPageStylesText(), await themePerPageStylesText()].filter(Boolean).join("\n");
      /** `?widths=canvas`: width media queries follow the builder canvas, not the window (justflows-ce#300). */
      css = scopeThemeCss(perPage ? `${perPage}\n${css}` : css, scope, req.query.widths === "canvas" ? "jf-canvas" : undefined);
    }
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.setHeader(
      "Cache-Control",
      preview
        ? "no-store"
        : !scope && req.query.v === contentVersion(css)
          ? IMMUTABLE_CACHE_CONTROL
          : "public, max-age=60, stale-while-revalidate=300",
    );
    res.send(css);
  } catch {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.send(":root {}\n");
  }
}

export async function serveThemeScripts(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const scripts = await activeThemeScripts();
    /** Pages link `?v=<hash>`; only that exact content may be cached for good. */
    if (typeof req.query.v === "string") {
      res.setHeader("Cache-Control", scripts && req.query.v === contentVersion(scripts) ? IMMUTABLE_CACHE_CONTROL : "no-cache");
    }
    res.send(scripts);
  } catch { res.status(503).send("/* Theme scripts unavailable. */"); }
}

/**
 * `/theme-assets/<path>`: a script or stylesheet the active theme declared in
 * `assets.blocks`, and nothing else from its folder. Cached for good only when
 * `?v=` is the hash of the bytes being sent.
 */
export async function serveThemeBlockAsset(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): Promise<void> {
  try {
    const params = req.params as unknown as string[];
    const file = await resolveThemeAssetFile(params[0] ?? "");
    if (!file) { next(); return; }
    const fd = await fsp.open(file.absPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let body: Buffer;
    try {
      body = await fd.readFile();
    } finally {
      await fd.close();
    }
    res.type(file.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", req.query.v === contentVersion(body) ? IMMUTABLE_CACHE_CONTROL : "no-cache");
    res.send(body);
  } catch {
    next();
  }
}
