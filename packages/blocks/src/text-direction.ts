// SPDX-License-Identifier: MIT

/**
 * Writing direction of a locale (justflows-ce#307): "rtl" for languages
 * written right to left (Arabic, Hebrew, Persian, Urdu, …), "ltr" otherwise.
 * Used for the public page's `<html dir>` and for the builder canvas, so
 * content in those languages reads, aligns and mirrors as it should.
 *
 * Uses the locale's script where the runtime exposes it, so `ku-Arab` is
 * right to left and `ku-Latn` is not; otherwise a list of right-to-left
 * languages decides.
 */
const RTL_LANGUAGES = new Set(["ar", "arc", "ckb", "dv", "fa", "he", "iw", "khw", "ks", "ps", "sd", "syr", "ug", "ur", "yi", "nqo", "mzn", "glk", "lrc", "azb"]);
const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg", "Mand", "Samr"]);

export type TextDirection = "ltr" | "rtl";

export function textDirection(locale: unknown): TextDirection {
  if (typeof locale !== "string" || !locale.trim()) return "ltr";
  const tag = locale.trim().replace(/_/g, "-");
  try {
    const parsed = new Intl.Locale(tag);
    const script = parsed.script ?? parsed.maximize().script;
    if (script) return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
    return RTL_LANGUAGES.has(parsed.language) ? "rtl" : "ltr";
  } catch {
    return RTL_LANGUAGES.has(tag.split("-")[0]!.toLowerCase()) ? "rtl" : "ltr";
  }
}
