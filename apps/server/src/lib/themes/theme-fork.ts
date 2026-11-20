// SPDX-License-Identifier: MIT

/**
 * "Save as new theme" — materialise the active theme plus this site's
 * customisations (Customizer mods, template overrides, footer, home/blog
 * layouts) into a standalone theme package under the site's own folder,
 * `packages-installed/sites/<siteId>/themes/`. Other sites never see it.
 *
 * The fork is independent: later edits to the original theme, or to the site's
 * overrides, do not touch it, and it can be exported or activated like any
 * installed theme. Not copied: the header library, the active CSS provider, and
 * ordinary content pages.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePathUnderBase } from "../security/safe-path.js";
import { packagesInstalledDir, siteThemesDir } from "../extensions/packages-dir.js";
import { resolveThemeDir } from "./theme-files.js";
import { getActiveTheme, getTheme, insertTheme, themeInstalledPath } from "./themes-db.js";
import {
  defaultModsFromSchema,
  getCustomizeSchema,
  getThemeMods,
  mergeMods,
  modsToCssVariables,
  modsToDarkCssVariables,
} from "./theme-customize.js";
import { getEffectiveHomeBlocks } from "./theme-home-blocks.js";
import { getEffectiveBlogBlocks } from "./theme-blog-blocks.js";
import { getEffectiveTemplatePart } from "../rendering/template-parts.js";
import { getStoredTemplate, listTemplateSlots } from "./theme-templates-store.js";
import { isClosedLicense } from "@justflows/sdk";

/**
 * Thrown when the active theme has a closed license. A copy would be an
 * unsigned, editable package, which a closed license does not allow and the
 * Marketplace signature rule exists to prevent (justflows-ce#281).
 */
export class ClosedThemeCopyError extends Error {
  constructor(themeName: string) {
    super(`"${themeName}" has a closed license, so it cannot be saved as a new theme.`);
    this.name = "ClosedThemeCopyError";
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "theme"
  );
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A theme id / dir not taken by an installed theme, deriving from `base`. */
async function uniqueThemeId(
  siteId: string,
  base: string,
): Promise<{ themeId: string; dir: string }> {
  const root = siteThemesDir(siteId);
  if (!root) throw new Error("The site's theme folder is not writable");
  // Forks saved before per-site folders live in the shared themes folder.
  const legacyRoot = resolvePathUnderBase(packagesInstalledDir(), "themes");
  for (let n = 1; n < 200; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const themeId = `local.${slug}`;
    const dir = resolvePathUnderBase(root, themeId);
    if (!dir) continue;
    if (fs.existsSync(dir)) continue;
    // Keep ids distinct from a legacy shared fork, which the id-based theme
    // folder lookup could otherwise resolve to.
    const legacyDir = legacyRoot ? resolvePathUnderBase(legacyRoot, themeId) : null;
    if (legacyDir && fs.existsSync(legacyDir)) continue;
    if (await getTheme(siteId, themeId)) continue;
    return { themeId, dir };
  }
  throw new Error("Could not allocate a theme id");
}

export interface ForkResult {
  themeId: string;
  name: string;
  dir: string;
}

export async function forkActiveTheme(
  siteId: string,
  rawName: string,
  author = "Custom",
): Promise<ForkResult> {
  const name = rawName.trim().slice(0, 80);
  if (!name) throw new Error("A theme name is required");

  const active = await getActiveTheme(siteId);
  if (!active) throw new Error("No active theme to copy");
  const license = typeof active.manifest?.license === "string" ? active.manifest.license : undefined;
  if (isClosedLicense(license)) throw new ClosedThemeCopyError(active.name);
  const srcDir = resolveThemeDir(active.theme_id, themeInstalledPath(active));
  if (!srcDir) throw new Error("Active theme files not found");

  const { themeId, dir: destDir } = await uniqueThemeId(siteId, slugify(name));

  // 1. Copy the theme's own files (styles, patterns, templates, parts, demo).
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });

  const sub = (...p: string[]): string => {
    const resolved = resolvePathUnderBase(destDir, ...p);
    if (!resolved) throw new Error(`Unsafe path: ${p.join("/")}`);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  };

  // 2. Bake in the site's template overrides.
  const slots = await listTemplateSlots(siteId, active.theme_id, themeInstalledPath(active));
  for (const slot of slots) {
    if (!slot.customised) continue;
    const blocks = await getStoredTemplate(siteId, active.theme_id, slot.slug, false);
    if (blocks?.length) {
      writeJson(sub("templates", `${slot.slug}.json`), { title: slot.slug, blocks });
    }
  }

  // 3. Bake in the current home / blog / footer compositions as theme defaults.
  const [home, blog, footer] = await Promise.all([
    getEffectiveHomeBlocks(active.theme_id, false),
    getEffectiveBlogBlocks(active.theme_id, false),
    getEffectiveTemplatePart(siteId, "footer", false),
  ]);
  if (home.blocks.length) writeJson(sub("demo", "home.json"), { blocks: home.blocks });
  if (blog.blocks.length) writeJson(sub("demo", "blog.json"), { blocks: blog.blocks });
  if (footer.length) writeJson(sub("demo", "footer.json"), { blocks: footer });

  // 4. Bake Customizer colours / fonts / spacing into a stylesheet that loads
  //    after the theme's own so the picked values win, same order as /theme.css.
  const schema = await getCustomizeSchema(siteId);
  const themeVars = (active.css_variables ?? {}) as Record<string, string>;
  const mods = mergeMods(
    defaultModsFromSchema(schema, themeVars),
    (await getThemeMods(active.theme_id, false)) ?? {},
  );
  const light = modsToCssVariables(themeVars, mods, schema);
  const dark = modsToDarkCssVariables(themeVars, mods);
  const decl = (vars: Record<string, string>) =>
    Object.entries(vars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
  const customizerCss =
    `/* Baked from the Theme Customizer when this theme was saved. */\n` +
    `:root {\n${decl(light)}\n}\n` +
    (Object.keys(dark).length
      ? `\n@media (prefers-color-scheme: dark) { html:not([data-theme]) {\n${decl(dark)}\n} }\n` +
        `html[data-theme="dark"] {\n${decl(dark)}\n}\n`
      : "");
  fs.writeFileSync(sub("styles", "customizer.css"), customizerCss);

  // 5. Rewrite the manifest: new identity, declare the template + style files.
  const manifestPath =
    resolvePathUnderBase(destDir, "justflows-theme.json") ??
    (() => {
      throw new Error("manifest path");
    })();
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    manifest = {};
  }

  const templateFiles = fs.existsSync(path.join(destDir, "templates"))
    ? fs
        .readdirSync(path.join(destDir, "templates"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
    : [];
  const styles = Array.isArray(manifest.styles) ? (manifest.styles as string[]).slice() : [];
  if (!styles.includes("styles/customizer.css")) styles.push("styles/customizer.css");

  manifest = {
    ...manifest,
    id: themeId,
    name,
    version: "1.0.0",
    description: `Saved from ${active.name}.`,
    author,
    styles,
    templates: Object.fromEntries(templateFiles.map((slug) => [slug, `./templates/${slug}.json`])),
    ...(fs.existsSync(path.join(destDir, "parts"))
      ? {
          parts: Object.fromEntries(
            fs
              .readdirSync(path.join(destDir, "parts"))
              .filter((f) => f.endsWith(".json"))
              .map((f) => [f.slice(0, -5), `./parts/${f}`]),
          ),
        }
      : {}),
  };
  writeJson(manifestPath, manifest);

  // 6. Register it so it shows up in Admin → Themes immediately.
  await insertTheme(siteId, {
    id: randomUUID(),
    themeId,
    name,
    version: "1.0.0",
    publisher: author,
    description: `Saved from ${active.name}.`,
    cssVariables: light,
    manifest: { ...manifest, installedPath: destDir },
  });

  return { themeId, name, dir: destDir };
}
