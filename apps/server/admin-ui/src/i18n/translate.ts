// SPDX-License-Identifier: MIT
import { EMBEDDED_EN } from "./embedded-en";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function interpolate(message: string, vars?: Record<string, string | number>): string {
  if (!vars) return message;
  // Replace once, so values containing another placeholder remain literal data.
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * A catalog entry can be a plural group instead of one string (justflows-ce#307):
 * `{ "one": "{count} block", "other": "{count} blocks" }`, with the forms the
 * language needs (Polish, Russian and Ukrainian also use `few` and `many`).
 * Flattened, they are `key.one`, `key.few`, … and `t(key, { count })` picks
 * the form with the language's plural rules, falling back to `other`.
 */
export const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"] as const;

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralForm(locale: string, count: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules("en");
    }
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/** The message for `key` in one catalog: the string itself, or the plural form `count` needs. */
export function lookupMessage(messages: Record<string, string>, key: string, locale: string, vars?: Record<string, string | number>): string | undefined {
  const direct = messages[key];
  if (direct !== undefined) return direct;
  const count = vars?.count;
  if (typeof count !== "number" && typeof messages[`${key}.other`] !== "string") return undefined;
  const form = typeof count === "number" ? pluralForm(locale, count) : "other";
  return messages[`${key}.${form}`] ?? messages[`${key}.other`];
}

/** English default for pure helpers; UI callers pass their active translator. */
export const translateEnglish: Translate = (key, vars) =>
  interpolate(lookupMessage(EMBEDDED_EN, key, "en", vars) ?? key, vars);
