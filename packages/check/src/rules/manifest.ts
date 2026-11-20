// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { PackageManifestSchema } from "@justflows/installer";
import { isAcceptedManifestLicense, isClosedLicense, PluginPermissionSchema } from "@justflows/sdk";
import type { ManifestShape, Rule } from "../types.js";
import { finding, manifestArray, permissions } from "./util.js";

const KNOWN_PERMISSIONS = new Set<string>(PluginPermissionSchema.options);

function exists(root: string, relative: string): boolean {
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(path.resolve(root) + path.sep) && fs.existsSync(resolved);
}

/** Files the manifest points at, which must be in the package. */
function declaredFiles(manifest: ManifestShape): Array<{ file: string; what: string }> {
  const files: Array<{ file: string; what: string }> = [];
  const entrypoints = manifest.entrypoints as { server?: string; admin?: string } | undefined;
  if (manifest.type === "plugin") files.push({ file: entrypoints?.server ?? "dist/index.js", what: "server entrypoint" });
  if (typeof manifest.entrypoint === "string") files.push({ file: manifest.entrypoint, what: "theme entrypoint" });
  const assets = manifest.assets as { dir?: string; scripts?: string[]; styles?: string[] } | undefined;
  for (const name of [...(assets?.scripts ?? []), ...(assets?.styles ?? [])]) {
    files.push({ file: `${assets?.dir ?? "public"}/${name}`, what: "asset" });
  }
  const adminApp = manifest.adminApp as { dir?: string; routes?: Array<{ entry?: string }>; locales?: Record<string, string> } | undefined;
  for (const route of adminApp?.routes ?? []) {
    if (route.entry) files.push({ file: `${adminApp?.dir ?? "admin"}/${route.entry}`, what: "admin page" });
  }
  for (const [code, file] of Object.entries(adminApp?.locales ?? {})) files.push({ file: `${adminApp?.dir ?? "admin"}/${file}`, what: `admin ${code} catalog` });
  for (const [id, pattern] of Object.entries((manifest.patterns as Record<string, unknown>) ?? {})) {
    const file = typeof pattern === "string" ? pattern : (pattern as { file?: string })?.file;
    if (typeof file === "string") files.push({ file: file.replace(/^\.\//, ""), what: `pattern ${id}` });
  }
  return files;
}

export const manifestRules: Rule[] = [
  {
    id: "JF-M001",
    title: "The package has a readable justflows.json",
    category: "manifest",
    severity: "error",
    check: (target) => (target.manifest ? [] : [finding(`justflows.json ${target.manifestError ?? "is missing"}`, "justflows.json")]),
  },
  {
    id: "JF-M002",
    title: "The manifest matches what the installer accepts",
    category: "manifest",
    severity: "error",
    check: (target) => {
      if (!target.manifest) return [];
      const parsed = PackageManifestSchema.safeParse(target.manifest);
      if (parsed.success) return [];
      return parsed.error.issues.map((issue) => finding(`${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`, "justflows.json"));
    },
  },
  {
    id: "JF-M003",
    title: "Every declared permission exists",
    category: "manifest",
    severity: "error",
    types: ["plugin"],
    check: (target) =>
      [...permissions(target)].filter((name) => !KNOWN_PERMISSIONS.has(name)).map((name) => finding(`Unknown permission "${name}"`, "justflows.json")),
  },
  {
    id: "JF-M004",
    title: "Manifest features declare the permission they need",
    category: "manifest",
    severity: "error",
    types: ["plugin"],
    check: (target) => {
      const manifest = target.manifest;
      if (!manifest) return [];
      const granted = permissions(target);
      const needs: Array<[boolean, string, string]> = [
        [manifestArray(target, "adminMenu").length > 0, "adminMenu", "admin:extend"],
        [Boolean(manifest.adminApp), "adminApp", "admin:extend"],
        [Boolean(manifest.setupPath), "setupPath", "admin:extend"],
        [manifestArray(target, "contentTypes").length > 0, "contentTypes", "content:delete"],
      ];
      return needs
        .filter(([used, , permission]) => used && !granted.has(permission))
        .map(([, key, permission]) => finding(`"${key}" needs the "${permission}" permission`, "justflows.json"));
    },
  },
  {
    id: "JF-M005",
    title: "No deprecated manifest fields",
    category: "manifest",
    severity: "warning",
    check: (target) =>
      ["justflows", "minJustflowsVersion", "maxJustflowsVersion"]
        .filter((key) => target.manifest && key in target.manifest)
        .map((key) => finding(`"${key}" is deprecated; declare engines.justflows instead`, "justflows.json")),
  },
  {
    id: "JF-M006",
    title: "A GPL-compatible or closed (LicenseRef-) license, with its text",
    category: "manifest",
    severity: "error",
    check: (target) => {
      const out = [];
      const license = typeof target.manifest?.license === "string" ? target.manifest.license : "";
      if (target.manifest && !isAcceptedManifestLicense(license)) {
        out.push(finding(`License "${license || "(none)"}" is not GPL-compatible, and not a closed LicenseRef-<name> license`, "justflows.json"));
      }
      if (!target.files.some((file) => /^(LICENSE|COPYING)(\.(md|txt))?$/i.test(file.path))) out.push(finding("No LICENSE file in the package root"));
      return out;
    },
  },
  {
    id: "JF-M007",
    title: "Every file the manifest declares is in the package",
    category: "manifest",
    severity: "error",
    check: (target) => {
      if (!target.manifest) return [];
      /** In a source folder the build output may not exist yet. */
      const built = (file: string) => target.mode === "source" && /^(dist|build)\//.test(file);
      return declaredFiles(target.manifest)
        .filter(({ file }) => !built(file) && !exists(target.root, file))
        .map(({ file, what }) => finding(`The ${what} ${file} is declared but missing`, "justflows.json"));
    },
  },
  {
    id: "JF-M008",
    title: "package.json agrees with the manifest",
    category: "manifest",
    severity: "warning",
    types: ["plugin"],
    check: (target) => {
      const pkg = target.packageJson;
      const manifest = target.manifest;
      if (!pkg || !manifest) return [];
      const out = [];
      if (pkg.version !== undefined && pkg.version !== manifest.version) out.push(finding(`package.json version "${String(pkg.version)}" differs from the manifest's "${String(manifest.version)}"`, "package.json"));
      if (pkg.type !== "module") out.push(finding('package.json should set "type": "module"', "package.json"));
      return out;
    },
  },
  {
    id: "JF-M009",
    title: "A README describes the package",
    category: "manifest",
    severity: "info",
    check: (target) => (target.files.some((file) => /^readme(\.md)?$/i.test(file.path)) ? [] : [finding("No README.md in the package root")]),
  },
  {
    id: "JF-M010",
    title: "CSS providers ship no scripts",
    category: "manifest",
    severity: "error",
    types: ["css-provider"],
    check: (target) => (manifestArray(target, "scripts").length ? [finding("CSS provider packages may not declare scripts", "justflows.json")] : []),
  },
  {
    id: "JF-M011",
    title: "A closed license installs only from the Marketplace",
    category: "manifest",
    severity: "warning",
    check: (target) => {
      const license = typeof target.manifest?.license === "string" ? target.manifest.license : "";
      return isClosedLicense(license)
        ? [
            finding(
              `License "${license}" is closed: Justflows installs it only with a Marketplace signature, which the registry gives to paid plugins under a contract`,
              "justflows.json",
            ),
          ]
        : [];
    },
  },
  {
    id: "JF-C001",
    title: "engines.justflows covers this Justflows version",
    category: "compatibility",
    severity: "error",
    check: (target) => {
      if (!target.manifest) return [];
      const range = (target.manifest.engines as { justflows?: string } | undefined)?.justflows ?? (typeof target.manifest.justflows === "string" ? target.manifest.justflows : "");
      if (!range) return [{ ...finding("engines.justflows is missing, so the host cannot check compatibility", "justflows.json"), severity: "warning" }];
      if (!semver.validRange(range)) return [finding(`engines.justflows "${range}" is not a valid version range`, "justflows.json")];
      const core = target.coreVersion ? semver.coerce(target.coreVersion)?.version : null;
      if (core && !semver.satisfies(core, range, { includePrerelease: true })) {
        return [finding(`engines.justflows "${range}" does not include Justflows ${core}`, "justflows.json")];
      }
      return [];
    },
  },
  {
    id: "JF-C002",
    title: "The @justflows/sdk dependency matches the current SDK",
    category: "compatibility",
    severity: "warning",
    types: ["plugin"],
    check: (target) => {
      const pkg = target.packageJson;
      const deps = { ...((pkg?.dependencies as Record<string, string>) ?? {}), ...((pkg?.devDependencies as Record<string, string>) ?? {}), ...((pkg?.peerDependencies as Record<string, string>) ?? {}) };
      const range = deps["@justflows/sdk"];
      if (!range || /^(file|link|workspace):/.test(range) || !semver.validRange(range)) return [];
      return semver.satisfies(target.sdkVersion, range, { includePrerelease: true })
        ? []
        : [finding(`@justflows/sdk "${range}" does not include the current SDK ${target.sdkVersion}`, "package.json")];
    },
  },
];
