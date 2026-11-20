// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  baselineFor,
  checkPackage,
  DEFAULT_RULES,
  exitCode,
  formatText,
  type Report,
  type Rule,
} from "../src/index.js";

const made: string[] = [];

function pkg(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-check-test-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    type: "plugin",
    id: "justflows.acme",
    name: "Acme",
    version: "1.0.0",
    publisher: "Acme",
    license: "GPL-2.0-or-later",
    engines: { justflows: ">=0.4.0 <1.0.0" },
    permissions: [],
    ...extra,
  });

const clean = {
  "justflows.json": manifest(),
  "package.json": JSON.stringify({ name: "justflows.acme", version: "1.0.0", type: "module" }),
  LICENSE: "GPL",
  "README.md": "# Acme",
  "src/index.ts": "export default { activate() {} };\n",
};

const rules = (report: Report) => report.findings.map((finding) => finding.rule);

describe("justflows check", () => {
  it("passes a clean plugin", async () => {
    const report = await checkPackage(pkg(clean), { coreVersion: "0.4.4" });
    expect(report.findings).toEqual([]);
    expect(exitCode(report)).toBe(0);
    expect(report.target).toMatchObject({ type: "plugin", id: "justflows.acme", version: "1.0.0", mode: "source" });
  });

  it("reports manifest problems with the installer's own schema", async () => {
    const report = await checkPackage(
      pkg({ ...clean, "justflows.json": manifest({ id: "Acme", license: "Proprietary", permissions: ["root:everything"], adminMenu: [{ id: "a", label: "A" }] }) }),
      { coreVersion: "0.4.4" },
    );
    expect(rules(report)).toEqual(expect.arrayContaining(["JF-M002", "JF-M003", "JF-M004", "JF-M006"]));
    expect(exitCode(report)).toBe(1);
  });

  it("accepts a closed LicenseRef license with a warning", async () => {
    const report = await checkPackage(
      pkg({ ...clean, "justflows.json": manifest({ license: "LicenseRef-Acme-Commercial" }) }),
      { coreVersion: "0.4.4" },
    );
    expect(rules(report)).toEqual(["JF-M011"]);
    expect(exitCode(report)).toBe(0);
  });

  it("refuses a range that excludes the running Justflows", async () => {
    const report = await checkPackage(pkg({ ...clean, "justflows.json": manifest({ engines: { justflows: ">=0.1.8 <0.2.0" } }) }), { coreVersion: "0.4.4" });
    expect(report.findings.find((item) => item.rule === "JF-C001")?.message).toContain("does not include Justflows 0.4.4");
  });

  it("finds API calls and hooks the manifest has no permission for, and permissions nothing uses", async () => {
    const report = await checkPackage(
      pkg({
        ...clean,
        "justflows.json": manifest({ permissions: ["users:read", "jobs:register"] }),
        "src/index.ts": [
          "export async function activate(ctx) {",
          "  await ctx.mail.send({ to: 'a@b.c' });",
          "  ctx.hooks.action('auth.loggedIn', () => {});",
          "  await ctx.users.find({ email: 'x' });",
          "}",
        ].join("\n"),
      }),
      { coreVersion: "0.4.4" },
    );
    const p001 = report.findings.filter((item) => item.rule === "JF-P001");
    expect(p001.map((item) => [item.message.split(" needs")[0], item.line])).toEqual([
      ["ctx.mail.send", 2],
      ['hook "auth.loggedIn"', 3],
    ]);
    expect(report.findings.find((item) => item.rule === "JF-P002")?.message).toContain('"jobs:register"');
  });

  it("finds dangerous code but ignores comments, tests, and build scripts", async () => {
    const report = await checkPackage(
      pkg({
        ...clean,
        "src/index.ts": [
          "import { exec } from 'node:child_process';",
          "// eval('ignored in a comment')",
          "const run = new Function('return 1');",
          "db.query(`SELECT * FROM t WHERE id = ${id}`);",
          "el.innerHTML = value;",
        ].join("\n"),
        "src/index.test.ts": "eval('test code');",
        "scripts/build.mjs": "import fs from 'node:fs'; eval('tooling');",
      }),
      { coreVersion: "0.4.4" },
    );
    const found = report.findings.map((item) => `${item.rule}@${item.file}:${item.line}`);
    expect(found).toEqual(expect.arrayContaining(["JF-S002@src/index.ts:1", "JF-S001@src/index.ts:3", "JF-S003@src/index.ts:4", "JF-S004@src/index.ts:5"]));
    expect(found.some((item) => item.includes("index.test.ts") || item.includes("scripts/"))).toBe(false);
    expect(found).not.toContain("JF-S001@src/index.ts:2");
  });

  it("finds secrets, inline scripts, and remote code", async () => {
    const report = await checkPackage(
      pkg({
        ...clean,
        ".env": "SECRET=1",
        "src/config.ts": "export const key = 'AKIAABCDEFGHIJKLMNOP';", // scan-secrets:allow (fake key: the checker must find it)
        "admin/index.html": '<button onclick="go()">Go</button><script>alert(1)</script ><script type="application/ld+json">{}</script><script src="https://cdn.example/x.js"></script>',
      }),
      { coreVersion: "0.4.4" },
    );
    const found = report.findings.map((item) => `${item.rule}@${item.file}`);
    expect(found).toEqual(expect.arrayContaining(["JF-S005@.env", "JF-S005@src/config.ts", "JF-S006@admin/index.html", "JF-S007@admin/index.html"]));
    expect(report.findings.filter((item) => item.rule === "JF-S006")).toHaveLength(2);
  });

  it("checks a built .jfpkg with the installer's extractor, including packaging rules", async () => {
    const archive = jfpkg({
      ...clean,
      "dist/index.js": "export default {};",
      "dist/index.js.map": "{}",
      "dist/native.node": "binary",
    });
    const report = await checkPackage(archive, { coreVersion: "0.4.4" });
    expect(report.target.mode).toBe("package");
    expect(rules(report)).toEqual(expect.arrayContaining(["JF-K002", "JF-K003"]));
  });

  it("checks themes: index template, block documents, tokens, focus, and color-scheme flash", async () => {
    const report = await checkPackage(
      pkg({
        "justflows.json": JSON.stringify({ schemaVersion: 1, type: "theme", id: "justflows.theme.acme", name: "Acme", version: "1.0.0", publisher: "Acme", license: "MIT", engines: { justflows: ">=0.4.0" } }),
        LICENSE: "MIT",
        "README.md": "#",
        "templates/single.json": JSON.stringify({ blocks: "nope" }),
        "styles/global.css": ":root { --color-text: #111; }\nbody { color: #222; }\na:focus { outline: none; }\n",
        "scripts/theme.js": "document.documentElement.classList.add('dark');",
      }),
      { coreVersion: "0.4.4" },
    );
    expect(rules(report)).toEqual(expect.arrayContaining(["JF-T001", "JF-T002", "JF-T003", "JF-T004", "JF-T005"]));
    expect(report.findings.find((item) => item.rule === "JF-T003")?.line).toBe(2);
  });

  it("accepts findings listed in the baseline file and gates CI by severity", async () => {
    const dir = pkg({ ...clean, "src/index.ts": "el.innerHTML = value;" });
    const first = await checkPackage(dir, { coreVersion: "0.4.4" });
    expect(exitCode(first)).toBe(0);
    expect(exitCode(first, "warning")).toBe(1);
    fs.writeFileSync(path.join(dir, ".justflows-check.json"), JSON.stringify(baselineFor(first.findings)));
    const second = await checkPackage(dir, { coreVersion: "0.4.4" });
    expect(second.findings).toEqual([]);
    expect(second.suppressed.map((item) => item.rule)).toEqual(["JF-S004"]);
    expect(formatText(second)).toContain("1 accepted by the baseline");
  });

  it("runs extra rules, such as a registry's own checks", async () => {
    const registryRule: Rule = {
      id: "REG-001",
      title: "Listings need a homepage",
      category: "manifest",
      severity: "error",
      check: (target) => (target.manifest?.["homepage"] ? [] : [{ message: "homepage is required for a listing" }]),
    };
    const report = await checkPackage(pkg(clean), { coreVersion: "0.4.4", extraRules: [registryRule] });
    expect(report.findings).toEqual([expect.objectContaining({ rule: "REG-001", severity: "error" })]);
  });

  it("has stable, unique, documented rule ids", () => {
    const ids = DEFAULT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^JF-[A-Z]\d{3}$/);
    const docs = fs.readFileSync(new URL("../../../docs/EXTENSION-CHECKER.md", import.meta.url), "utf8");
    for (const id of ids) expect(docs, `${id} is documented`).toContain(`### ${id}`);
  });
});

/** A minimal gzipped ustar archive, the format .jfpkg uses. */
function jfpkg(files: Record<string, string>): string {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name);
    const octal = (offset: number, length: number, value: number) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, "ascii");
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, data.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
    header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-check-pkg-"));
  made.push(dir);
  const file = path.join(dir, "acme.jfpkg");
  fs.writeFileSync(file, gzipSync(Buffer.concat(blocks)));
  return file;
}

describe("what can be checked", () => {
  it("checks a folder, refuses a missing path and a file that is not a package", async () => {
    const dir = pkg(clean);
    await expect(checkPackage(dir, { coreVersion: "0.4.4" })).resolves.toMatchObject({ target: { mode: "source" } });
    await expect(checkPackage(path.join(dir, "missing"), { coreVersion: "0.4.4" })).rejects.toThrow("does not exist");
    await expect(checkPackage(path.join(dir, "justflows.json"), { coreVersion: "0.4.4" })).rejects.toThrow("package folder or a .jfpkg");
  });
});
