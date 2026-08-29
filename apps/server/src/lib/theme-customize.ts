import { getSiteSetting, setSiteSetting, deleteSiteSetting, getSiteId } from "./site-settings.js";
import { loadThemeStyles } from "./theme-files.js";
import { getActiveTheme, themeInstalledPath } from "./themes-db.js";
import { sanitizeCustomCss } from "./safe-css.js";
import { sanitizeFaviconUrl } from "./favicon.js";
import { blockAnimationCss } from "@justflows/blocks";

export type CustomizeControlType = "color" | "font" | "text" | "image" | "range" | "code" | "select";

export interface CustomizeControl {
  label: string;
  type: CustomizeControlType;
  default: string | number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { label: string; value: string }[];
  description?: string;
}

export interface CustomizeSection {
  label: string;
  controls: Record<string, CustomizeControl>;
}

export const SHADOW_PRESETS = [
  { label: "None", value: "none" },
  { label: "Soft", value: "0 1px 2px rgba(15,23,42,0.06)" },
  { label: "Medium", value: "0 8px 24px rgba(15,23,42,0.08)" },
  { label: "Strong", value: "0 18px 40px rgba(15,23,42,0.16)" },
] as const;

export const WEIGHT_PRESETS = [
  { label: "Regular", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Semibold", value: "600" },
  { label: "Bold", value: "700" },
  { label: "Extrabold", value: "800" },
] as const;

export const FONT_PRESETS = [
  { label: "System UI", value: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif" },
  { label: "Inter", value: '"Inter", system-ui, sans-serif' },
  { label: "Georgia (serif)", value: 'Georgia, "Times New Roman", serif' },
  { label: "Merriweather", value: '"Merriweather", Georgia, serif' },
  { label: "Monospace", value: 'ui-monospace, "Cascadia Code", Consolas, monospace' },
];

/** Built-in customization schema for Justflows default theme. */
export const THEME_CUSTOMIZE_SCHEMA: Record<string, CustomizeSection> = {
  identity: {
    label: "Site Identity",
    controls: {
      siteTitle: { label: "Site title", type: "text", default: "" },
      tagline: { label: "Tagline", type: "text", default: "" },
      logoUrl: { label: "Logo", type: "image", default: "" },
    },
  },
  colors: {
    label: "Colors",
    controls: {
      "--color-primary": { label: "Primary", type: "color", default: "#3b82f6" },
      "--color-primary-hover": { label: "Primary hover", type: "color", default: "#2563eb" },
      "--color-bg": { label: "Background", type: "color", default: "#ffffff" },
      "--color-surface": { label: "Surface", type: "color", default: "#f8fafc" },
      "--color-text": { label: "Text", type: "color", default: "#0f172a" },
      "--color-muted": { label: "Muted text", type: "color", default: "#64748b" },
      "--color-border": { label: "Border", type: "color", default: "#e2e8f0" },
    },
  },
  colorsDark: {
    label: "Colors (dark mode)",
    controls: {
      "--color-primary": { label: "Primary", type: "color", default: "#60a5fa" },
      "--color-primary-hover": { label: "Primary hover", type: "color", default: "#3b82f6" },
      "--color-bg": { label: "Background", type: "color", default: "#0f172a" },
      "--color-surface": { label: "Surface", type: "color", default: "#1e293b" },
      "--color-text": { label: "Text", type: "color", default: "#f8fafc" },
      "--color-muted": { label: "Muted text", type: "color", default: "#94a3b8" },
      "--color-border": { label: "Border", type: "color", default: "#334155" },
    },
  },
  typography: {
    label: "Typography",
    controls: {
      "--font-sans": {
        label: "Body font",
        type: "font",
        default: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        options: FONT_PRESETS,
      },
      "--font-mono": {
        label: "Code font",
        type: "font",
        default: 'ui-monospace, "Cascadia Code", Consolas, monospace',
        options: FONT_PRESETS,
      },
      baseFontSize: { label: "Base font size", type: "range", default: 16, min: 14, max: 20, unit: "px" },
    },
  },
  headings: {
    label: "Headings",
    controls: {
      "--font-heading": {
        label: "Heading font",
        type: "font",
        default: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        options: FONT_PRESETS,
      },
      "--heading-weight": { label: "Weight", type: "select", default: "700", options: [...WEIGHT_PRESETS] },
      "--heading-line": { label: "Line height", type: "range", default: 1.15, min: 0.9, max: 1.8, step: 0.05, unit: "" },
      "--heading-tracking": { label: "Letter spacing", type: "range", default: -0.02, min: -0.06, max: 0.1, step: 0.01, unit: "em" },
      "--h1-size": { label: "H1 size", type: "range", default: 2.6, min: 1.4, max: 5, step: 0.1, unit: "rem" },
      "--h2-size": { label: "H2 size", type: "range", default: 2, min: 1.2, max: 4, step: 0.1, unit: "rem" },
      "--h3-size": { label: "H3 size", type: "range", default: 1.45, min: 1, max: 3, step: 0.05, unit: "rem" },
    },
  },
  spacing: {
    label: "Spacing",
    controls: {
      "--space-unit-base": {
        label: "Spacing scale",
        type: "range",
        default: 8,
        min: 4,
        max: 14,
        unit: "px",
        description: "Every spacing step is a multiple of this. Raise it for an airier site.",
      },
      "--block-gap": { label: "Gap between blocks", type: "range", default: 1.5, min: 0, max: 5, step: 0.25, unit: "rem" },
    },
  },
  radius: {
    label: "Corners",
    controls: {
      "--radius-sm": { label: "Small", type: "range", default: 6, min: 0, max: 24, unit: "px" },
      "--radius-md": { label: "Medium", type: "range", default: 10, min: 0, max: 32, unit: "px" },
      "--radius-lg": { label: "Large", type: "range", default: 16, min: 0, max: 48, unit: "px" },
    },
  },
  shadow: {
    label: "Shadows",
    controls: {
      "--shadow-sm": { label: "Small", type: "select", default: "0 1px 2px rgba(15,23,42,0.06)", options: [...SHADOW_PRESETS] },
      "--shadow-md": { label: "Medium", type: "select", default: "0 8px 24px rgba(15,23,42,0.08)", options: [...SHADOW_PRESETS] },
    },
  },
  layout: {
    label: "Layout",
    controls: {
      contentWidth: { label: "Content width", type: "range", default: 720, min: 560, max: 1200, unit: "px" },
      "--max-width-wide": { label: "Wide width", type: "range", default: 1100, min: 800, max: 1600, unit: "px" },
    },
  },
  navigation: {
    label: "Navigation",
    controls: {
      headerMenu: {
        label: "Header menu",
        type: "select",
        default: "primary",
        options: [{ label: "Primary Menu", value: "primary" }],
      },
      footerMenu: {
        label: "Footer menu",
        type: "select",
        default: "",
        options: [{ label: "None", value: "" }],
      },
    },
  },
  advanced: {
    label: "Additional CSS",
    controls: {
      additionalCss: { label: "Custom CSS", type: "code", default: "" },
    },
  },
};

export interface ThemeMods {
  identity?: Record<string, string>;
  colors?: Record<string, string>;
  colorsDark?: Record<string, string>;
  typography?: Record<string, string | number>;
  headings?: Record<string, string | number>;
  spacing?: Record<string, string | number>;
  radius?: Record<string, string | number>;
  shadow?: Record<string, string>;
  layout?: Record<string, string | number>;
  navigation?: Record<string, string>;
  advanced?: Record<string, string>;
}

export const DEFAULT_THEME_CSS_VARS: Record<string, string> = {
  "--color-primary": "#3b82f6",
  "--color-primary-hover": "#2563eb",
  "--color-bg": "#ffffff",
  "--color-surface": "#f8fafc",
  "--color-text": "#0f172a",
  "--color-muted": "#64748b",
  "--color-border": "#e2e8f0",
  "--font-sans": "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  "--font-mono": 'ui-monospace, "Cascadia Code", Consolas, monospace',
  "--max-width": "720px",
  "--max-width-wide": "1100px",
  "--font-heading": "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  "--heading-weight": "700",
  "--heading-line": "1.15",
  "--heading-tracking": "-0.02em",
  "--h1-size": "2.6rem",
  "--h2-size": "2rem",
  "--h3-size": "1.45rem",
  "--space-unit-base": "8px",
  "--block-gap": "1.5rem",
  "--radius-sm": "6px",
  "--radius-md": "10px",
  "--radius-lg": "16px",
  "--shadow-sm": "0 1px 2px rgba(15,23,42,0.06)",
  "--shadow-md": "0 8px 24px rgba(15,23,42,0.08)",
};

/**
 * Tokens re-declared for dark mode. Only colours: sizes, fonts and widths are
 * scheme-independent and stay inherited from `:root`.
 */
export const DEFAULT_THEME_DARK_CSS_VARS: Record<string, string> = {
  "--color-primary": "#60a5fa",
  "--color-primary-hover": "#3b82f6",
  "--color-bg": "#0f172a",
  "--color-surface": "#1e293b",
  "--color-text": "#f8fafc",
  "--color-muted": "#94a3b8",
  "--color-border": "#334155",
};

function modsKey(themeId: string, draft = false): string {
  return draft ? `theme_mods_draft.${themeId}` : `theme_mods.${themeId}`;
}

// ─── CSS value validation ────────────────────────────────────────────────────
//
// Everything in `colors` and `typography` is interpolated straight into
// theme.css as `${key}: ${value};`. Without a grammar check, an editor can
// close the declaration and write arbitrary rules — which bypasses
// sanitizeCustomCss entirely. Validate rather than escape: CSS has no general
// escaping mechanism that survives in every declaration context.

/** A custom property name: `--` followed by identifier characters only. */
const CSS_CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]{1,64}$/;

/**
 * A colour: hex, or a bounded function call over digits, commas, percent, and
 * whitespace, or a plain CSS-wide / named colour keyword.
 */
const CSS_COLOR =
  /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-zA-Z.,%/\s+-]{1,80}\)|[a-zA-Z]{3,24})$/;

/**
 * A font stack: quoted or bare family names separated by commas. Deliberately
 * narrow — no functions, no url(), no semicolons or braces.
 */
const CSS_FONT_STACK = /^[a-zA-Z0-9 ,._"'-]{1,200}$/;

/** Characters that can end a declaration or open a new rule or comment. */
const CSS_VALUE_FORBIDDEN = /[;{}<>@\\]|\/\*|\*\//;

export function isSafeCssColor(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) return false;
  if (CSS_VALUE_FORBIDDEN.test(trimmed)) return false;
  return CSS_COLOR.test(trimmed);
}

export function isSafeCssFontStack(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (CSS_VALUE_FORBIDDEN.test(trimmed)) return false;
  return CSS_FONT_STACK.test(trimmed);
}

export function isSafeCssVariableName(name: string): boolean {
  return CSS_CUSTOM_PROPERTY.test(name);
}

/**
 * Clamp a range control to a finite number inside the schema's bounds.
 *
 * Strings must be numeric in full. parseFloat would accept a numeric prefix and
 * quietly turn "1; } html { display:none }" into 1 — the injection is dropped
 * either way, but a value the operator never typed should not be stored.
 */
function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else {
    const text = String(raw ?? "").trim();
    n = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : Number.NaN;
  }
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function defaultModsFromSchema(): ThemeMods {
  const mods: ThemeMods = {};
  for (const [sectionKey, section] of Object.entries(THEME_CUSTOMIZE_SCHEMA)) {
    mods[sectionKey as keyof ThemeMods] = {};
    for (const [controlKey, control] of Object.entries(section.controls)) {
      (mods[sectionKey as keyof ThemeMods] as Record<string, unknown>)[controlKey] = control.default;
    }
  }
  return mods;
}

export function mergeMods(base: ThemeMods, patch: ThemeMods): ThemeMods {
  const merged: ThemeMods = {
    identity: { ...base.identity, ...patch.identity },
    colors: { ...base.colors, ...patch.colors },
    colorsDark: { ...base.colorsDark, ...patch.colorsDark },
    typography: { ...base.typography, ...patch.typography },
    headings: { ...base.headings, ...patch.headings },
    spacing: { ...base.spacing, ...patch.spacing },
    radius: { ...base.radius, ...patch.radius },
    shadow: { ...base.shadow, ...patch.shadow },
    layout: { ...base.layout, ...patch.layout },
    navigation: { ...base.navigation, ...patch.navigation },
    advanced: { ...base.advanced, ...patch.advanced },
  };

  if (merged.advanced?.additionalCss !== undefined) {
    merged.advanced.additionalCss = sanitizeCustomCss(merged.advanced.additionalCss);
  }

  return merged;
}

/** Convert user mods into CSS custom properties for :root. */
/** Sections whose values are not `:root` tokens, or are emitted elsewhere. */
const NON_TOKEN_SECTIONS = new Set(["identity", "colorsDark", "navigation", "advanced"]);

/**
 * Validate one control's value for use as a CSS custom property.
 *
 * Both the name and the value reach theme.css verbatim, so both are checked
 * against what the control claims to be. A rejected entry falls back to the
 * default rather than failing the request: one bad value should not take the
 * whole stylesheet down. Returning `null` means "keep the default".
 */
function tokenValue(control: CustomizeControl, raw: unknown): string | null {
  switch (control.type) {
    case "color":
      return typeof raw === "string" && isSafeCssColor(raw) ? raw.trim() : null;
    case "font":
      return typeof raw === "string" && isSafeCssFontStack(raw) ? raw.trim() : null;
    case "range": {
      if (raw == null || raw === "") return null;
      const n = clampNumber(raw, Number(control.default ?? 0), control.min ?? -1e6, control.max ?? 1e6);
      // Trim float noise from a step of 0.05 so the stylesheet stays readable.
      return `${Math.round(n * 1000) / 1000}${control.unit ?? ""}`;
    }
    case "select": {
      // An allowlist, so a preset such as a box-shadow can carry commas and
      // parentheses that no general value grammar would safely admit.
      if (typeof raw !== "string") return null;
      const allowed = control.options?.some((option) => option.value === raw);
      return allowed && !CSS_VALUE_FORBIDDEN.test(raw) ? raw : null;
    }
    default:
      return null;
  }
}

/**
 * Convert user mods into CSS custom properties for `:root`.
 *
 * Driven by the schema rather than by a list of special cases, so a control
 * added above becomes a token without touching this function.
 */
export function modsToCssVariables(
  themeVars: Record<string, string>,
  mods: ThemeMods,
): Record<string, string> {
  const vars = { ...DEFAULT_THEME_CSS_VARS, ...themeVars };

  for (const [sectionKey, section] of Object.entries(THEME_CUSTOMIZE_SCHEMA)) {
    if (NON_TOKEN_SECTIONS.has(sectionKey)) continue;
    const values = (mods[sectionKey as keyof ThemeMods] ?? {}) as Record<string, unknown>;
    for (const [controlKey, control] of Object.entries(section.controls)) {
      if (!isSafeCssVariableName(controlKey)) continue;
      const value = tokenValue(control, values[controlKey]);
      if (value !== null) vars[controlKey] = value;
    }
  }

  // Two controls predate the token naming and are still stored under plain keys.
  const fontSize = THEME_CUSTOMIZE_SCHEMA.typography?.controls.baseFontSize;
  const width = THEME_CUSTOMIZE_SCHEMA.layout?.controls.contentWidth;
  if (mods.typography?.baseFontSize != null) {
    vars["--base-font-size"] = `${clampNumber(
      mods.typography.baseFontSize,
      Number(fontSize?.default ?? 16),
      fontSize?.min ?? 8,
      fontSize?.max ?? 32,
    )}px`;
  }
  if (mods.layout?.contentWidth != null) {
    vars["--max-width"] = `${clampNumber(
      mods.layout.contentWidth,
      Number(width?.default ?? 720),
      width?.min ?? 320,
      width?.max ?? 2400,
    )}px`;
  }

  return vars;
}

/**
 * Convert dark-mode mods into the custom properties re-declared under
 * `prefers-color-scheme: dark` and `html[data-theme="dark"]`.
 *
 * Same validation as the light palette — both the name and the value reach
 * theme.css verbatim, and a rejected entry falls back to the default rather
 * than failing the request.
 */
export function modsToDarkCssVariables(
  themeVars: Record<string, string>,
  mods: ThemeMods,
): Record<string, string> {
  const vars = { ...DEFAULT_THEME_DARK_CSS_VARS, ...themeVars };

  for (const [key, value] of Object.entries(mods.colorsDark ?? {})) {
    if (typeof value !== "string" || !value) continue;
    if (!isSafeCssVariableName(key) || !isSafeCssColor(value)) continue;
    vars[key] = value.trim();
  }

  return vars;
}

/**
 * Last gate before the stylesheet. modsToCssVariables already validates editor
 * input; this also covers css_variables supplied by a theme package, which is
 * looser on purpose (themes legitimately set shadows, gradients and spacing)
 * but still may not close the declaration or open a new rule.
 */
function declarationBlock(vars: Record<string, string>, indent = "  "): string {
  return Object.entries(vars)
    .filter(([k, v]) => isSafeCssVariableName(k) && typeof v === "string" && !CSS_VALUE_FORBIDDEN.test(v))
    .map(([k, v]) => `${indent}${k}: ${v.trim()};`)
    .join("\n");
}

export function buildThemeStylesheet(
  vars: Record<string, string>,
  additionalCss = "",
  darkVars?: Record<string, string>,
): string {
  const baseSize = vars["--base-font-size"] ?? "16px";
  let css = `:root {\n${declarationBlock(vars)}\n}\n\nhtml { font-size: ${baseSize}; }\n`;

  if (darkVars && Object.keys(darkVars).length > 0) {
    // Emitted twice on purpose. site-chrome.js stamps data-theme once it has
    // read the stored preference, but a visitor without JavaScript never gets
    // that attribute — the media query is what serves them the dark palette.
    // The two selectors are mutually exclusive, so neither can shadow the
    // other, and both outrank the `:root` block above on specificity.
    css += `\n@media (prefers-color-scheme: dark) {\n  html:not([data-theme]) {\n    color-scheme: dark;\n${declarationBlock(darkVars, "    ")}\n  }\n}\n`;
    css += `\nhtml[data-theme="dark"] {\n  color-scheme: dark;\n${declarationBlock(darkVars)}\n}\n`;
  }

  if (additionalCss.trim()) {
    css += `\n/* Custom CSS */\n${additionalCss.trim()}\n`;
  }

  return css;
}

export async function getThemeMods(themeId: string, draft = false): Promise<ThemeMods | null> {
  const siteId = await getSiteId();
  if (!siteId) return null;
  return getSiteSetting<ThemeMods>(siteId, modsKey(themeId, draft));
}

export async function saveThemeMods(themeId: string, mods: ThemeMods, draft = false): Promise<void> {
  const siteId = await getSiteId();
  if (!siteId) throw new Error("No site found");
  const storedIcon = await getSiteSetting<string>(siteId, "favicon_url");
  const fromMods = sanitizeFaviconUrl(mods.identity?.faviconUrl);
  if (typeof storedIcon !== "string" && fromMods) {
    await setSiteSetting(siteId, "favicon_url", fromMods);
  }
  await setSiteSetting(siteId, modsKey(themeId, draft), stripStoredSiteIdentity(mods));
}

/** Site title, tagline, and site icon live outside theme mods. Theme mods keep the logo. */
export function stripStoredSiteIdentity(mods: ThemeMods): ThemeMods {
  return {
    ...mods,
    identity: { logoUrl: mods.identity?.logoUrl ?? "" },
  };
}

export async function resolveFaviconUrl(mods?: ThemeMods): Promise<string> {
  const siteId = await getSiteId();
  if (siteId) {
    const stored = await getSiteSetting<string>(siteId, "favicon_url");
    if (typeof stored === "string") return sanitizeFaviconUrl(stored);
    if (!mods) {
      const theme = await getActiveTheme(siteId);
      if (theme) mods = (await getThemeMods(theme.theme_id, false)) ?? undefined;
    }
  }
  return sanitizeFaviconUrl(mods?.identity?.faviconUrl);
}

export async function clearThemeDraft(themeId: string): Promise<void> {
  const siteId = await getSiteId();
  if (!siteId) return;
  await deleteSiteSetting(siteId, modsKey(themeId, true));
}

export async function getEffectiveThemeCss(preview = false): Promise<string> {
  const siteId = await getSiteId();
  const theme = siteId ? await getActiveTheme(siteId) : null;
  const themeId = theme?.theme_id ?? "justflows.default";
  const installedPath = themeInstalledPath(theme);

  if (!siteId) {
    return assembleThemeCss(
      loadThemeStyles(themeId, installedPath),
      buildThemeStylesheet(DEFAULT_THEME_CSS_VARS, "", DEFAULT_THEME_DARK_CSS_VARS),
      "",
    );
  }

  const themeVars = theme?.css_variables ?? {};

  const defaults = defaultModsFromSchema();
  const published = (await getThemeMods(themeId, false)) ?? {};
  const draft = preview ? ((await getThemeMods(themeId, true)) ?? {}) : {};

  const mods = mergeMods(mergeMods(defaults, published), draft);
  const vars = modsToCssVariables(themeVars, mods);
  const darkVars = modsToDarkCssVariables({}, mods);
  const additionalCss = sanitizeCustomCss(mods.advanced?.additionalCss ?? "");
  const pluginCss = await collectPluginCss(siteId, preview);

  return assembleThemeCss(
    loadThemeStyles(themeId, installedPath),
    buildThemeStylesheet(vars, "", darkVars),
    additionalCss,
    pluginCss,
  );
}

/** A plugin bundle can be large, but a single stylesheet running past this is a bug. */
const MAX_PLUGIN_CSS_BYTES = 512 * 1024;

/**
 * Ask activated plugins to contribute CSS through the `theme.css` filter. Their
 * output is baked into `/theme.css`, so a plugin stylesheet rides the same
 * browser cache as the theme and needs no second request. The plugin runtime
 * clears this on activate/deactivate via `revalidateOnUpdate("plugin")`.
 *
 * Plugin CSS is not run through the editor blocklist: a plugin already executes
 * in-process on `activate()`, so a CSS filter is not the boundary that matters,
 * and `html.head` (the comparable plugin hook) injects verbatim too. Failure is
 * non-fatal — a broken filter must not blank the whole site.
 */
async function collectPluginCss(siteId: string, preview: boolean): Promise<string> {
  try {
    const { ensurePluginRuntime, getRuntimeHooks } = await import("./plugin-runtime.js");
    await ensurePluginRuntime();
    const hooks = getRuntimeHooks();
    if (!hooks.has("theme.css")) return "";
    const css = await hooks.applyFilter(
      "theme.css",
      "",
      { siteId, preview },
      { siteId, source: "http" },
    );
    if (typeof css !== "string") return "";
    const trimmed = css.trim();
    if (Buffer.byteLength(trimmed, "utf-8") > MAX_PLUGIN_CSS_BYTES) return "";
    return trimmed;
  } catch {
    return "";
  }
}

/**
 * Order is the contract: everything here is one stylesheet, so a later rule
 * beats an earlier one of equal specificity.
 *
 * 1. Theme styles — the design the theme author shipped.
 * 2. Site tokens — Customizer colours must override the theme's own `:root`.
 * 3. Block animations — platform defaults layered over the theme.
 * 4. Plugin styles — an activated plugin's stylesheet, over the theme so its
 *    components render, under Additional CSS so the site owner keeps the last word.
 * 5. Additional CSS — the editor typed it last, so it wins last.
 */
export function assembleThemeCss(
  themeStyles: string,
  tokens: string,
  additionalCss: string,
  pluginCss = "",
): string {
  const parts = [
    themeStyles ? `/* Theme styles */\n${themeStyles}` : "",
    tokens,
    `/* Block animations */\n${blockAnimationCss()}`,
    pluginCss.trim() ? `/* Plugin styles */\n${pluginCss.trim()}` : "",
    additionalCss.trim() ? `/* Custom CSS */\n${additionalCss.trim()}` : "",
  ];
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

export async function getSiteIdentity(
  mods?: ThemeMods,
  opts?: { preview?: boolean },
): Promise<{
  siteTitle: string;
  tagline: string;
  logoUrl: string;
  faviconUrl: string;
}> {
  const db = await import("./db.js").then((m) => m.getDb());
  const rows = await db.query<{ name: string; description: string | null }>(
    "SELECT name, description FROM sites LIMIT 1",
  );
  const site = rows[0];
  const siteTitle = site?.name?.trim() || "My Site";
  const tagline = site?.description ?? "";
  const logoUrl = mods?.identity?.logoUrl || "";
  const faviconUrl = await resolveFaviconUrl(mods);

  if (opts?.preview) {
    return {
      siteTitle: mods?.identity?.siteTitle?.trim() || siteTitle,
      tagline: mods?.identity?.tagline || tagline,
      logoUrl,
      faviconUrl,
    };
  }

  return { siteTitle, tagline, logoUrl, faviconUrl };
}

/** Resolve menu slug assignments from theme mods (empty string = none). */
export function getNavigationMenuSlugs(mods: ThemeMods): {
  header: string | null;
  footer: string | null;
} {
  const header = mods.navigation?.headerMenu?.trim();
  const footer = mods.navigation?.footerMenu?.trim();
  return {
    header: header ? header : null,
    footer: footer ? footer : null,
  };
}

/** Inject live menu options into the navigation section of the customize schema. */
export async function getCustomizeSchema(siteId: string): Promise<Record<string, CustomizeSection>> {
  const schema = structuredClone(THEME_CUSTOMIZE_SCHEMA);
  const { listMenus } = await import("./menus-db.js");
  const menus = await listMenus(siteId);
  const menuOptions = [
    { label: "— None —", value: "" },
    ...menus.map((menu) => ({ label: `${menu.name} (${menu.slug})`, value: menu.slug })),
  ];

  const navigation = schema.navigation;
  if (navigation) {
    for (const key of ["headerMenu", "footerMenu"] as const) {
      const control = navigation.controls[key];
      if (control) control.options = menuOptions;
    }
  }

  return schema;
}

export async function publishThemeMods(themeId: string, mods: ThemeMods): Promise<void> {
  const siteId = await getSiteId();
  if (!siteId) throw new Error("No site found");
  await saveThemeMods(themeId, stripStoredSiteIdentity(mods), false);
  await clearThemeDraft(themeId);
}
