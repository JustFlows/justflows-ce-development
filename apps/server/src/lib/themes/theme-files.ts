import fs from "node:fs";
import path from "node:path";
import { getJfRoot } from "../runtime/jf-root.js";
import { resolvePathUnderBase } from "../security/safe-path.js";
import type { BlockNode } from "../runtime/types.js";
import type { TemplatePartSlot } from "../rendering/template-hierarchy.js";
import {
  BlockPatternSchema,
  ThemePatternRegistrationSchema,
  type BlockPattern,
} from "@justflows/sdk";
import { sanitizeBlockDocument } from "@justflows/blocks";

const THEME_ID_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

export function themesDir(): string {
  return path.join(getJfRoot(), "themes");
}

export function packagesDir(): string {
  const rel = process.env.PACKAGES_DIR ?? "packages-installed";
  return path.isAbsolute(rel) ? rel : path.join(getJfRoot(), rel);
}

function safeThemeId(themeId: string): string | null {
  const id = themeId.trim();
  if (!THEME_ID_RE.test(id) || id.includes("..")) return null;
  return id;
}

/** Map theme id (e.g. justflows.default) to folder slug (default). */
export function themeSlugFromId(themeId: string): string {
  const parts = themeId.split(".");
  return parts[parts.length - 1] ?? themeId;
}

function themeDirUnderKnownRoots(dir: string): string | null {
  const resolved = path.resolve(dir);
  for (const root of [packagesDir(), themesDir()]) {
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const trusted = resolvePathUnderBase(root, rel);
    if (trusted) return trusted;
  }
  return null;
}

function isThemePackageDir(dir: string): boolean {
  const manifest = resolvePathUnderBase(dir, "justflows-theme.json");
  const legacy = resolvePathUnderBase(dir, "justflows.json");
  return Boolean((manifest && fs.existsSync(manifest)) || (legacy && fs.existsSync(legacy)));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function latestInstalledThemeDir(themeId: string): string | null {
  const id = safeThemeId(themeId);
  if (!id) return null;
  const themesRoot = resolvePathUnderBase(packagesDir(), "themes");
  if (!themesRoot) return null;
  const root = resolvePathUnderBase(themesRoot, id);
  if (!root) return null;
  try {
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  if (isThemePackageDir(root)) return root;

  let versions: string[];
  try {
    versions = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersions)
      .reverse();
  } catch {
    return null;
  }

  for (const version of versions) {
    if (!THEME_ID_RE.test(version) || version.includes("..")) continue;
    const dir = resolvePathUnderBase(root, version);
    if (dir && isThemePackageDir(dir)) return dir;
  }
  return null;
}

export function resolveThemeDir(themeId: string, installedPath?: string | null): string | null {
  if (installedPath) {
    const trusted = themeDirUnderKnownRoots(installedPath);
    if (trusted && isThemePackageDir(trusted)) return trusted;
  }

  const installed = latestInstalledThemeDir(themeId);
  if (installed) return installed;

  const id = safeThemeId(themeId);
  if (!id) return null;

  const slug = themeSlugFromId(id);
  if (!THEME_ID_RE.test(slug) || slug.includes("..")) return null;
  const bundled = resolvePathUnderBase(themesDir(), slug);
  if (bundled && isThemePackageDir(bundled)) return bundled;

  if (id === "justflows.default") {
    const fallback = resolvePathUnderBase(themesDir(), "default");
    if (fallback && isThemePackageDir(fallback)) return fallback;
  }

  return null;
}

function readJsonFile<T>(baseDir: string, ...segments: string[]): T | null {
  const filePath = resolvePathUnderBase(baseDir, ...segments);
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Runtime theme fields the installer does not keep. `PackageManifestSchema`
 * strips unknown keys from `justflows.json`, so a Customizer section declared
 * there — or, as documented, in `justflows-theme.json` — never reaches the
 * stored row. These are read back from the package directory.
 */
const THEME_CSS_VAR_NAME = /^--[A-Za-z0-9_-]{1,64}$/;
const THEME_CSS_VAR_UNSAFE = /[;{}<>@\\]|\/\*|\*\//;

export interface ThemePackageRuntime {
  customize?: Record<string, unknown>;
  blockControls?: Record<string, unknown>;
  cssVariables: Record<string, string>;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cssVariablesFromManifest(raw: Record<string, unknown> | null): Record<string, string> {
  const source = plainObject(raw?.cssVariables ?? raw?.css_variables);
  if (!source) return {};
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!THEME_CSS_VAR_NAME.test(key) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 500 || THEME_CSS_VAR_UNSAFE.test(trimmed)) continue;
    vars[key] = trimmed;
  }
  return vars;
}

function runtimeObject(
  themeFile: Record<string, unknown> | null,
  installFile: Record<string, unknown> | null,
  key: "customize" | "blockControls",
): Record<string, unknown> | undefined {
  const fromTheme = plainObject(themeFile?.[key]);
  const fromInstall = plainObject(installFile?.[key]);
  const chosen = fromTheme && Object.keys(fromTheme).length > 0 ? fromTheme : fromInstall;
  return chosen && Object.keys(chosen).length > 0 ? chosen : undefined;
}

/** Read Customizer fields from a theme directory already known to be trusted. */
export function readThemePackageRuntime(dir: string): ThemePackageRuntime | null {
  const trusted = themeDirUnderKnownRoots(dir);
  if (!trusted || !isThemePackageDir(trusted)) return null;
  const themeFile = readJsonFile<Record<string, unknown>>(trusted, "justflows-theme.json");
  const installFile = readJsonFile<Record<string, unknown>>(trusted, "justflows.json");
  const customize = runtimeObject(themeFile, installFile, "customize");
  const blockControls = runtimeObject(themeFile, installFile, "blockControls");
  return {
    ...(customize ? { customize } : {}),
    ...(blockControls ? { blockControls } : {}),
    cssVariables: {
      ...cssVariablesFromManifest(installFile),
      ...cssVariablesFromManifest(themeFile),
    },
  };
}

export interface InstalledThemeRecord {
  themeId: string;
  manifest: Record<string, unknown>;
  cssVariables: Record<string, string>;
}

/**
 * Overlay `customize`, `blockControls`, and `cssVariables` from the installed
 * package onto the row the installer stored. A value already in `cssVariables`
 * wins, so a fork's baked palette is kept. Package files win for the two
 * Customizer maps, because that is where a theme declares them.
 */
export function mergeInstalledThemeRecord(record: InstalledThemeRecord): InstalledThemeRecord {
  const installedPath = record.manifest.installedPath;
  const explicit = typeof installedPath === "string" ? readThemePackageRuntime(installedPath) : null;
  // Older uploads stored the installer manifest without installedPath. The
  // package is still on disk under packages-installed/themes/<id>/<version>.
  const runtime =
    explicit ??
    (() => {
      const dir = latestInstalledThemeDir(record.themeId);
      return dir ? readThemePackageRuntime(dir) : null;
    })();
  if (!runtime) return record;

  const cssVariables = { ...runtime.cssVariables, ...record.cssVariables };
  const manifest: Record<string, unknown> = { ...record.manifest };
  if (runtime.customize) manifest.customize = runtime.customize;
  if (runtime.blockControls) manifest.blockControls = runtime.blockControls;
  if (Object.keys(cssVariables).length > 0) manifest.cssVariables = cssVariables;
  return { ...record, manifest, cssVariables };
}

/** Concatenate theme stylesheets (global.css, components.css, blocks.css). */
export function loadThemeStyles(themeId: string, installedPath?: string | null): string {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return "";

  const stylesDir = resolvePathUnderBase(dir, "styles");
  if (!stylesDir) return "";
  try {
    if (!fs.statSync(stylesDir).isDirectory()) return "";
  } catch {
    return "";
  }

  return ["global.css", "components.css", "blocks.css"]
    .map((name) => resolvePathUnderBase(stylesDir, name))
    .filter((file): file is string => Boolean(file))
    .map((file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

export interface ThemePatternMeta {
  id: string;
  title: string;
  description?: string;
  category?: string;
  /** Block types this pattern uses that come from a plugin rather than core. */
  requiresBlockTypes?: string[];
  version: string;
  source: "theme";
}

export interface ThemePattern extends ThemePatternMeta {
  blocks: BlockNode[];
}

function patternsDir(themeId: string, installedPath?: string | null): string | null {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return null;
  const patterns = resolvePathUnderBase(dir, "patterns");
  if (!patterns) return null;
  try {
    return fs.statSync(patterns).isDirectory() ? patterns : null;
  } catch {
    return null;
  }
}

function patternRegistrations(dir: string): Map<string, string> | null {
  const manifest =
    readJsonFile<Record<string, unknown>>(dir, "justflows-theme.json") ??
    readJsonFile<Record<string, unknown>>(dir, "justflows.json");
  if (!manifest || !("patterns" in manifest)) return null;
  if (
    !manifest.patterns ||
    typeof manifest.patterns !== "object" ||
    Array.isArray(manifest.patterns)
  )
    return new Map();
  const registrations = new Map<string, string>();
  for (const [id, raw] of Object.entries(manifest.patterns as Record<string, unknown>)) {
    const parsed = ThemePatternRegistrationSchema.safeParse(raw);
    if (!parsed.success) continue;
    registrations.set(id, typeof parsed.data === "string" ? parsed.data : parsed.data.path);
  }
  return registrations;
}

function localizedPattern(pattern: BlockPattern, locale?: string): BlockPattern {
  if (!locale || !pattern.locales) return pattern;
  const exact = pattern.locales[locale];
  const base = pattern.locales[locale.split("-")[0] ?? ""];
  const value = exact ?? base;
  return value ? { ...pattern, ...value } : pattern;
}

function readPattern(dir: string, fileName: string, locale?: string): BlockPattern | null {
  const raw = readJsonFile<Record<string, unknown>>(dir, fileName);
  if (!raw) return null;
  const parsed = BlockPatternSchema.safeParse(raw);
  if (!parsed.success) return null;
  const localized = localizedPattern(parsed.data, locale);
  return {
    ...localized,
    blocks: sanitizeBlockDocument({ version: 1, blocks: localized.blocks })
      .blocks as BlockPattern["blocks"],
  };
}

export function listThemePatterns(
  themeId: string,
  installedPath?: string | null,
  locale?: string,
): ThemePatternMeta[] {
  const dir = patternsDir(themeId, installedPath);
  if (!dir) return [];

  const results: ThemePatternMeta[] = [];
  const registrations = patternRegistrations(path.dirname(dir));
  const files = registrations
    ? [...registrations.entries()].map(([id, file]) => [id, path.basename(file)] as const)
    : fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [name.slice(0, -5), name] as const);
  for (const [registeredId, name] of files) {
    const data = readPattern(dir, name, locale);
    if (!data || data.id !== registeredId) continue;
    results.push({
      id: data.id,
      title: data.title ?? data.id,
      description: data.description,
      category: data.category ?? "pages",
      requiresBlockTypes:
        Array.isArray(data.requiresBlockTypes) && data.requiresBlockTypes.length > 0
          ? data.requiresBlockTypes
          : undefined,
      version: data.version,
      source: "theme",
    });
  }
  return results.sort(
    (a, b) =>
      (a.category ?? "sections").localeCompare(b.category ?? "sections") ||
      a.title.localeCompare(b.title),
  );
}

export function loadThemePattern(
  themeId: string,
  patternId: string,
  installedPath?: string | null,
  locale?: string,
): ThemePattern | null {
  const dir = patternsDir(themeId, installedPath);
  if (!dir) return null;

  const safeId = patternId.replace(/[^a-z0-9_-]/gi, "");
  if (!safeId) return null;
  const registrations = patternRegistrations(path.dirname(dir));
  const registeredPath = registrations?.get(safeId);
  if (registrations && !registeredPath) return null;
  const data = readPattern(
    dir,
    registeredPath ? path.basename(registeredPath) : `${safeId}.json`,
    locale,
  );
  if (!data || data.id !== safeId) return null;

  return {
    id: data.id ?? safeId,
    title: data.title ?? safeId,
    description: data.description,
    category: data.category,
    requiresBlockTypes: data.requiresBlockTypes.length > 0 ? data.requiresBlockTypes : undefined,
    version: data.version,
    source: "theme",
    blocks: data.blocks,
  };
}

// --- Template hierarchy (WordPress-style templates + parts) ---------------

const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

function themeSubdir(
  themeId: string,
  subdir: "templates" | "parts" | "widgets",
  installedPath?: string | null,
): string | null {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return null;
  const sub = resolvePathUnderBase(dir, subdir);
  if (!sub) return null;
  try {
    return fs.statSync(sub).isDirectory() ? sub : null;
  } catch {
    return null;
  }
}

function readBlockDocFile(dir: string, name: string): BlockNode[] | null {
  const data = readJsonFile<{ blocks?: BlockNode[] }>(dir, name);
  if (!data?.blocks || !Array.isArray(data.blocks)) return null;
  return data.blocks;
}

/**
 * A theme template body (`templates/<slug>.json`), or `null` when the theme
 * ships no file for that slug. `demo/home.json` and `demo/blog.json` still
 * answer for the `front-page` / `home` slots so v1 themes keep working while
 * they migrate to `templates/`.
 */
export function loadThemeTemplate(
  themeId: string,
  slug: string,
  installedPath?: string | null,
): BlockNode[] | null {
  if (!TEMPLATE_SLUG_RE.test(slug)) return null;
  const dir = themeSubdir(themeId, "templates", installedPath);
  if (dir) {
    const blocks = readBlockDocFile(dir, `${slug}.json`);
    if (blocks) return blocks;
  }
  if (slug === "front-page") return loadThemeDemoHome(themeId, installedPath);
  if (slug === "home") return loadThemeDemoBlog(themeId, installedPath);
  return null;
}

/** The template slugs a theme actually ships a file for (`templates/*.json`). */
export function listThemeTemplateSlugs(themeId: string, installedPath?: string | null): string[] {
  const dir = themeSubdir(themeId, "templates", installedPath);
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((slug) => TEMPLATE_SLUG_RE.test(slug))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Walk an ordered candidate list (from {@link templateCandidates}) and return
 * the first template the theme provides, with the slug that matched.
 */
export function resolveThemeTemplate(
  themeId: string,
  candidates: string[],
  installedPath?: string | null,
): { slug: string; blocks: BlockNode[] } | null {
  for (const slug of candidates) {
    const blocks = loadThemeTemplate(themeId, slug, installedPath);
    if (blocks) return { slug, blocks };
  }
  return null;
}

/**
 * A theme template part (`parts/<slug>.json`), or `null`. `footer` falls back
 * to the legacy `demo/footer.json`; `header` chrome stays config-shaped and is
 * handled by {@link loadThemeDemoHeader}, not here.
 */
export function loadThemeTemplatePart(
  themeId: string,
  slug: TemplatePartSlot,
  installedPath?: string | null,
): BlockNode[] | null {
  const dir = themeSubdir(themeId, "parts", installedPath);
  if (dir) {
    const blocks = readBlockDocFile(dir, `${slug}.json`);
    if (blocks) return blocks;
  }
  if (slug === "footer") return loadThemeDemoFooter(themeId, installedPath);
  return null;
}

/** A widget area the theme declares in `justflows-theme.json` → `widgetAreas`. */
export interface ThemeWidgetArea {
  key: string;
  label: string;
  description?: string;
}

const WIDGET_AREA_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The theme's widget areas, in manifest order:
 * `"widgetAreas": { "sidebar": { "label": "Sidebar", "description": "…" } }`.
 * Default blocks for an area live in `widgets/<key>.json`.
 */
export function loadThemeWidgetAreas(themeId: string, installedPath?: string | null): ThemeWidgetArea[] {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return [];
  const manifest = readJsonFile<Record<string, unknown>>(dir, "justflows-theme.json");
  const raw = plainObject(manifest?.widgetAreas);
  if (!raw) return [];
  const areas: ThemeWidgetArea[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const row = plainObject(value);
    if (!WIDGET_AREA_KEY_RE.test(key) || !row) continue;
    const label = typeof row.label === "string" ? row.label.trim().slice(0, 80) : "";
    if (!label) continue;
    const description =
      typeof row.description === "string" ? row.description.trim().slice(0, 300) : "";
    areas.push(description ? { key, label, description } : { key, label });
  }
  return areas;
}

/** The theme's default blocks for one widget area (`widgets/<key>.json`), or `null`. */
export function loadThemeWidgetDefault(
  themeId: string,
  key: string,
  installedPath?: string | null,
): BlockNode[] | null {
  if (!WIDGET_AREA_KEY_RE.test(key)) return null;
  const dir = themeSubdir(themeId, "widgets", installedPath);
  return dir ? readBlockDocFile(dir, `${key}.json`) : null;
}

export function loadThemeDemoHome(
  themeId: string,
  installedPath?: string | null,
): BlockNode[] | null {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return null;

  const data = readJsonFile<{ blocks?: BlockNode[] }>(dir, "demo", "home.json");
  if (!data?.blocks || !Array.isArray(data.blocks)) return null;
  return data.blocks;
}

export function loadThemeDemoBlog(
  themeId: string,
  installedPath?: string | null,
): BlockNode[] | null {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return null;

  const data = readJsonFile<{ blocks?: BlockNode[] }>(dir, "demo", "blog.json");
  if (!data?.blocks || !Array.isArray(data.blocks)) return null;
  return data.blocks;
}

/** The theme's default site footer blocks (`demo/footer.json`), used when the site never customised one. */
export function loadThemeDemoFooter(
  themeId: string,
  installedPath?: string | null,
): BlockNode[] | null {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return null;

  const data = readJsonFile<{ blocks?: BlockNode[] }>(dir, "demo", "footer.json");
  if (!data?.blocks || !Array.isArray(data.blocks)) return null;
  return data.blocks;
}

/**
 * The theme's default site header chrome (`demo/header.json`) — a sparse
 * {@link PageHeaderConfig} the caller merges over `DEFAULT_PAGE_HEADER`. Used
 * when the site header library has no default entry.
 */
export function loadThemeDemoHeader(
  themeId: string,
  installedPath?: string | null,
): Record<string, unknown> | null {
  const dir = resolveThemeDir(themeId, installedPath);
  if (!dir) return null;

  const data = readJsonFile<Record<string, unknown>>(dir, "demo", "header.json");
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data;
}
