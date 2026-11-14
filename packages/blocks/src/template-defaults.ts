// SPDX-License-Identifier: MIT

import { parseBlockStyle, sanitizeBlockStyleProp } from "./block-style.js";

/**
 * Template defaults (justflows-ce#301): style values a template sets for the
 * content it wraps, by block type. A page rendered through the `page`
 * template whose defaults say `core.heading → textAlign: center` gets
 * centred headings unless a heading sets its own alignment.
 *
 * - Stored on the template document as `templateDefaults`, next to `blocks`.
 * - Applied beneath each block's own `style` at render time, by the public
 *   renderer and the builder canvas alike (`applyTemplateDefaults`), so the
 *   content document itself is never changed.
 * - Only the bounded `BlockStyle` values can be stored; no CSS.
 */

export type TemplateDefaults = Record<string, Record<string, unknown>>;

/** Block type key: a registered type id such as `core.heading` or `acme.card`. */
const TYPE_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/i;
export const TEMPLATE_DEFAULTS_MAX_TYPES = 50;

/** Normalize stored defaults: unknown shapes and empty styles dropped, types sorted. */
export function sanitizeTemplateDefaults(raw: unknown): TemplateDefaults | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: TemplateDefaults = {};
  const types = Object.keys(raw as Record<string, unknown>)
    .filter((type) => TYPE_KEY.test(type) && type.length <= 64)
    .sort()
    .slice(0, TEMPLATE_DEFAULTS_MAX_TYPES);
  for (const type of types) {
    const style = sanitizeBlockStyleProp((raw as Record<string, unknown>)[type]);
    if (style) out[type] = style;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The default style a template gives a block type, or `undefined`. */
export function templateDefaultFor(defaults: TemplateDefaults | undefined, type: string): Record<string, unknown> | undefined {
  return defaults?.[type];
}

/** A block's effective `style` input: the template's default beneath its own values. */
export function styleWithTemplateDefault(
  props: Record<string, unknown>,
  defaults: TemplateDefaults | undefined,
  type: string,
): unknown {
  const base = templateDefaultFor(defaults, type);
  if (!base) return props["style"];
  const own = props["style"];
  const ownObject = own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : null;
  if (!ownObject) return typeof own === "string" ? own : base;
  const merged: Record<string, unknown> = { ...base, ...ownObject };
  /** An explicit empty value on the block does not reset the template's value; absence does not either. Only set values win. */
  for (const [key, value] of Object.entries(ownObject)) {
    if (value === "" || value === 0 || value === null || value === undefined) {
      if (key in base) merged[key] = base[key];
    }
  }
  if (ownObject["vars"] && base["vars"]) {
    merged["vars"] = { ...(base["vars"] as Record<string, string>), ...(ownObject["vars"] as Record<string, string>) };
  }
  return merged;
}

/**
 * The content blocks as the template renders them: each block of a type the
 * template has a default for gets that default beneath its own style. Pure;
 * returns the same array when nothing applies.
 */
export function applyTemplateDefaults<T extends { type: string; props: Record<string, unknown>; children?: T[] }>(
  blocks: T[],
  defaults: TemplateDefaults | undefined,
): T[] {
  if (!defaults || Object.keys(defaults).length === 0) return blocks;
  let changed = false;
  const out = blocks.map((block) => {
    let next = block;
    if (defaults[block.type] && !(typeof block.props["style"] === "string")) {
      next = { ...block, props: { ...block.props, style: styleWithTemplateDefault(block.props, defaults, block.type) } };
      changed = true;
    }
    if (block.children?.length) {
      const children = applyTemplateDefaults(block.children, defaults);
      if (children !== block.children) {
        next = { ...next, children };
        changed = true;
      }
    }
    return next;
  });
  return changed ? out : blocks;
}

/** Whether the template default for `type` sets `field`. */
export function templateDefaultSets(defaults: TemplateDefaults | undefined, type: string, field: string): boolean {
  const base = templateDefaultFor(defaults, type);
  if (!base) return false;
  const value = (parseBlockStyle(base) as unknown as Record<string, unknown>)[field];
  return field === "vars" ? Object.keys((value as Record<string, string>) ?? {}).length > 0 : value !== "" && value !== 0 && value !== undefined;
}
