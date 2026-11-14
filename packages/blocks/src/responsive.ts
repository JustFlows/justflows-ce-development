// SPDX-License-Identifier: MIT

import { blockStyleDeclarations, parseBlockStyle, type BlockStyle } from "./block-style.js";
import {
  OVERRIDE_BREAKPOINTS,
  sanitizeBlockBreakpoints,
  sanitizeContainerLayout,
  type BlockBreakpoints,
  type BreakpointOverride,
  type ContainerLayout,
  type OverrideBreakpoint,
} from "./builder-values.js";
import { DEVICE_MAX_MOBILE, DEVICE_MAX_TABLET } from "./visibility.js";

/**
 * Per-breakpoint overrides (justflows-ce#300): `props.breakpoints` turned
 * into CSS, and the inheritance the editor shows.
 *
 * - Desktop is the block's ordinary props. Tablet applies at or below
 *   `DEVICE_MAX_TABLET` and inherits desktop; mobile applies at or below
 *   `DEVICE_MAX_MOBILE` and inherits tablet.
 * - Output is deterministic: breakpoints, then fields, in a fixed order, so
 *   the same document always produces the same bytes.
 * - Rules carry `!important` because the base values are inline styles on
 *   the element; they are scoped to one block's class and only ever contain
 *   allowlisted values.
 * - A block without overrides gets no rules, so older documents and their
 *   fixed responsive behaviour (grid spans, stacking rows) are unchanged.
 */

/** Version of the `props.breakpoints` shape. Bump with a migration when it changes. */
export const BREAKPOINTS_SCHEMA_VERSION = 1;

/**
 * The stable breakpoint contract: the widest viewport each override applies
 * to, in CSS pixels. Themes and plugins should use the same numbers.
 */
export const BREAKPOINT_MAX_WIDTH: Readonly<Record<OverrideBreakpoint, number>> = {
  tablet: DEVICE_MAX_TABLET,
  mobile: DEVICE_MAX_MOBILE,
};

/** The breakpoint that applies at a given width; `desktop` above tablet. */
export function breakpointForWidth(width: number): OverrideBreakpoint | "desktop" {
  if (width <= DEVICE_MAX_MOBILE) return "mobile";
  if (width <= DEVICE_MAX_TABLET) return "tablet";
  return "desktop";
}

/** Where each override's CSS is written. */
export interface BreakpointTargets {
  /** The block's own element: spacing, size, typography. */
  block: string;
  /** The element holding a container's children; defaults to `block`. */
  layout?: string;
  /** The element that is the item in its parent's layout; defaults to `block`. */
  item?: string;
}

/** Viewport media queries for the public page; named container queries for the builder canvas. */
export type BreakpointQuery = { kind: "media" } | { kind: "container"; name: string };

const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};
const ALIGN: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

const space = (step: string) => (step === "0" ? "0" : `var(--space-${step})`);

/** An override with the narrower one applied over the wider one, as the cascade sees it at that width. */
export function effectiveOverride(breakpoints: BlockBreakpoints | undefined, bp: OverrideBreakpoint): BreakpointOverride {
  const chain = bp === "mobile" ? [breakpoints?.tablet, breakpoints?.mobile] : [breakpoints?.tablet];
  const out: BreakpointOverride = {};
  for (const layer of chain) {
    if (!layer) continue;
    if (layer.style) out.style = { ...out.style, ...layer.style };
    if (layer.containerLayout) out.containerLayout = { ...out.containerLayout, ...layer.containerLayout };
    if (layer.gridPlacement) out.gridPlacement = { ...out.gridPlacement, ...layer.gridPlacement };
    if (layer.order !== undefined) out.order = layer.order;
  }
  return out;
}

function important(declarations: string[]): string {
  return declarations.map((d) => `${d} !important`).join(";");
}

function styleDeclarations(style: BreakpointOverride["style"]): { block: string[]; item: string[] } {
  if (!style) return { block: [], item: [] };
  const { alignSelf, ...rest } = style;
  const block = blockStyleDeclarations(parseBlockStyle(rest as Partial<BlockStyle>)).split(";").filter(Boolean);
  const item = alignSelf ? [`justify-self:${alignSelf}`, `align-self:${alignSelf}`] : [];
  return { block, item };
}

function layoutDeclarations(base: ContainerLayout | undefined, override: BreakpointOverride["containerLayout"]): string[] {
  if (!override || !base?.display) return [];
  const out: string[] = [];
  if (base.display === "flex") {
    if (override.direction) out.push(`flex-direction:${override.direction}`);
    if (override.wrap) out.push(`flex-wrap:${override.wrap}`);
    if (override.justify) out.push(`justify-content:${JUSTIFY[override.justify]}`);
  } else {
    if (override.columns) out.push(`grid-template-columns:repeat(${override.columns},minmax(0,1fr))`, `--jf-cl-cols:${override.columns}`);
    if (override.justify && ["start", "center", "end"].includes(override.justify)) out.push(`justify-items:${override.justify}`);
  }
  if (override.align) out.push(`align-items:${ALIGN[override.align]}`);
  if (override.gap) out.push(`gap:${space(override.gap)}`, `--jf-cl-gap:${space(override.gap)}`);
  return out;
}

function placementDeclarations(placement: BreakpointOverride["gridPlacement"]): string[] {
  if (!placement) return [];
  const out: string[] = [];
  if (placement.col !== undefined || placement.span !== undefined) {
    const col = placement.col ?? "auto";
    const span = placement.span ?? "var(--jf-span, 12)";
    out.push(`grid-column:${col} / span ${span}`);
  }
  if (placement.row !== undefined || placement.rowSpan !== undefined) {
    const row = placement.row && placement.row > 0 ? placement.row : "auto";
    out.push(`grid-row:${row} / span ${placement.rowSpan ?? 1}`);
  }
  return out;
}

function at(query: BreakpointQuery, bp: OverrideBreakpoint): string {
  const condition = `(max-width: ${BREAKPOINT_MAX_WIDTH[bp]}px)`;
  return query.kind === "media" ? `@media ${condition}` : `@container ${query.name} ${condition}`;
}

/**
 * The CSS for one block's breakpoint overrides, or `""` when it has none.
 * `baseLayout` is the block's own `containerLayout`: layout overrides only
 * act on a block that already is a row, column or grid.
 */
export function breakpointCss(
  rawBreakpoints: unknown,
  rawBaseLayout: unknown,
  targets: BreakpointTargets,
  query: BreakpointQuery = { kind: "media" },
): string {
  const breakpoints = sanitizeBlockBreakpoints(rawBreakpoints);
  if (!breakpoints) return "";
  const baseLayout = sanitizeContainerLayout(rawBaseLayout);
  const layoutTarget = targets.layout ?? targets.block;
  const itemTarget = targets.item ?? targets.block;
  const blocks: string[] = [];
  for (const bp of OVERRIDE_BREAKPOINTS) {
    if (!breakpoints[bp]) continue;
    const override = effectiveOverride(breakpoints, bp);
    const style = styleDeclarations(override.style);
    const rules = new Map<string, string[]>();
    const add = (selector: string, declarations: string[]) => {
      if (declarations.length === 0) return;
      rules.set(selector, [...(rules.get(selector) ?? []), ...declarations]);
    };
    add(targets.block, style.block);
    add(layoutTarget, layoutDeclarations(baseLayout, override.containerLayout));
    add(itemTarget, [
      ...style.item,
      ...placementDeclarations(override.gridPlacement),
      ...(override.order !== undefined ? [`order:${override.order}`] : []),
    ]);
    if (rules.size === 0) continue;
    const body = [...rules].map(([selector, declarations]) => `${selector}{${important(declarations)}}`).join("");
    blocks.push(`${at(query, bp)}{${body}}`);
  }
  return blocks.join("\n");
}

export type BreakpointSource = "desktop" | OverrideBreakpoint;

export interface ResolvedValue<T> {
  value: T | undefined;
  /** Where the value comes from: the block's own props, or the breakpoint that set it. */
  source: BreakpointSource | null;
}

type Group = "style" | "containerLayout" | "gridPlacement";

/**
 * What a field resolves to at `bp`, and which breakpoint set it. Desktop
 * values come from the block's props; tablet from its override, else
 * desktop; mobile from its override, else tablet.
 */
export function resolveResponsiveValue<T = unknown>(
  props: Record<string, unknown>,
  bp: BreakpointSource,
  group: Group | "order",
  field?: string,
): ResolvedValue<T> {
  const breakpoints = sanitizeBlockBreakpoints(props["breakpoints"]);
  const chain: OverrideBreakpoint[] = bp === "mobile" ? ["mobile", "tablet"] : bp === "tablet" ? ["tablet"] : [];
  for (const name of chain) {
    const layer = breakpoints?.[name];
    if (!layer) continue;
    if (group === "order") {
      if (layer.order !== undefined) return { value: layer.order as T, source: name };
      continue;
    }
    const value = (layer[group] as Record<string, unknown> | undefined)?.[field!];
    if (value !== undefined) return { value: value as T, source: name };
  }
  if (group === "order") return { value: undefined, source: null };
  const base =
    group === "style"
      ? (parseBlockStyle(props["style"]) as unknown as Record<string, unknown>)[field!]
      : group === "containerLayout"
        ? (sanitizeContainerLayout(props["containerLayout"]) as Record<string, unknown> | undefined)?.[field!]
        : (props["gridPlacement"] as Record<string, unknown> | undefined)?.[field!];
  const set = base !== undefined && base !== "" && base !== 0;
  return { value: set ? (base as T) : undefined, source: set ? "desktop" : null };
}

/**
 * Set or clear one override field. Clearing removes only that field at that
 * breakpoint and prunes empty objects, so the value is inherited again.
 */
export function setBreakpointValue(
  props: Record<string, unknown>,
  bp: OverrideBreakpoint,
  group: Group | "order",
  field: string | undefined,
  value: unknown,
): Record<string, unknown> {
  const current = (sanitizeBlockBreakpoints(props["breakpoints"]) ?? {}) as Record<string, Record<string, unknown>>;
  const layer: Record<string, unknown> = { ...(current[bp] ?? {}) };
  const clear = value === undefined || value === null || value === "";
  if (group === "order") {
    if (clear) delete layer["order"];
    else layer["order"] = value;
  } else {
    const groupValue: Record<string, unknown> = { ...((layer[group] as Record<string, unknown>) ?? {}) };
    if (clear) delete groupValue[field!];
    else groupValue[field!] = value;
    if (Object.keys(groupValue).length) layer[group] = groupValue;
    else delete layer[group];
  }
  const next: Record<string, unknown> = { ...current };
  if (Object.keys(layer).length) next[bp] = layer;
  else delete next[bp];
  const clean = sanitizeBlockBreakpoints(next);
  const out = { ...props };
  if (clean) out["breakpoints"] = clean;
  else delete out["breakpoints"];
  return out;
}
