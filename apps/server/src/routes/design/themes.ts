import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  clearThemeDraft,
  defaultModsFromSchema,
  getCustomizeSchema,
  getEffectiveThemeCss,
  getSiteIdentity,
  getThemeMods,
  mergeMods,
  modsToCssVariables,
  publishThemeMods,
  saveThemeMods,
  schemaWithThemeControls,
  type ThemeMods,
} from "../../lib/themes/theme-customize.js";
import { listLayoutScopes } from "../../lib/themes/layout-scopes.js";
import {
  clearThemeHomeDraft,
  defaultHomeBlocksFromTheme,
  getEffectiveHomeBlocks,
  getThemeHomeBlocks,
  publishThemeHomeBlocks,
  saveThemeHomeBlocks,
} from "../../lib/themes/theme-home-blocks.js";
import {
  clearThemeBlogDraft,
  defaultBlogBlocksFromTheme,
  getEffectiveBlogBlocks,
  getThemeBlogBlocks,
  publishThemeBlogBlocks,
  saveThemeBlogBlocks,
} from "../../lib/themes/theme-blog-blocks.js";
import { normalizeBlocks, serializeContentRow } from "../../lib/content/content-api.js";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { getHomePageId, setHomePageId } from "../../lib/content/home-page.js";
import { getBlogPageId, setBlogPageId } from "../../lib/content/blog-page.js";
import { getDb } from "../../lib/database/db.js";
import { getDefaultLocale } from "../../lib/i18n/languages-db.js";
import { sanitizeBlockDocument } from "@justflows/blocks";
import { pluginPatternById } from "../../lib/content/default-content-blocks.js";
import { ensurePluginRuntime } from "../../lib/plugins/plugin-runtime.js";
import { listThemePatterns, loadThemePattern } from "../../lib/themes/theme-files.js";
import {
  activateTheme,
  deleteTheme,
  ensureThemesTable,
  getActiveTheme,
  getTheme,
  getSiteId,
  insertTheme,
  listThemes,
  syncBundledThemes,
  themeInstalledPath,
} from "../../lib/themes/themes-db.js";
import { activateThemeAdmin } from "../../lib/themes/themes-admin.js";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES, THEME_CUSTOMIZE_ROLES } from "../../lib/auth/rbac.js";
import { param } from "../../lib/http/params.js";
import multer from "multer";
import { assertPackageIsTrusted } from "../../lib/extensions/package-trust.js";
import { sendPackageInstallError } from "../../lib/extensions/package-install-error.js";
import { packagesInstalledDir } from "../../lib/extensions/packages-dir.js";
import { getJustflowsVersion } from "../../lib/runtime/version.js";
import { auditFromRequest } from "../../lib/security/audit-log.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { resolvePathUnderBase } from "../../lib/security/safe-path.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const themeDeleteRequestLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function extractCssVariables(manifest: Record<string, unknown>): Record<string, string> {
  const vars = (manifest.cssVariables ?? manifest.css_variables ?? {}) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

router.get("/", requireRole(...THEME_CUSTOMIZE_ROLES), async (_req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.json({ themes: [] });
      return;
    }
    const themes = await listThemes(siteId);
    res.json({
      themes: themes.map((theme) => ({
        ...theme,
        themeId: theme.theme_id,
      })),
    });
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

router.post("/", requireRole("administrator"), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    if (!file.originalname.endsWith(".jfpkg") && !file.originalname.endsWith(".zip")) {
      res.status(400).json({ error: "Only .jfpkg files are accepted" });
      return;
    }

    const { PackageInstaller } = await import("@justflows/installer");
    const installer = new PackageInstaller();
    const packagesDir = packagesInstalledDir();

    // Verified inside the installer, while the package is still staged — see
    // the note on InstallOptions.verify.
    const result = await installer.installFromBuffer(file.buffer, {
      packagesDir,
      justflowsVersion: getJustflowsVersion(),
      source: "upload",
      verify: (manifest, digest) => {
        if (manifest.type !== "theme") {
          throw new Error("Uploaded package is not a theme (manifest.type must be 'theme')");
        }
        assertPackageIsTrusted(manifest as unknown as Record<string, unknown>, digest);
      },
    });

    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found — complete install first" });
      return;
    }

    const manifest = {
      ...(result.manifest as unknown as Record<string, unknown>),
      installedPath: result.installedPath,
    };
    const cssVariables = extractCssVariables(manifest);

    const theme = {
      id: randomUUID(),
      themeId: result.manifest.id,
      name: result.manifest.name,
      version: result.manifest.version,
      publisher: result.manifest.publisher,
      description: result.manifest.description,
      cssVariables,
      manifest,
    };

    await insertTheme(siteId, theme);
    auditFromRequest(req, "theme.installed", {
      target: result.manifest.id,
      detail: `version=${result.manifest.version} digest=${result.digest.slice(0, 16)}`,
    });
    res.json({ theme: { ...theme, status: "installed", active: false } });
  } catch (err) {
    sendPackageInstallError(res, err);
  }
});

router.get("/patterns", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    const theme = siteId ? await getActiveTheme(siteId) : null;
    const themeId = theme?.theme_id ?? "justflows.default";
    res.json({ patterns: listThemePatterns(themeId, themeInstalledPath(theme)) });
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

router.get("/patterns/:slug", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    const theme = siteId ? await getActiveTheme(siteId) : null;
    const themeId = theme?.theme_id ?? "justflows.default";
    const slug = param(req.params.slug);
    const pattern = loadThemePattern(themeId, slug, themeInstalledPath(theme));
    if (pattern) {
      res.json({ pattern });
      return;
    }
    await ensurePluginRuntime();
    const registered = pluginPatternById(slug);
    if (!registered) {
      res.status(404).json({ error: "Pattern not found" });
      return;
    }
    res.json({
      pattern: {
        ...registered,
        source: "plugin",
        blocks: sanitizeBlockDocument({ version: 1, blocks: registered.blocks }).blocks,
      },
    });
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

// Custom properties the active theme exposes for tweaking — surfaced in the
// page builder's per-block "Custom CSS" panel so an editor can see what
// `& { --… : … }` overrides are available instead of guessing.
interface StyleTokenDto {
  name: string;
  label: string;
  section: string;
  description?: string;
  type: string;
  value: string;
  presets?: { label: string; value: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

// Platform hooks any theme can honour, set per block by the Layout panel's
// colour fields or by hand here.
const BLOCK_LEVEL_TOKENS: StyleTokenDto[] = [
  {
    name: "--jf-block-bg",
    label: "Block background",
    section: "Per block",
    type: "color",
    value: "#ffffff",
  },
  {
    name: "--jf-block-text",
    label: "Block text colour",
    section: "Per block",
    type: "color",
    value: "#111111",
  },
  {
    name: "--jf-block-accent",
    label: "Block accent",
    section: "Per block",
    type: "color",
    value: "#3b82f6",
    description: "An accent a theme can opt specific elements into with var(--jf-block-accent, …).",
  },
  // Read by the default theme's `.jf-color-scheme` rules; the builder only
  // surfaces these on the core.color-scheme block (see ThemeBlockControls).
  {
    name: "--jf-color-scheme-active-bg",
    label: "Selected background",
    section: "Light / dark toggle",
    type: "color",
    value: "#2563eb",
  },
  {
    name: "--jf-color-scheme-active-fg",
    label: "Selected text",
    section: "Light / dark toggle",
    type: "color",
    value: "#ffffff",
  },
  {
    name: "--jf-color-scheme-hover-bg",
    label: "Hover background",
    section: "Light / dark toggle",
    type: "color",
    value: "#f8fafc",
  },
  {
    name: "--jf-color-scheme-hover-fg",
    label: "Hover text",
    section: "Light / dark toggle",
    type: "color",
    value: "#0f172a",
  },
  {
    name: "--jf-color-scheme-hover-border",
    label: "Hover border",
    section: "Light / dark toggle",
    type: "color",
    value: "#2563eb",
  },
];

router.get("/style-tokens", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    // The builder may be opened without visiting /admin/themes first, so make
    // sure a bundled theme's row carries its latest manifest (customize +
    // blockControls) before we read it.
    if (siteId) await syncBundledThemes(siteId);
    const theme = siteId ? await getActiveTheme(siteId) : null;
    const themeId = theme?.theme_id ?? "justflows.default";
    const schema = schemaWithThemeControls(theme?.manifest);
    const published = siteId ? ((await getThemeMods(themeId, false)) ?? {}) : {};
    const mods = mergeMods(defaultModsFromSchema(schema), published);
    const vars = modsToCssVariables(
      (theme?.css_variables as Record<string, string> | undefined) ?? {},
      mods,
      schema,
    );

    const tokens: StyleTokenDto[] = [];
    const seen = new Set<string>();
    for (const [sectionKey, section] of Object.entries(schema)) {
      // `colorsDark` re-declares the same `--color-*` names for the dark
      // palette; skip it (and the non-token sections) so each name appears once.
      if (
        sectionKey === "identity" ||
        sectionKey === "advanced" ||
        sectionKey === "navigation" ||
        sectionKey === "colorsDark"
      ) {
        continue;
      }
      for (const [key, control] of Object.entries(section.controls)) {
        if (!key.startsWith("--") || seen.has(key)) continue;
        seen.add(key);
        tokens.push({
          name: key,
          label: control.label,
          section: section.label,
          description: control.description,
          type: control.type,
          value: vars[key] ?? String(control.default),
          presets: control.options?.map((o) => ({ label: o.label, value: o.value })),
          min: control.min,
          max: control.max,
          step: control.step,
          unit: control.unit,
        });
      }
    }
    tokens.push(...BLOCK_LEVEL_TOKENS.filter((tk) => !seen.has(tk.name)));

    // `blockControls` maps a block type to the token names that should appear as
    // first-class controls in that block's inspector. Keep only names we know.
    const known = new Set(tokens.map((t) => t.name));
    const rawBlockControls = (theme?.manifest as Record<string, unknown> | undefined)
      ?.blockControls;
    const blockControls: Record<string, string[]> = {};
    if (
      rawBlockControls &&
      typeof rawBlockControls === "object" &&
      !Array.isArray(rawBlockControls)
    ) {
      for (const [blockType, list] of Object.entries(rawBlockControls as Record<string, unknown>)) {
        if (!/^[a-z0-9.-]{1,64}$/i.test(blockType) || !Array.isArray(list)) continue;
        const names = list.filter((n): n is string => typeof n === "string" && known.has(n));
        if (names.length) blockControls[blockType] = names;
      }
    }

    res.json({ theme: theme?.name ?? "Theme", tokens, blockControls });
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

const SaveAsSchema = z.object({
  name: z.string().min(1).max(80),
  activate: z.boolean().default(false),
});

/** Save the active theme + this site's customisations as a new named theme. */
router.post("/save-as", requireRole("administrator"), async (req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const body = SaveAsSchema.parse(req.body);
    const { forkActiveTheme } = await import("../../lib/themes/theme-fork.js");
    const result = await forkActiveTheme(siteId, body.name);

    auditFromRequest(req, "theme.installed", {
      target: result.themeId,
      detail: `saved-as from customizer`,
    });

    if (body.activate) {
      await activateTheme(siteId, result.themeId);
      auditFromRequest(req, "theme.activated", { target: result.themeId, siteId });
      await revalidateOnUpdate("theme", { siteId });
    }

    res.json({ themeId: result.themeId, name: result.name, activated: body.activate });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "A theme name is required" });
      return;
    }
    sendServerError(res, "themes", err);
  }
});

router.post("/:id/activate", requireRole("administrator"), async (req, res) => {
  try {
    const result = await activateThemeAdmin(param(req.params.id), {
      userId: req.session!.userId,
      role: req.session!.role,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

router.delete("/:id", requireRole("administrator"), themeDeleteRequestLimit, async (req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found — complete install first" });
      return;
    }
    const themeId = param(req.params.id);
    const theme = await getTheme(siteId, themeId);
    if (!theme) {
      res.status(404).json({ error: "Theme not found" });
      return;
    }
    if (theme.status === "active") {
      res.status(409).json({ error: "Activate another theme before deleting this one." });
      return;
    }

    const installedPath = themeInstalledPath(theme);
    if (theme.theme_id === "justflows.default") {
      res.status(409).json({ error: "The default bundled theme cannot be deleted." });
      return;
    }
    if (installedPath) {
      const packagesDir = packagesInstalledDir();
      const expectedPath = resolvePathUnderBase(
        packagesDir,
        "themes",
        theme.theme_id,
        theme.version,
      );
      const safeInstalledPath = resolvePathUnderBase(
        packagesDir,
        path.relative(packagesDir, installedPath),
      );
      if (!expectedPath || safeInstalledPath !== expectedPath) {
        res.status(400).json({ error: "Theme install path is invalid." });
        return;
      }
      await fs.rm(safeInstalledPath, { recursive: true, force: true });
    }
    await deleteTheme(siteId, themeId);
    auditFromRequest(req, "theme.deleted", { target: themeId, detail: `version=${theme.version}` });
    await revalidateOnUpdate("theme");
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

// Section buckets are `{ controlKey: string | number }`. Built-in sections are
// named for clarity; `.catchall` admits any theme-contributed section with the
// same value shape. Every value is
// re-validated against the schema in `modsToCssVariables` before it reaches CSS.
const ModSection = z.record(z.string(), z.union([z.string(), z.number()])).optional();
const ModsSchema = z
  .object({
    identity: ModSection,
    colors: ModSection,
    colorsDark: ModSection,
    typography: ModSection,
    headings: ModSection,
    spacing: ModSection,
    radius: ModSection,
    shadow: ModSection,
    layout: ModSection,
    navigation: ModSection,
    advanced: ModSection,
  })
  .catchall(z.record(z.string(), z.union([z.string(), z.number()])));

const BlockDocumentSchema = z.object({
  version: z.literal(1).default(1),
  blocks: z.array(z.record(z.string(), z.unknown())),
});

const PatchSchema = z.object({
  mods: ModsSchema.optional(),
  blocks: BlockDocumentSchema.optional(),
  homePageId: z.string().uuid().nullable().optional(),
  blogBlocks: BlockDocumentSchema.optional(),
  blogPageId: z.string().uuid().nullable().optional(),
  draft: z.boolean().default(true),
  publish: z.boolean().default(false),
});

router.get("/customize", requireRole(...THEME_CUSTOMIZE_ROLES), async (_req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    await syncBundledThemes(siteId);

    const theme = await getActiveTheme(siteId);
    if (!theme) {
      res.status(404).json({ error: "No active theme — activate a theme first" });
      return;
    }

    const defaults = defaultModsFromSchema(schemaWithThemeControls(theme.manifest));
    const published = (await getThemeMods(theme.theme_id, false)) ?? {};
    const draft = (await getThemeMods(theme.theme_id, true)) ?? {};
    const effective = mergeMods(mergeMods(defaults, published), draft);
    const identity = await getSiteIdentity(effective);
    effective.identity = {
      ...effective.identity,
      siteTitle: identity.siteTitle,
      tagline: identity.tagline,
    };

    const homeDraft = (await getThemeHomeBlocks(theme.theme_id, true)) ?? null;
    const homePublished = (await getThemeHomeBlocks(theme.theme_id, false)) ?? null;
    const defaultBlocks = defaultHomeBlocksFromTheme(theme.theme_id);
    const effectiveBlocks = await getEffectiveHomeBlocks(theme.theme_id, true);
    const homePageId = await getHomePageId(siteId);
    const blogDraft = (await getThemeBlogBlocks(theme.theme_id, true)) ?? null;
    const blogPublished = (await getThemeBlogBlocks(theme.theme_id, false)) ?? null;
    const defaultBlogBlocks = defaultBlogBlocksFromTheme(theme.theme_id);
    const effectiveBlogBlocks = await getEffectiveBlogBlocks(theme.theme_id, true);
    const blogPageId = await getBlogPageId(siteId);
    const db = await getDb();
    const pageRows = await db.query<{
      id: string;
      title: string;
      slug: string;
      locale: string;
      status: string;
    }>(
      "SELECT id, title, slug, locale, status FROM content WHERE site_id = ? AND type = 'page' ORDER BY title ASC",
      [siteId],
    );

    res.json({
      theme: { id: theme.theme_id, name: theme.name, version: theme.version },
      schema: await getCustomizeSchema(siteId),
      mods: effective,
      blocks: effectiveBlocks,
      defaultBlocks,
      published: mergeMods(defaults, published),
      publishedBlocks: homePublished?.blocks.length ? homePublished : null,
      hasDraft:
        Object.keys(draft).length > 0 ||
        Boolean(homeDraft?.blocks.length) ||
        Boolean(blogDraft?.blocks.length),
      homePageId,
      blogBlocks: effectiveBlogBlocks,
      defaultBlogBlocks,
      publishedBlogBlocks: blogPublished?.blocks.length ? blogPublished : null,
      blogPageId,
      layoutScopes: await listLayoutScopes(siteId),
      pages: pageRows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        slug: String(row.slug),
        locale: String(row.locale ?? "en-US"),
        status: String(row.status),
      })),
    });
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

router.patch("/customize", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const body = PatchSchema.parse(req.body);
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }

    const theme = await getActiveTheme(siteId);
    if (!theme) {
      res.status(404).json({ error: "No active theme" });
      return;
    }

    const defaults = defaultModsFromSchema(schemaWithThemeControls(theme.manifest));
    const published = (await getThemeMods(theme.theme_id, false)) ?? {};
    const base = mergeMods(defaults, published);
    const currentMods = mergeMods(base, (await getThemeMods(theme.theme_id, true)) ?? {});
    const mods = body.mods ? mergeMods(base, body.mods as ThemeMods) : currentMods;

    const currentBlocks = await getEffectiveHomeBlocks(theme.theme_id, true);
    const blocks = body.blocks ? normalizeBlocks(body.blocks) : currentBlocks;
    const homePageId =
      body.homePageId !== undefined
        ? await setHomePageId(siteId, body.homePageId)
        : await getHomePageId(siteId);

    const currentBlogBlocks = await getEffectiveBlogBlocks(theme.theme_id, true);
    const blogBlocks = body.blogBlocks ? normalizeBlocks(body.blogBlocks) : currentBlogBlocks;
    const blogPageId =
      body.blogPageId !== undefined
        ? await setBlogPageId(siteId, body.blogPageId)
        : await getBlogPageId(siteId);

    if (body.publish) {
      await publishThemeMods(theme.theme_id, mods);
      await publishThemeHomeBlocks(theme.theme_id, blocks);
      await publishThemeBlogBlocks(theme.theme_id, blogBlocks);
      await revalidateOnUpdate("theme");
      res.json({ ok: true, published: true, mods, blocks, homePageId, blogBlocks, blogPageId });
      return;
    }

    await saveThemeMods(theme.theme_id, mods, body.draft);
    await saveThemeHomeBlocks(theme.theme_id, blocks, body.draft);
    await saveThemeBlogBlocks(theme.theme_id, blogBlocks, body.draft);
    await revalidateOnUpdate("theme");
    res.json({ ok: true, published: false, mods, blocks, homePageId, blogBlocks, blogPageId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("Custom CSS") ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

router.post("/customize/promote-home", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const theme = await getActiveTheme(siteId);
    if (!theme) {
      res.status(404).json({ error: "No active theme" });
      return;
    }

    const session = req.session!;
    const blocks = await getEffectiveHomeBlocks(theme.theme_id, true);
    const locale = await getDefaultLocale();
    const db = await getDb();
    const candidates = ["home", "homepage", "front"];
    let slug = "home";
    for (const candidate of candidates) {
      const existing = await db.query<{ id: string }>(
        "SELECT id FROM content WHERE site_id = ? AND type = 'page' AND slug = ? AND locale = ? LIMIT 1",
        [siteId, candidate, locale],
      );
      if (!existing[0]) {
        slug = candidate;
        break;
      }
      slug = `${candidate}-${randomUUID().slice(0, 8)}`;
    }

    const id = randomUUID();
    const now = new Date()
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
    await db.run(
      `INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, excerpt, blocks, fields, status, author_id, published_at, created_at, updated_at)
       VALUES (?, ?, 'page', ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
      [
        id,
        siteId,
        "Home",
        slug,
        locale,
        id,
        null,
        JSON.stringify(sanitizeBlockDocument(blocks)),
        JSON.stringify({}),
        session.userId,
        now,
        now,
        now,
      ],
    );

    await setHomePageId(siteId, id);
    const created = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, siteId],
    );
    res.status(201).json({ ok: true, homePageId: id, page: serializeContentRow(created[0]!) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.post("/customize/promote-blog", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const theme = await getActiveTheme(siteId);
    if (!theme) {
      res.status(404).json({ error: "No active theme" });
      return;
    }

    const session = req.session!;
    const blocks = await getEffectiveBlogBlocks(theme.theme_id, true);
    const locale = await getDefaultLocale();
    const db = await getDb();
    const candidates = ["blog", "news", "articles"];
    let slug = "blog";
    for (const candidate of candidates) {
      const existing = await db.query<{ id: string }>(
        "SELECT id FROM content WHERE site_id = ? AND type = 'page' AND slug = ? AND locale = ? LIMIT 1",
        [siteId, candidate, locale],
      );
      if (!existing[0]) {
        slug = candidate;
        break;
      }
      slug = `${candidate}-${randomUUID().slice(0, 8)}`;
    }

    const id = randomUUID();
    const now = new Date()
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
    await db.run(
      `INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, excerpt, blocks, fields, status, author_id, published_at, created_at, updated_at)
       VALUES (?, ?, 'page', ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
      [
        id,
        siteId,
        "Blog",
        slug,
        locale,
        id,
        null,
        JSON.stringify(sanitizeBlockDocument(blocks)),
        JSON.stringify({}),
        session.userId,
        now,
        now,
        now,
      ],
    );

    await setBlogPageId(siteId, id);
    const created = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE id = ? AND site_id = ? LIMIT 1",
      [id, siteId],
    );
    res.status(201).json({ ok: true, blogPageId: id, page: serializeContentRow(created[0]!) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.delete("/customize", requireRole(...THEME_CUSTOMIZE_ROLES), async (_req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const theme = await getActiveTheme(siteId);
    if (!theme) {
      res.status(404).json({ error: "No active theme" });
      return;
    }

    await clearThemeDraft(theme.theme_id);
    await clearThemeHomeDraft(theme.theme_id);
    await clearThemeBlogDraft(theme.theme_id);
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "themes", err);
  }
});

export default router;
