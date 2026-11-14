#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Builder 2.0 rollback drill (justflows-ce#310).
 *
 * Answers: if a site upgrades, edits pages with Builder 2.0, and then goes
 * back to the previous version, does the old code still open and render
 * what was saved? It takes `@justflows/blocks` and `@justflows/sdk` from the
 * version before Builder 2.0 straight from git, bundles them, and runs their
 * document cleaner and renderer on documents that use every Builder 2.0
 * feature. It then reports, per document, whether the old code kept every
 * block id and every piece of text, and which new features it ignores.
 *
 *   node scripts/builder-rollback-drill.mjs [baseline-ref]
 *
 * The baseline defaults to the commit before the first Builder 2.0 change
 * (justflows-ce#293). Needs the git history, so it is a release drill, not a
 * CI step on a shallow checkout. Exits 1 if any block or text is lost.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const baseline =
  process.argv[2] ??
  `${git("log", "--reverse", "--format=%H", "--grep=justflows-ce#293").split("\n")[0]}^`;
const baselineSha = git("rev-parse", "--short", baseline);

const work = mkdtempSync(path.join(tmpdir(), "jf-rollback-"));
try {
  /** The previous version's packages, exactly as committed. */
  execFileSync("sh", ["-c", `git archive ${baselineSha} packages/blocks/src packages/sdk/src | tar -x -C "${work}"`], { cwd: root });
  /** Written inside the blocks package so its third-party imports resolve from there; removed afterwards. */
  const bundleDir = path.join(root, "packages/blocks/.rollback-drill");
  const bundle = path.join(bundleDir, "old-blocks.mjs");
  const esbuild = createRequire(path.join(root, "package.json"))("esbuild");
  await esbuild.build({
    entryPoints: [path.join(work, "packages/blocks/src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundle,
    logLevel: "error",
    alias: { "@justflows/sdk": path.join(work, "packages/sdk/src/index.ts") },
    /** Third-party code is the same in both versions; it is loaded from this checkout. */
    packages: "external",
  });
  const old = await import(pathToFileURL(bundle).href);
  const current = await import(pathToFileURL(path.join(root, "packages/blocks/dist/index.js")).href);

  /** Documents as Builder 2.0 saves them, one per feature group. */
  const documents = {
    "layout, responsive values, presets": {
      version: 1,
      blocks: [
        {
          id: "s1", type: "core.section", version: 1,
          props: { containerLayout: { display: "grid", columns: 3, gap: "4" }, breakpoints: { mobile: { containerLayout: { columns: 1 }, style: { padTop: "2" } } }, styleRef: "card", style: { padTop: "6", fontSize: "lg" } },
          children: [
            { id: "h1", type: "core.heading", version: 1, props: { level: 2, text: "Plans", style: { grow: 1, basis: "1/2" } } },
            { id: "p1", type: "core.paragraph", version: 1, props: { text: "Pick a <strong>plan</strong>." } },
          ],
        },
      ],
    },
    "editor labels and locks": {
      version: 1,
      blocks: [
        { id: "b1", type: "core.button", version: 1, props: { label: "Start", url: "/start" }, editor: { label: "Main call to action", lock: { remove: true, move: true } } },
      ],
    },
    "inline media fields": {
      version: 1,
      blocks: [
        { id: "i1", type: "core.image", version: 1, props: { src: "/uploads/a.jpg", alt: "A dog", caption: "Our dog" } },
        { id: "c1", type: "core.cover", version: 1, props: { mediaType: "image", src: "/uploads/b.jpg", alt: "", overlayOpacity: 30 }, children: [{ id: "cp", type: "core.paragraph", version: 1, props: { text: "On the cover" } }] },
      ],
    },
    "reusable reference and plugin block": {
      version: 1,
      blocks: [
        { id: "r1", type: "core.reusable", version: 1, props: { ref: "promo" } },
        { id: "x1", type: "acme.card", version: 2, props: { title: "Plugin card" } },
      ],
    },
  };

  const textOf = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const idsOf = (blocks, out = []) => {
    for (const b of blocks) {
      out.push(b.id);
      if (Array.isArray(b.children)) idsOf(b.children, out);
    }
    return out;
  };

  const oldRegistry = old.createBlockRegistrySync();
  const newRegistry = current.createBlockRegistrySync();
  const report = [];
  let lost = false;
  for (const [name, doc] of Object.entries(documents)) {
    const row = { name, ids: "kept", text: "kept", ignored: [] };
    let oldClean;
    try {
      oldClean = old.sanitizeBlockDocument(JSON.parse(JSON.stringify(doc)));
    } catch (error) {
      row.ids = `old cleaner failed: ${error.message}`;
      lost = true;
      report.push(row);
      continue;
    }
    const missingIds = idsOf(doc.blocks).filter((id) => !idsOf(oldClean.blocks).includes(id));
    if (missingIds.length) {
      row.ids = `lost ${missingIds.join(", ")}`;
      lost = true;
    }
    let oldHtml = "";
    try {
      oldHtml = oldRegistry.renderDocument(oldClean);
    } catch (error) {
      row.text = `old renderer failed: ${error.message}`;
      lost = true;
    }
    const newText = textOf(newRegistry.renderDocument(current.sanitizeBlockDocument(JSON.parse(JSON.stringify(doc)))));
    const oldText = textOf(oldHtml);
    const missingWords = newText.split(" ").filter((word) => word && !oldText.includes(word));
    if (missingWords.length) {
      row.text = `missing: ${[...new Set(missingWords)].slice(0, 8).join(" ")}`;
      lost = true;
    }
    const flat = JSON.stringify(oldClean);
    if (!flat.includes('"editor"') && JSON.stringify(doc).includes('"editor"')) row.ignored.push("editor labels and locks are dropped on the next save");
    if (!oldHtml.includes("jf-cl") && JSON.stringify(doc).includes("containerLayout")) row.ignored.push("container layouts render as a stack");
    if (!oldHtml.includes("@media") && JSON.stringify(doc).includes("breakpoints")) row.ignored.push("tablet and mobile overrides are ignored");
    if (!oldHtml.includes("jf-sp-") && JSON.stringify(doc).includes("styleRef")) row.ignored.push("style presets are ignored");
    report.push(row);
  }

  const lines = [
    `Builder 2.0 rollback drill — previous version ${baselineSha}, current ${git("rev-parse", "--short", "HEAD")}`,
    "",
    "| Documents | Block ids | Text | Ignored by the previous version |",
    "| --- | --- | --- | --- |",
    ...report.map((r) => `| ${r.name} | ${r.ids} | ${r.text} | ${r.ignored.join("; ") || "nothing"} |`),
  ];
  console.log(lines.join("\n"));
  if (process.env.ROLLBACK_REPORT) writeFileSync(process.env.ROLLBACK_REPORT, `${lines.join("\n")}\n`);
  process.exitCode = lost ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(path.join(root, "packages/blocks/.rollback-drill"), { recursive: true, force: true });
}
