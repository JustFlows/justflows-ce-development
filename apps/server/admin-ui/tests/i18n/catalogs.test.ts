// SPDX-License-Identifier: MIT
// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-compiler";
import { describe, expect, it } from "vitest";
import literalExceptions from "./literal-exceptions.json";

const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));
const catalogRoot = fileURLToPath(new URL("../../../src/lib/i18n", import.meta.url));
const locales = ["en", "nl", "de", "fr", "es", "pl", "uk", "ru"];

function flatten(object: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(object)) {
    const fullKey = prefix + key;
    if (typeof value === "string") result[fullKey] = value;
    else Object.assign(result, flatten(value as Record<string, unknown>, fullKey + "."));
  }
  return result;
}

const PLURAL_FORMS = new Set(["zero", "one", "two", "few", "many", "other"]);

/** Plural group bases (`builder.blockCount` for `builder.blockCount.one` …) in a flattened catalog. */
function pluralGroups(messages: Record<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(messages)) {
    const dot = key.lastIndexOf(".");
    const form = key.slice(dot + 1);
    if (!PLURAL_FORMS.has(form)) continue;
    const base = key.slice(0, dot);
    groups.set(base, [...(groups.get(base) ?? []), form]);
  }
  for (const [base, forms] of groups) if (!forms.includes("other")) groups.delete(base);
  return groups;
}

/** The plural forms a language uses for whole numbers, plus `other` as the fallback. */
function requiredForms(locale: string): string[] {
  const rules = new Intl.PluralRules(locale);
  const forms = new Set<string>(["other"]);
  for (let n = 0; n <= 200; n++) forms.add(rules.select(n));
  return [...forms].sort();
}

function placeholders(value: string): string[] {
  return [...new Set([...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();
}

function readCatalog(domain: string, locale: string) {
  return flatten(JSON.parse(fs.readFileSync(path.join(catalogRoot, domain, `${locale}.json`), "utf8")));
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

const english = readCatalog("admin-catalogs", "en");
const files = sourceFiles(sourceRoot);
const program = ts.createProgram(files, {
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
  esModuleInterop: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

describe("translation catalogs", () => {
  for (const domain of ["admin-catalogs", "site-catalogs"]) {
    const en = readCatalog(domain, "en");
    for (const locale of locales) {
      it(`${domain}/${locale} has every key and preserves interpolation variables`, () => {
        const messages = readCatalog(domain, locale);
        /**
         * Plural groups are compared as groups: each language has exactly the
         * forms its own plural rules need (justflows-ce#307), and every form
         * keeps the English placeholders, except that a form for one item may
         * leave out `{count}` ("one block").
         */
        const enGroups = pluralGroups(en);
        const groups = pluralGroups(messages);
        const plain = (catalog: Record<string, string>, own: Map<string, string[]>) =>
          Object.keys(catalog).filter((key) => !own.has(key.slice(0, key.lastIndexOf(".")))).sort();
        expect(plain(messages, groups)).toEqual(plain(en, enGroups));
        expect([...groups.keys()].sort()).toEqual([...enGroups.keys()].sort());
        for (const [base, forms] of groups) {
          expect(forms.sort(), `${base} in ${locale}`).toEqual(requiredForms(locale));
          const expected = placeholders(en[`${base}.other`]!);
          for (const form of forms) {
            const value = messages[`${base}.${form}`]!;
            expect(value.trim(), `${base}.${form}`).not.toBe("");
            const own = placeholders(value);
            if (form === "one" || form === "zero") expect(expected, `${base}.${form}`).toEqual(expect.arrayContaining(own));
            else expect(own, `${base}.${form}`).toEqual(expected);
          }
        }
        for (const [key, value] of Object.entries(messages)) {
          if (groups.has(key.slice(0, key.lastIndexOf(".")))) continue;
          expect(value.trim(), key).not.toBe("");
          expect(placeholders(value), key).toEqual(placeholders(en[key]!));
        }
      });
    }
  }

  it("resolves static keys, key constants, and finite dynamic keys used by the admin UI", () => {
    const missing = new Set<string>();
    const namespaces = new Set(Object.keys(english).map((key) => key.split(".")[0]));
    const check = (key: string) => { if (!(key in english) && !(`${key}.other` in english)) missing.add(key); };
    for (const file of files) {
      const source = program.getSourceFile(file)!;
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && node.text.includes(".") && namespaces.has(node.text.split(".")[0])) {
          check(node.text);
        }
        if (ts.isCallExpression(node) && node.expression.getText(source) === "t") {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) check(argument.text);
          if (argument && ts.isTemplateExpression(argument)) {
            let keys = [argument.head.text];
            let finite = true;
            for (const span of argument.templateSpans) {
              const type = checker.getTypeAtLocation(span.expression);
              const types = type.isUnion() ? type.types : [type];
              if (!types.every((item) => item.isStringLiteral())) { finite = false; break; }
              keys = keys.flatMap((key) => types.map((item) => key + (item as ts.StringLiteralType).value + span.literal.text));
            }
            if (finite) keys.forEach(check);
            else expect(Object.keys(english).some((key) => key.startsWith(argument.head.text)), argument.getText(source)).toBe(true);
          }
          const variables = node.arguments[1];
          const message = argument && ts.isStringLiteral(argument) ? english[argument.text] ?? english[`${argument.text}.other`] : undefined;
          if (argument && ts.isStringLiteral(argument) && message && variables && ts.isObjectLiteralExpression(variables)) {
            const names = variables.properties.map((property) => property.name?.getText(source)).filter(Boolean).sort();
            expect(names, argument.text).toEqual(placeholders(message));
            /** A plural group picks its form from `count`, so callers must pass it. */
            if (!english[argument.text]) expect(names, `${argument.text} needs count`).toContain("count");
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect([...missing].sort()).toEqual([]);
  });

  it("keeps human-readable JSX and accessibility labels in catalogs", () => {
    const hardcoded: string[] = [];
    const check = (value: string, file: string) => {
      const text = value.replace(/\s+/g, " ").trim();
      if (/[A-Za-z]/.test(text) && !(text in literalExceptions)) hardcoded.push(`${path.relative(sourceRoot, file)}: ${text}`);
    };
    for (const file of files) {
      const source = program.getSourceFile(file)!;
      const checkExpression = (node: ts.Expression) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node.text, file);
        else if (ts.isConditionalExpression(node)) {
          checkExpression(node.whenTrue);
          checkExpression(node.whenFalse);
        } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
          checkExpression(node.right);
        }
      };
      const visit = (node: ts.Node) => {
        if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) checkExpression(node.expression);
        if (ts.isJsxText(node)) check(node.text, file);
        if (ts.isJsxAttribute(node) && ["title", "placeholder", "aria-label", "alt"].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
          check(node.initializer.text, file);
        }
        if (ts.isJsxAttribute(node) && ["title", "placeholder", "aria-label", "alt"].includes(node.name.getText(source)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          checkExpression(node.initializer.expression);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(hardcoded).toEqual([]);
  });
});
