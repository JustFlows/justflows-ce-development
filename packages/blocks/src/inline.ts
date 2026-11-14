// SPDX-License-Identifier: MIT

import { sanitizeRichText } from "./sanitize.js";

/**
 * Inline editing contract (justflows-ce#297): which of a block's props an
 * author may edit directly on the canvas, and how. A block opts in per prop;
 * the editor never guesses at editable markup.
 *
 * - `plain`: text only. Line breaks are kept only when `multiline` is set.
 * - `rich`: limited inline HTML, always passed through `sanitizeRichText`.
 *   Reserved for core blocks, whose rich props the document sanitizer knows;
 *   a plugin block declaring `rich` is downgraded to `plain`.
 */
export const INLINE_FIELD_MODES = ["plain", "rich"] as const;
export type InlineFieldMode = (typeof INLINE_FIELD_MODES)[number];

/** Formatting a rich field may offer on its toolbar. */
export const INLINE_FORMATS = ["bold", "italic", "underline", "link", "code", "lists", "more"] as const;
export type InlineFormat = (typeof INLINE_FORMATS)[number];

export interface InlineFieldSpec {
  mode: InlineFieldMode;
  /** Allow line breaks (plain) or paragraphs and lists (rich). Defaults to false for plain, true for rich. */
  multiline?: boolean;
  /** Toolbar formats for a rich field. Omitted means the core default set. */
  formats?: InlineFormat[];
  /** Upper bound on the stored length, in characters. */
  maxLength?: number;
}

export type BlockInlineFields = Record<string, InlineFieldSpec>;

/** Prop names an inline field may target. */
const FIELD_NAME = /^[a-zA-Z][A-Za-z0-9_]{0,40}$/;
const MAX_LENGTH_CAP = 20_000;

/**
 * Normalize a block's declared inline fields. Unknown modes, formats, and
 * field names are dropped. `trusted` is true only for core blocks; anything
 * else may only declare plain fields.
 */
export function resolveInlineFields(raw: unknown, trusted = false): BlockInlineFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: BlockInlineFields = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD_NAME.test(name) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const spec = value as Record<string, unknown>;
    const requested = (INLINE_FIELD_MODES as readonly string[]).includes(spec["mode"] as string)
      ? (spec["mode"] as InlineFieldMode)
      : null;
    if (!requested) continue;
    const mode: InlineFieldMode = requested === "rich" && !trusted ? "plain" : requested;
    const field: InlineFieldSpec = { mode };
    if (typeof spec["multiline"] === "boolean") field.multiline = spec["multiline"];
    if (mode === "rich" && Array.isArray(spec["formats"])) {
      field.formats = spec["formats"].filter((f): f is InlineFormat => (INLINE_FORMATS as readonly string[]).includes(f as string));
    }
    if (typeof spec["maxLength"] === "number" && Number.isInteger(spec["maxLength"]) && spec["maxLength"] > 0) {
      field.maxLength = Math.min(spec["maxLength"], MAX_LENGTH_CAP);
    }
    out[name] = field;
  }
  return out;
}

/**
 * The value an inline edit stores. Plain text loses markup characters' meaning
 * (it is text), collapses line breaks unless multiline, and is trimmed; rich
 * text is sanitized. Both respect `maxLength`.
 */
export function normalizeInlineValue(spec: InlineFieldSpec, raw: string): string {
  const max = spec.maxLength ?? MAX_LENGTH_CAP;
  if (spec.mode === "rich") {
    const clean = sanitizeRichText(raw);
    /** Cutting HTML can split a tag, so a trimmed value is sanitized again. */
    return clean.length <= max ? clean : sanitizeRichText(clean.slice(0, max));
  }
  const text = raw.replace(/\r\n?/g, "\n");
  const shaped = spec.multiline ? text.replace(/\n{3,}/g, "\n\n") : text.replace(/\s*\n\s*/g, " ");
  return shaped.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** The attribute a block's rendered markup uses to mark an inline-editable element. */
export const INLINE_FIELD_ATTRIBUTE = "data-jf-inline";
