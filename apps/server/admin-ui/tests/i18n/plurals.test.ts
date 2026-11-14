// SPDX-License-Identifier: MIT
// @vitest-environment node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpolate, lookupMessage, translateEnglish } from "../../src/i18n/translate";

/** Plural forms in the admin catalogs (justflows-ce#307). */

function catalog(locale: string): Record<string, string> {
  const file = fileURLToPath(new URL(`../../../src/lib/i18n/admin-catalogs/${locale}.json`, import.meta.url));
  const flat: Record<string, string> = {};
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") flat[prefix + key] = value;
      else walk(value as Record<string, unknown>, `${prefix}${key}.`);
    }
  };
  walk(JSON.parse(fs.readFileSync(file, "utf8")), "");
  return flat;
}

const say = (locale: string, key: string, count: number) => interpolate(lookupMessage(catalog(locale), key, locale, { count })!, { count });

describe("plural forms", () => {
  it("pick the form the language needs", () => {
    expect(say("en", "builder.blockCount", 1)).toBe("1 block");
    expect(say("en", "builder.blockCount", 0)).toBe("0 blocks");
    expect(say("pl", "builder.blockCount", 1)).toBe("1 blok");
    expect(say("pl", "builder.blockCount", 2)).toBe("2 bloki");
    expect(say("pl", "builder.blockCount", 5)).toBe("5 bloków");
    expect(say("pl", "builder.blockCount", 22)).toBe("22 bloki");
    expect(say("pl", "builder.blockCount", 25)).toBe("25 bloków");
    expect(say("ru", "builder.blockCount", 21)).toBe("21 блок");
    expect(say("uk", "builder.blockCount", 3)).toBe("3 блоки");
    expect(say("fr", "builder.blockCount", 0)).toBe("0 bloc");
  });

  it("fall back to `other`, then to English, and never break plain messages", () => {
    expect(lookupMessage({ "x.other": "{count} things" }, "x", "pl", { count: 1 })).toBe("{count} things");
    expect(lookupMessage({}, "builder.blockCount", "nl", { count: 1 })).toBeUndefined();
    expect(translateEnglish("builder.blockCount", { count: 1 })).toBe("1 block");
    expect(translateEnglish("builder.blockCount", { count: 7 })).toBe("7 blocks");
    expect(lookupMessage({ plain: "Hello" }, "plain", "pl", { count: 2 })).toBe("Hello");
  });
});
