// SPDX-License-Identifier: MIT

/**
 * The class a code block's language becomes, for syntax-highlighting themes:
 * `language-<name>` for one well-formed name, "" otherwise. Shared by the
 * public renderer and the builder canvas (justflows-ce#306), so a language
 * like "C sharp" can no longer split into two stray classes.
 */
export function codeLanguageClass(language: unknown): string {
  if (typeof language !== "string") return "";
  const name = language.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9+#._-]{0,31}$/.test(name) ? `language-${name}` : "";
}
