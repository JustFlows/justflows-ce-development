// SPDX-License-Identifier: MIT

/**
 * Per-block spacing, sizing and alignment.
 *
 * Values are written as declarations on the block's own root element rather
 * than as custom properties behind a stylesheet rule, so only what an editor
 * actually set is emitted and nothing has to override the theme's own padding
 * to get there. Spacing is expressed in scale steps (`var(--space-5)`) so the
 * theme can pull every block in at once on a small screen.
 */

/** Scale steps an editor can pick, mapped to the tokens the theme defines. */
export const SPACE_STEPS = ["", "0", "1", "2", "3", "4", "5", "6", "7", "8"] as const;
export type SpaceStep = (typeof SPACE_STEPS)[number];

export const ALIGN_SELF = ["", "start", "center", "end", "stretch"] as const;
export const TEXT_ALIGN = ["", "left", "center", "right"] as const;
export const WIDTH_PRESETS = ["", "narrow", "content", "wide", "full"] as const;
export const RADIUS_PRESETS = ["", "none", "sm", "md", "lg", "pill"] as const;
export const SHADOW_PRESETS = ["", "none", "sm", "md"] as const;
/** Whether a block grows to fill free space in a row (justflows-ce#299). */
export const GROW_VALUES = ["", "0", "1"] as const;
/** A block's share of a row, in percent of the row, before growing. */
export const BASIS_PRESETS = ["", "auto", "25", "33", "50", "66", "75", "100"] as const;
export const OVERFLOW_VALUES = ["", "hidden", "auto"] as const;

/** Exact fractions, so three thirds or two halves fill a row exactly. */
const BASIS_PERCENT: Record<string, number> = { "25": 25, "33": 100 / 3, "50": 50, "66": 200 / 3, "75": 75, "100": 100 };

const WIDTH_VALUES: Record<string, string> = {
  narrow: "34rem",
  content: "var(--max-width)",
  wide: "var(--max-width-wide)",
  full: "100%",
};

const RADIUS_VALUES: Record<string, string> = {
  none: "0",
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  pill: "999px",
};

const SHADOW_VALUES: Record<string, string> = {
  none: "none",
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
};

export interface BlockStyle {
  padTop: SpaceStep;
  padBottom: SpaceStep;
  padX: SpaceStep;
  marginTop: SpaceStep;
  marginBottom: SpaceStep;
  width: string;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  alignSelf: string;
  textAlign: string;
  radius: string;
  shadow: string;
  /** Per-instance colours. Empty = inherit from the theme. `transparent` / `none` clear it. */
  background: string;
  textColor: string;
  accent: string;
  /** Block opacity as a percent string "0"–"100"; empty = not set (fully opaque). */
  opacity: string;
  /** Flex item: grow into free space ("1") or not ("0"). Only acts inside a row or column layout. */
  grow: string;
  /** Flex item: share of the row; see `BASIS_PRESETS`. */
  basis: string;
  /** Clip (`hidden`) or scroll (`auto`) content that does not fit. */
  overflow: string;
  /**
   * Per-instance overrides of theme CSS custom properties, e.g.
   * `{ "--brand-gradient": "linear-gradient(…)" }`. Set by the block
   * inspector's theme controls; written onto the block's root element so a
   * `var(--brand-gradient)` in the theme resolves to the block's value.
   */
  vars: Record<string, string>;
}

export const DEFAULT_BLOCK_STYLE: BlockStyle = {
  padTop: "",
  padBottom: "",
  padX: "",
  marginTop: "",
  marginBottom: "",
  width: "",
  minHeight: 0,
  maxWidth: 0,
  maxHeight: 0,
  alignSelf: "",
  textAlign: "",
  radius: "",
  shadow: "",
  background: "",
  textColor: "",
  accent: "",
  opacity: "",
  grow: "",
  basis: "",
  overflow: "",
  vars: {},
};

/** A `--custom-property` name. */
const CUSTOM_PROP = /^--[a-zA-Z][\w-]{0,60}$/;

/**
 * A value we are willing to write after `--prop:` in a `style` attribute: a
 * gradient, an `animation` shorthand, a colour, a length. Deliberately narrow —
 * no `;{}<>@`, no comments, no `url(` — so a value cannot close the declaration
 * or open a new rule.
 */
const SAFE_VAR_VALUE = /^[a-zA-Z0-9#%.,()/\s+-]{1,300}$/;

export function safeStyleVarValue(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value) return "";
  if (/[;{}<>@\\]|\/\*|\*\/|url\s*\(/i.test(value)) return "";
  return SAFE_VAR_VALUE.test(value) ? value : "";
}

/** A 0–100 integer percent as a string, or "" when unset/invalid. */
function parseOpacityPct(raw: unknown): string {
  if (raw === "" || raw == null) return "";
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return "";
  return String(Math.min(100, Math.max(0, Math.round(n))));
}

function parseStyleVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!CUSTOM_PROP.test(key)) continue;
    const safe = safeStyleVarValue(value);
    if (safe) out[key] = safe;
  }
  return out;
}

/**
 * A CSS colour we are willing to write into a `style` attribute: hex, a bounded
 * colour function, or a bare keyword. Mirrors the server's `isSafeCssColor`;
 * kept local so `@justflows/blocks` has no server dependency.
 */
const SAFE_COLOR =
  /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([0-9a-zA-Z.,%/\s+-]{1,80}\)|[a-zA-Z]{3,24})$/;

export function safeBlockColor(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (!value || value.length > 100) return "";
  if (/[;{}<>@\\]|\/\*|\*\//.test(value)) return "";
  return SAFE_COLOR.test(value) ? value : "";
}

function pick<T extends string>(raw: unknown, allowed: readonly T[]): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : ("" as T);
}

function clampInt(raw: unknown, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Coerce stored JSON into a style. Anything unrecognised becomes "unset". */
export function parseBlockStyle(raw: unknown): BlockStyle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_BLOCK_STYLE };
  const input = raw as Record<string, unknown>;
  return {
    padTop: pick(input["padTop"], SPACE_STEPS),
    padBottom: pick(input["padBottom"], SPACE_STEPS),
    padX: pick(input["padX"], SPACE_STEPS),
    marginTop: pick(input["marginTop"], SPACE_STEPS),
    marginBottom: pick(input["marginBottom"], SPACE_STEPS),
    width: pick(input["width"], WIDTH_PRESETS),
    minHeight: clampInt(input["minHeight"], 0, 100),
    maxWidth: clampInt(input["maxWidth"], 0, 10000),
    maxHeight: clampInt(input["maxHeight"], 0, 10000),
    alignSelf: pick(input["alignSelf"], ALIGN_SELF),
    textAlign: pick(input["textAlign"], TEXT_ALIGN),
    radius: pick(input["radius"], RADIUS_PRESETS),
    shadow: pick(input["shadow"], SHADOW_PRESETS),
    background: safeBlockColor(input["background"]),
    textColor: safeBlockColor(input["textColor"]),
    accent: safeBlockColor(input["accent"]),
    opacity: parseOpacityPct(input["opacity"]),
    grow: pick(input["grow"], GROW_VALUES),
    basis: pick(input["basis"], BASIS_PRESETS),
    overflow: pick(input["overflow"], OVERFLOW_VALUES),
    vars: parseStyleVars(input["vars"]),
  };
}

export function isDefaultBlockStyle(style: BlockStyle): boolean {
  return (
    !style.padTop &&
    !style.padBottom &&
    !style.padX &&
    !style.marginTop &&
    !style.marginBottom &&
    !style.width &&
    style.minHeight === 0 &&
    style.maxWidth === 0 &&
    style.maxHeight === 0 &&
    !style.alignSelf &&
    !style.textAlign &&
    !style.radius &&
    !style.shadow &&
    !style.background &&
    !style.textColor &&
    !style.accent &&
    !style.opacity &&
    !style.grow &&
    !style.basis &&
    !style.overflow &&
    Object.keys(style.vars).length === 0
  );
}

/** Drop unset values so stored block JSON stays small. */
export function compactBlockStyle(style: BlockStyle): Record<string, unknown> | undefined {
  if (isDefaultBlockStyle(style)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    if (value === "" || value === 0) continue;
    if (key === "vars" && Object.keys(value as object).length === 0) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function sanitizeBlockStyleProp(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  return compactBlockStyle(parseBlockStyle(raw));
}

function space(step: SpaceStep): string {
  return step === "0" ? "0" : `var(--space-${step})`;
}

/**
 * A basis that accounts for the row's gap, so N items of 100/N percent fit on
 * one line: each gives up its share of the gaps between them.
 */
export function flexBasis(basis: string): string {
  if (basis === "auto") return "auto";
  const pct = BASIS_PERCENT[basis];
  if (pct === undefined) return "auto";
  const share = Number((pct / 100).toFixed(4));
  const percent = Number(pct.toFixed(4));
  return share >= 1 ? "100%" : `calc(${percent}% - var(--jf-cl-gap, 0px) * ${Number((1 - share).toFixed(4))})`;
}

/** The declarations for a style, ready to merge into a `style` attribute. */
export function blockStyleDeclarations(style: BlockStyle): string {
  const out: string[] = [];
  if (style.padTop) out.push(`padding-top:${space(style.padTop)}`);
  if (style.padBottom) out.push(`padding-bottom:${space(style.padBottom)}`);
  if (style.padX)
    out.push(`padding-left:${space(style.padX)}`, `padding-right:${space(style.padX)}`);
  if (style.marginTop) out.push(`margin-top:${space(style.marginTop)}`);
  if (style.marginBottom) out.push(`margin-bottom:${space(style.marginBottom)}`);
  if (style.width) {
    out.push(`max-width:${WIDTH_VALUES[style.width] ?? "100%"}`);
    // A width means nothing without saying where the slack goes.
    if (style.width !== "full") out.push("margin-left:auto", "margin-right:auto");
  }
  // Exact limits override the optional theme preset while remaining responsive.
  if (style.maxWidth > 0) {
    out.push(`max-width:min(100%,${style.maxWidth}px)`);
    if (!style.width) out.push("margin-left:auto", "margin-right:auto");
  }
  if (style.maxHeight > 0) out.push(`max-height:${style.maxHeight}px`, "overflow:auto");
  if (style.minHeight > 0) out.push(`min-height:${style.minHeight}vh`);
  if (style.alignSelf) out.push(`justify-self:${style.alignSelf}`, `align-self:${style.alignSelf}`);
  if (style.textAlign) out.push(`text-align:${style.textAlign}`);
  if (style.radius) out.push(`border-radius:${RADIUS_VALUES[style.radius] ?? "0"}`);
  if (style.shadow) out.push(`box-shadow:${SHADOW_VALUES[style.shadow] ?? "none"}`);
  // Colours: the direct property covers the common case (a section/hero box),
  // and the custom property lets a theme opt a specific element in
  // (`var(--jf-block-accent, …)`) without the editor writing CSS.
  if (style.background)
    out.push(`background:${style.background}`, `--jf-block-bg:${style.background}`);
  if (style.textColor) out.push(`color:${style.textColor}`, `--jf-block-text:${style.textColor}`);
  if (style.accent) out.push(`--jf-block-accent:${style.accent}`, `accent-color:${style.accent}`);
  if (style.opacity) out.push(`opacity:${Number(style.opacity) / 100}`);
  /**
   * Flex item values travel as custom properties that only a row or column
   * container reads (see `containerLayoutCss`), so they do nothing elsewhere
   * and phones can drop the basis when a row stacks.
   */
  if (style.grow) out.push(`--jf-grow:${style.grow}`);
  if (style.basis) out.push(`--jf-basis:${flexBasis(style.basis)}`);
  if (style.overflow) out.push(`overflow:${style.overflow}`);
  // Theme-token overrides set from the inspector's theme controls.
  for (const [key, value] of Object.entries(style.vars)) out.push(`${key}:${value}`);
  return out.join(";");
}
