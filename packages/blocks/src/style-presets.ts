// SPDX-License-Identifier: MIT

import { blockStyleDeclarations, parseBlockStyle, sanitizeBlockStyleProp, type BlockStyle } from "./block-style.js";
import { STYLE_REF_RE, sanitizeStyleRef } from "./builder-values.js";
import { resolveResponsiveValue, type BreakpointSource } from "./responsive.js";

/**
 * Named style presets (justflows-ce#301). A preset is a reusable set of the
 * same bounded style values a block can hold locally (`BlockStyle`), stored
 * once per site and referenced from blocks through `props.styleRef`.
 *
 * - Presets render as one class rule each (`.jf-sp-<id>`) in `/theme.css`,
 *   so changing a preset changes every block that uses it, and a block's own
 *   inline values still win because inline styles beat class rules.
 * - The CSS is deterministic: presets sorted by id, declarations in the
 *   `blockStyleDeclarations` order, so the same presets always give the same
 *   bytes.
 * - Only values the style contract already allows can be stored, so a preset
 *   can never carry raw CSS.
 */

export interface StylePreset {
  /** `^[a-z][a-z0-9-]{0,63}$`, the value a block stores in `styleRef`. */
  id: string;
  name: string;
  /** Compact `BlockStyle` values, as `sanitizeBlockStyleProp` returns them. */
  style: Record<string, unknown>;
  updatedAt?: string;
}

export const STYLE_PRESETS_MAX = 100;
export const STYLE_PRESET_NAME_MAX = 80;

export function stylePresetClass(id: string): string {
  return STYLE_REF_RE.test(id) ? `jf-sp-${id}` : "";
}

/** Normalize one stored preset, or `null` when it has no usable id or no values. */
export function sanitizeStylePreset(raw: unknown): StylePreset | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const id = sanitizeStyleRef(input["id"]);
  if (!id) return null;
  const style = sanitizeBlockStyleProp(input["style"]) ?? {};
  const name =
    typeof input["name"] === "string" && input["name"].trim()
      ? input["name"].replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, STYLE_PRESET_NAME_MAX)
      : id;
  const out: StylePreset = { id, name, style };
  if (typeof input["updatedAt"] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(input["updatedAt"])) out.updatedAt = input["updatedAt"];
  return out;
}

/** Normalize a stored list: invalid entries dropped, duplicate ids keep the first, sorted by id, capped. */
export function sanitizeStylePresets(raw: unknown): StylePreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: StylePreset[] = [];
  for (const entry of raw) {
    const preset = sanitizeStylePreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(preset);
    if (out.length >= STYLE_PRESETS_MAX) break;
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The stylesheet for a site's presets, or `""` with none. Part of
 * `/theme.css` after the theme and its tokens (so `var(--space-*)` resolves)
 * and before plugin and custom CSS.
 */
export function stylePresetsCss(presets: readonly StylePreset[]): string {
  const rules: string[] = [];
  for (const preset of sanitizeStylePresets(presets)) {
    const declarations = blockStyleDeclarations(parseBlockStyle(preset.style));
    if (!declarations) continue;
    rules.push(`.${stylePresetClass(preset.id)}{${declarations}}`);
  }
  return rules.join("\n");
}

/** A valid preset id in a block's props, or `""`. */
export function presetRefOf(props: Record<string, unknown> | undefined): string {
  return sanitizeStyleRef(props?.["styleRef"]) ?? "";
}

/**
 * Where a style value comes from, narrowest first. `theme` covers both the
 * theme's stylesheet and the site's token overrides: which of the two needs
 * the token list, which only the editor has (see `ThemeStyleToken.overridden`).
 */
export type StyleValueLayer = "breakpoint-override" | "local" | "template-default" | "style-preset" | "theme";

export interface StyleValueResolution {
  value: unknown;
  layer: StyleValueLayer;
  /** The breakpoint that set a `breakpoint-override` value. */
  breakpoint?: "tablet" | "mobile";
}

const isSet = (v: unknown) => v !== undefined && v !== "" && v !== 0 && v !== null;

/**
 * Resolve one `BlockStyle` field for a block: its breakpoint override at `bp`,
 * else its own value, else the template's default for its type, else the
 * preset's, else whatever the theme gives (`value` undefined, because the
 * theme's value is only known once rendered). The order matches
 * `VALUE_SOURCES` and the renderer: a template default is merged into the
 * block's inline style, so it beats a preset's class rule.
 */
export function resolveStyleValue(
  props: Record<string, unknown>,
  field: keyof BlockStyle,
  preset: StylePreset | null | undefined,
  bp: BreakpointSource = "desktop",
  templateDefault?: Record<string, unknown> | null,
): StyleValueResolution {
  if (bp !== "desktop") {
    const resolved = resolveResponsiveValue(props, bp, "style", field);
    if (resolved.source && resolved.source !== "desktop") {
      return { value: resolved.value, layer: "breakpoint-override", breakpoint: resolved.source };
    }
  }
  const local = (parseBlockStyle(props["style"]) as unknown as Record<string, unknown>)[field];
  if (field === "vars" ? Object.keys((local as Record<string, unknown>) ?? {}).length > 0 : isSet(local)) {
    return { value: local, layer: "local" };
  }
  if (templateDefault) {
    const fromTemplate = (parseBlockStyle(templateDefault) as unknown as Record<string, unknown>)[field];
    if (field === "vars" ? Object.keys((fromTemplate as Record<string, unknown>) ?? {}).length > 0 : isSet(fromTemplate)) {
      return { value: fromTemplate, layer: "template-default" };
    }
  }
  if (preset) {
    const fromPreset = (parseBlockStyle(preset.style) as unknown as Record<string, unknown>)[field];
    if (field === "vars" ? Object.keys((fromPreset as Record<string, unknown>) ?? {}).length > 0 : isSet(fromPreset)) {
      return { value: fromPreset, layer: "style-preset" };
    }
  }
  return { value: undefined, layer: "theme" };
}
