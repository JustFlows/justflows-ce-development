// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";
import {
  exportDepsFor,
  isOnDemandRenderRequest,
  onDemandRenderHeaderValue,
  parseExportDeps,
} from "../../../src/lib/static-export/render-request.js";

const original = process.env.APP_SECRET;
afterEach(() => {
  process.env.APP_SECRET = original;
});

function req(value?: string) {
  return { get: (name: string) => (name === "x-jf-static-export" ? value : undefined) };
}

describe("on-demand render requests", () => {
  it("accepts only the installation's own render token", () => {
    process.env.APP_SECRET = "x".repeat(40);
    expect(isOnDemandRenderRequest(req(onDemandRenderHeaderValue()))).toBe(true);
    /** The plain crawler header, or a guessed value, does not bypass the page cache. */
    expect(isOnDemandRenderRequest(req("1"))).toBe(false);
    expect(isOnDemandRenderRequest(req("on-demand.guess"))).toBe(false);
    expect(isOnDemandRenderRequest(req())).toBe(false);
  });

  it("gives every process with the same APP_SECRET the same token", () => {
    process.env.APP_SECRET = "y".repeat(40);
    const first = onDemandRenderHeaderValue();
    process.env.APP_SECRET = "z".repeat(40);
    expect(onDemandRenderHeaderValue()).not.toBe(first);
    process.env.APP_SECRET = "y".repeat(40);
    expect(onDemandRenderHeaderValue()).toBe(first);
  });
});

describe("export deps", () => {
  it("lists the entry and its translation group", () => {
    expect(exportDepsFor({ id: "abc-1", translationGroupId: "grp-1" })).toBe("c:abc-1,g:grp-1");
    expect(exportDepsFor({ id: "abc-1", translationGroupId: null })).toBe("c:abc-1");
  });

  it("drops anything that is not a dep", () => {
    expect(parseExportDeps("c:abc-1, g:grp-1, x:nope, c:../etc, c:abc-1")).toEqual(["c:abc-1", "g:grp-1"]);
    expect(parseExportDeps(null)).toEqual([]);
  });
});
