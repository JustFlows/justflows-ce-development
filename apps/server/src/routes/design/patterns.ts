// SPDX-License-Identifier: MIT

import { auditFromRequest } from "../../lib/security/audit-log.js";
import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { BlockPatternSchema, PatternSetSchema, type BlockPattern } from "@justflows/sdk";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES, THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { getActiveTheme, getSiteId, themeInstalledPath } from "../../lib/themes/themes-db.js";
import { listThemePatterns, loadThemePattern } from "../../lib/themes/theme-files.js";
import {
  deleteSitePattern,
  exportPatternSet,
  importPatternSet,
  listSitePatterns,
  saveSitePattern,
} from "../../lib/rendering/site-patterns.js";
import { param } from "../../lib/http/params.js";
import { getPluginLoader } from "../../lib/plugins/plugin-runtime.js";

const router = Router();
const DIRECTORY_URL = "https://api.justflows.com/v1/patterns";
const MAX_DIRECTORY_BYTES = 2 * 1024 * 1024;

// Every handler here reads theme files off disk, and some also reach the hosted
// directory or write site settings. CodeQL's js/missing-rate-limiting only
// models express-rate-limit, so guard the whole router and add a tighter cap on
// the writes and the outbound directory fetch.
const patternsLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many pattern requests" },
});
const patternsExpensiveLimit = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many pattern requests" },
});

router.use(patternsLimit);

/** Apply the tighter cap only when a request actually reaches the hosted directory. */
const directoryLimit: RequestHandler = (req, res, next) => {
  if (req.query.directory === "1" || req.params.source === "directory") {
    patternsExpensiveLimit(req, res, next);
    return;
  }
  next();
};

// Only peel off route-specific metadata here. BlockPatternSchema contains a
// cross-field refinement, and Zod 4 deliberately throws when `.partial()` is
// called on a refined object. saveSitePattern performs the authoritative full
// schema parse after it supplies defaults for id/version/schemaVersion.
const SaveSchema = z
  .object({
    synced: z.boolean().default(false),
  })
  .catchall(z.unknown());

function localeQuery(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)
    ? value
    : undefined;
}

async function activeTheme() {
  const siteId = await getSiteId();
  const theme = siteId ? await getActiveTheme(siteId) : null;
  return { siteId, theme, themeId: theme?.theme_id ?? "justflows.default" };
}

async function directoryPatterns(locale?: string): Promise<BlockPattern[]> {
  try {
    const url = new URL(DIRECTORY_URL);
    if (locale) url.searchParams.set("locale", locale);
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return [];
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_DIRECTORY_BYTES) return [];
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_DIRECTORY_BYTES) return [];
    const raw = JSON.parse(text) as unknown;
    const candidates = Array.isArray(raw) ? raw : (raw as { patterns?: unknown })?.patterns;
    if (!Array.isArray(candidates)) return [];
    return candidates.flatMap((candidate) => {
      const parsed = BlockPatternSchema.safeParse(candidate);
      if (!parsed.success) return [];
      return [
        {
          ...parsed.data,
          blocks: sanitizeBlockDocument({ version: 1, blocks: parsed.data.blocks }).blocks,
        } as BlockPattern,
      ];
    });
  } catch {
    return [];
  }
}

function localizePattern<T extends BlockPattern>(pattern: T, locale?: string): T {
  if (!locale || !pattern.locales) return pattern;
  const localized = pattern.locales[locale] ?? pattern.locales[locale.split("-")[0] ?? ""];
  return localized ? ({ ...pattern, ...localized } as T) : pattern;
}

router.get("/", requireRole(...CONTENT_READ_ROLES), directoryLimit, async (req, res) => {
  const locale = localeQuery(req.query.locale);
  const { siteId, theme, themeId } = await activeTheme();
  const themePatterns = listThemePatterns(themeId, themeInstalledPath(theme), locale);
  const sitePatterns = siteId ? await listSitePatterns(siteId, locale) : [];
  const remote = req.query.directory === "1" ? await directoryPatterns(locale) : [];
  const pluginPatterns = (getPluginLoader()?.patternRegistry.all() ?? []).map((registered) => {
    const pattern = localizePattern(registered, locale);
    const {
      blocks: _blocks,
      locales: _locales,
      pluginId: _pluginId,
      registryId,
      ...meta
    } = pattern;
    return { ...meta, id: registryId, source: "plugin" as const };
  });
  res.json({
    patterns: [
      ...sitePatterns.map(({ blocks: _blocks, locales: _locales, ...meta }) => meta),
      ...themePatterns,
      ...pluginPatterns,
      ...remote.map(({ blocks: _blocks, locales: _locales, ...meta }) => ({
        ...meta,
        source: "directory",
      })),
    ],
    directoryAvailable: remote.length > 0,
  });
});

router.get("/export", requireRole(...THEME_CUSTOMIZE_ROLES), async (_req, res) => {
  const siteId = await getSiteId();
  if (!siteId) return void res.status(503).json({ error: "No site found" });
  res.setHeader("Content-Disposition", 'attachment; filename="justflows-patterns.json"');
  res.json(await exportPatternSet(siteId));
});

router.post(
  "/import",
  requireRole(...THEME_CUSTOMIZE_ROLES),
  patternsExpensiveLimit,
  async (req, res) => {
    try {
      const body = PatternSetSchema.parse(req.body);
      const siteId = await getSiteId();
      if (!siteId) return void res.status(503).json({ error: "No site found" });
      const patterns = await importPatternSet(siteId, body);
      auditFromRequest(req, "design.patterns_changed", { siteId, target: "import", detail: `count=${Array.isArray(patterns) ? patterns.length : 0}` });
      res.json({ patterns });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid pattern set" });
    }
  },
);

router.put("/", requireRole(...THEME_CUSTOMIZE_ROLES), patternsExpensiveLimit, async (req, res) => {
  try {
    const body = SaveSchema.parse(req.body);
    const siteId = await getSiteId();
    if (!siteId) return void res.status(503).json({ error: "No site found" });
    const pattern = await saveSitePattern(siteId, body);
    auditFromRequest(req, "design.patterns_changed", { siteId, target: String((pattern as { id?: unknown })?.id ?? ""), detail: "save" });
    res.json({ pattern });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not save pattern" });
  }
});

router.get("/:source/:id", requireRole(...CONTENT_READ_ROLES), directoryLimit, async (req, res) => {
  const source = param(req.params.source);
  const id = param(req.params.id);
  const locale = localeQuery(req.query.locale);
  const { siteId, theme, themeId } = await activeTheme();
  if (source === "theme") {
    const pattern = loadThemePattern(themeId, id, themeInstalledPath(theme), locale);
    return pattern
      ? void res.json({ pattern })
      : void res.status(404).json({ error: "Pattern not found" });
  }
  if (source === "site" && siteId) {
    const pattern = (await listSitePatterns(siteId, locale)).find((item) => item.id === id);
    return pattern
      ? void res.json({ pattern })
      : void res.status(404).json({ error: "Pattern not found" });
  }
  if (source === "plugin") {
    const registered = getPluginLoader()?.patternRegistry.get(id);
    if (!registered) return void res.status(404).json({ error: "Pattern not found" });
    const pattern = localizePattern(registered, locale);
    return void res.json({
      pattern: {
        ...pattern,
        id: registered.registryId,
        source,
        blocks: sanitizeBlockDocument({ version: 1, blocks: pattern.blocks }).blocks,
      },
    });
  }
  if (source === "directory") {
    const pattern = (await directoryPatterns(locale)).find((item) => item.id === id);
    return pattern
      ? void res.json({ pattern: { ...pattern, source } })
      : void res.status(404).json({ error: "Pattern not found" });
  }
  res.status(404).json({ error: "Pattern not found" });
});

router.delete("/:id", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  const siteId = await getSiteId();
  if (!siteId) return void res.status(503).json({ error: "No site found" });
  await deleteSitePattern(siteId, param(req.params.id));
  auditFromRequest(req, "design.patterns_changed", { siteId, target: param(req.params.id), detail: "delete" });
  res.json({ ok: true });
});

export default router;
