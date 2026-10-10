// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isValidPluginApiNamespace } from "@justflows/sdk";

describe("core API namespace ownership", () => {
  it("reserves every literal core API prefix against plugin claims", async () => {
    const sources = await Promise.all(["register-routes", "server"].map(name => readFile(new URL(`../../../src/${name}.ts`, import.meta.url), "utf8")));
    const prefixes = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/app\.(?:use|get|post|put|patch|delete)\(\s*["']\/api\/([a-z0-9-]+)/g)) prefixes.add(match[1]!);
    }
    expect(prefixes.size).toBeGreaterThan(30);
    for (const prefix of prefixes) expect(isValidPluginApiNamespace(prefix), `Core owns /api/${prefix}`).toBe(false);
  });
});
