// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const entry = path.join(root, "packages/sdk/src/index.ts");
const snapshotPath = path.join(root, "packages/sdk/api-surface.json");
const sdkPackagePath = path.join(root, "packages/sdk/package.json");
const sdkVersionPath = path.join(root, "packages/sdk/src/version.ts");
const configPath = path.join(root, "packages/sdk/tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const source = program.getSourceFile(entry);
if (!source) throw new Error(`SDK entrypoint not found: ${entry}`);
const symbol = program.getTypeChecker().getSymbolAtLocation(source);
if (!symbol) throw new Error("Could not inspect the @justflows/sdk module");

const current = program
  .getTypeChecker()
  .getExportsOfModule(symbol)
  .map((item) => item.getName())
  .filter((name) => name !== "default")
  .sort();

const sdkPackage = JSON.parse(fs.readFileSync(sdkPackagePath, "utf8"));
const versionSource = fs.readFileSync(sdkVersionPath, "utf8");
const declaredSdkVersion = versionSource.match(/SDK_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (declaredSdkVersion !== sdkPackage.version) {
  console.error(
    `SDK_VERSION (${declaredSdkVersion ?? "missing"}) does not match packages/sdk/package.json (${sdkPackage.version}).`,
  );
  process.exit(1);
}

/**
 * Member-level snapshot of the contracts extensions implement
 * (justflows-ce#305): removing a member, or making an optional one required,
 * breaks every extension that relied on it, so both fail here. New optional
 * members are additive and only need `--update`.
 */
const CONTRACT_TYPES = ["PluginBlockDefinition", "PluginBlockField", "BlockPattern"];
const contractsPath = path.join(root, "packages/sdk/api-contracts.json");
const checker = program.getTypeChecker();
const contracts = {};
for (const name of CONTRACT_TYPES) {
  const exported = checker.getExportsOfModule(symbol).find((item) => item.getName() === name);
  if (!exported) continue;
  const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const type = checker.getDeclaredTypeOfSymbol(target);
  contracts[name] = Object.fromEntries(
    checker
      .getPropertiesOfType(type)
      .map((prop) => [prop.getName(), prop.flags & ts.SymbolFlags.Optional ? "optional" : "required"])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

if (process.argv.includes("--update")) {
  fs.writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
  fs.writeFileSync(contractsPath, `${JSON.stringify(contracts, null, 2)}\n`);
  console.log(`Updated SDK API snapshot (${current.length} exports, ${Object.keys(contracts).length} contracts).`);
  process.exit(0);
}

const expectedContracts = fs.existsSync(contractsPath) ? JSON.parse(fs.readFileSync(contractsPath, "utf8")) : {};
const contractProblems = [];
for (const [name, members] of Object.entries(expectedContracts)) {
  const now = contracts[name];
  if (!now) {
    contractProblems.push(`${name} is no longer exported`);
    continue;
  }
  for (const [member, kind] of Object.entries(members)) {
    if (!(member in now)) contractProblems.push(`${name}.${member} was removed`);
    else if (kind === "optional" && now[member] === "required") contractProblems.push(`${name}.${member} became required`);
  }
  for (const member of Object.keys(now)) {
    if (!(member in members)) contractProblems.push(`${name}.${member} is new and not snapshotted`);
  }
}
if (contractProblems.length) {
  console.error(`SDK contract changes:\n  ${contractProblems.join("\n  ")}`);
  console.error("Breaking changes need a new contract version and a deprecation period; additive ones need `pnpm sdk:api:update`.");
  process.exit(1);
}

const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const removed = expected.filter((name) => !current.includes(name));
const added = current.filter((name) => !expected.includes(name));
if (removed.length || added.length) {
  if (removed.length) console.error(`Removed public SDK exports: ${removed.join(", ")}`);
  if (added.length) console.error(`New public SDK exports not snapshotted: ${added.join(", ")}`);
  console.error(
    "Restore/deprecate removals, or run `pnpm sdk:api:update` for an intentional additive change.",
  );
  process.exit(1);
}
console.log(`SDK API snapshot matches (${current.length} exports).`);
