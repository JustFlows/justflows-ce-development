// SPDX-License-Identifier: MIT

/**
 * Additive, persisted Builder 2.0 values that live in a block's `props`:
 * container layout, a named style reference, and per-breakpoint overrides.
 *
 * Each key is new and namespaced so it cannot collide with a block schema's
 * own props (the way the old shared `layout` key once did): `responsive` is
 * already taken by image derivatives, so breakpoint overrides live under
 * `breakpoints`. Every value is bounded and allowlisted; nothing here is ever
 * written to a page as raw CSS. A document without these keys renders exactly
 * as it did before they existed.
 *
 * The schemas are defined and sanitized now so stored data is safe from the
 * first save. The renderer and editor controls that act on them arrive with
 * the responsive (#300), layout (#299), and global style (#301) tickets.
 */

import { ALIGN_SELF, SPACE_STEPS, TEXT_ALIGN, WIDTH_PRESETS, type SpaceStep } from "./block-style.js";
import { GRID_MAX_COLUMNS } from "./layout.js";

export const CONTAINER_DISPLAYS = ["flex", "grid"] as const;
export const CONTAINER_DIRECTIONS = ["row", "column"] as const;
export const CONTAINER_WRAPS = ["wrap", "nowrap"] as const;
export const CONTAINER_JUSTIFY = ["start", "center", "end", "between", "around", "evenly"] as const;
export const CONTAINER_ALIGN = ["start", "center", "end", "stretch", "baseline"] as const;

/** How a container block lays out its children. Every field is optional. */
export interface ContainerLayout {
  display?: (typeof CONTAINER_DISPLAYS)[number];
  direction?: (typeof CONTAINER_DIRECTIONS)[number];
  wrap?: (typeof CONTAINER_WRAPS)[number];
  justify?: (typeof CONTAINER_JUSTIFY)[number];
  align?: (typeof CONTAINER_ALIGN)[number];
  /** Spacing scale step, like block padding. */
  gap?: SpaceStep;
  /** Grid track count when `display` is `grid`. */
  columns?: number;
}

/**
 * The breakpoints a block can override. Desktop is the base value, so it has
 * no entry; tablet inherits from desktop and mobile inherits from tablet. The
 * names and widths match `DEVICE_BUCKETS` in `visibility.ts`.
 */
export const OVERRIDE_BREAKPOINTS = ["tablet", "mobile"] as const;
export type OverrideBreakpoint = (typeof OVERRIDE_BREAKPOINTS)[number];

/** Block style fields that may differ per breakpoint. Colours and effects may not. */
export const BREAKPOINT_STYLE_FIELDS = [
  "padTop",
  "padBottom",
  "padX",
  "marginTop",
  "marginBottom",
  "width",
  "maxWidth",
  "minHeight",
  "alignSelf",
  "textAlign",
] as const;
export type BreakpointStyleField = (typeof BREAKPOINT_STYLE_FIELDS)[number];

/** Container layout fields that may differ per breakpoint. */
export const BREAKPOINT_LAYOUT_FIELDS = ["direction", "wrap", "justify", "align", "gap", "columns"] as const;

/** Grid placement fields that may differ per breakpoint. */
export const BREAKPOINT_PLACEMENT_FIELDS = ["col", "span", "row", "rowSpan"] as const;

/**
 * One breakpoint's overrides. A missing field inherits from the next wider
 * breakpoint; there is no "unset" value, removing the field is the reset.
 */
export interface BreakpointOverride {
  style?: Partial<Record<BreakpointStyleField, string | number>>;
  containerLayout?: Partial<Omit<ContainerLayout, "display">>;
  gridPlacement?: Partial<Record<(typeof BREAKPOINT_PLACEMENT_FIELDS)[number], number>>;
  /** Visual order among siblings. Bounded; the editor warns when it diverges from source order. */
  order?: number;
}

export type BlockBreakpoints = Partial<Record<OverrideBreakpoint, BreakpointOverride>>;

/** A named style preset id, such as `card` or `brand-hero`. */
export const STYLE_REF_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Bounds for an override's visual order. */
const ORDER_MIN = -20;
const ORDER_MAX = 20;

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  return typeof raw === "string" && raw !== "" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : undefined;
}

function boundedInt(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const n = Math.round(raw);
  return n >= min && n <= max ? n : undefined;
}

function compact<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

/** Normalize `props.containerLayout`, or `undefined` when nothing valid is set. */
export function sanitizeContainerLayout(raw: unknown): ContainerLayout | undefined {
  const input = record(raw);
  if (!input) return undefined;
  const out: ContainerLayout = {};
  const display = oneOf(input["display"], CONTAINER_DISPLAYS);
  if (display) out.display = display;
  const direction = oneOf(input["direction"], CONTAINER_DIRECTIONS);
  if (direction) out.direction = direction;
  const wrap = oneOf(input["wrap"], CONTAINER_WRAPS);
  if (wrap) out.wrap = wrap;
  const justify = oneOf(input["justify"], CONTAINER_JUSTIFY);
  if (justify) out.justify = justify;
  const align = oneOf(input["align"], CONTAINER_ALIGN);
  if (align) out.align = align;
  const gap = oneOf(input["gap"], SPACE_STEPS);
  if (gap) out.gap = gap;
  const columns = boundedInt(input["columns"], 1, GRID_MAX_COLUMNS);
  if (columns !== undefined) out.columns = columns;
  return compact(out);
}

/** Normalize `props.styleRef`, or `undefined` when it is not a valid preset id. */
export function sanitizeStyleRef(raw: unknown): string | undefined {
  return typeof raw === "string" && STYLE_REF_RE.test(raw) ? raw : undefined;
}

function sanitizeBreakpointStyle(raw: unknown): BreakpointOverride["style"] {
  const input = record(raw);
  if (!input) return undefined;
  const out: Partial<Record<BreakpointStyleField, string | number>> = {};
  for (const key of ["padTop", "padBottom", "padX", "marginTop", "marginBottom"] as const) {
    const step = oneOf(input[key], SPACE_STEPS);
    if (step) out[key] = step;
  }
  const width = oneOf(input["width"], WIDTH_PRESETS);
  if (width) out.width = width;
  const maxWidth = boundedInt(input["maxWidth"], 1, 10000);
  if (maxWidth !== undefined) out.maxWidth = maxWidth;
  const minHeight = boundedInt(input["minHeight"], 1, 100);
  if (minHeight !== undefined) out.minHeight = minHeight;
  const alignSelf = oneOf(input["alignSelf"], ALIGN_SELF);
  if (alignSelf) out.alignSelf = alignSelf;
  const textAlign = oneOf(input["textAlign"], TEXT_ALIGN);
  if (textAlign) out.textAlign = textAlign;
  return compact(out);
}

function sanitizeBreakpointPlacement(raw: unknown): BreakpointOverride["gridPlacement"] {
  const input = record(raw);
  if (!input) return undefined;
  const out: NonNullable<BreakpointOverride["gridPlacement"]> = {};
  const col = boundedInt(input["col"], 1, GRID_MAX_COLUMNS);
  if (col !== undefined) out.col = col;
  const span = boundedInt(input["span"], 1, GRID_MAX_COLUMNS);
  if (span !== undefined) out.span = span;
  const row = boundedInt(input["row"], 0, 200);
  if (row !== undefined) out.row = row;
  const rowSpan = boundedInt(input["rowSpan"], 1, 20);
  if (rowSpan !== undefined) out.rowSpan = rowSpan;
  return compact(out);
}

function sanitizeBreakpointOverride(raw: unknown): BreakpointOverride | undefined {
  const input = record(raw);
  if (!input) return undefined;
  const out: BreakpointOverride = {};
  const style = sanitizeBreakpointStyle(input["style"]);
  if (style) out.style = style;
  const layout = sanitizeContainerLayout(input["containerLayout"]);
  if (layout) {
    const { display: _display, ...rest } = layout;
    const responsiveLayout = compact(rest);
    if (responsiveLayout) out.containerLayout = responsiveLayout;
  }
  const placement = sanitizeBreakpointPlacement(input["gridPlacement"]);
  if (placement) out.gridPlacement = placement;
  const order = boundedInt(input["order"], ORDER_MIN, ORDER_MAX);
  if (order !== undefined) out.order = order;
  return compact(out);
}

/**
 * Normalize `props.breakpoints`. Unknown breakpoints and fields are dropped;
 * an empty result is `undefined` so documents without overrides stay
 * byte-identical.
 */
export function sanitizeBlockBreakpoints(raw: unknown): BlockBreakpoints | undefined {
  const input = record(raw);
  if (!input) return undefined;
  const out: BlockBreakpoints = {};
  for (const bp of OVERRIDE_BREAKPOINTS) {
    const override = sanitizeBreakpointOverride(input[bp]);
    if (override) out[bp] = override;
  }
  return compact(out);
}

/**
 * Where a computed value can come from, narrowest last. A value set at a later
 * layer wins over every earlier one, and resetting a layer reveals the one
 * beneath without touching any other layer.
 */
export const VALUE_SOURCES = [
  "theme-default",
  "global-token",
  "style-preset",
  "template-default",
  "local",
  "breakpoint-override",
] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];
