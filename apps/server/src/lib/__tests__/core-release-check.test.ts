import { describe, expect, it } from "vitest";
import {
  compareCoreVersions,
  isAutoUpdateEligible,
  parseCoreVersion,
} from "../core-release-check.js";

const cmp = (a: string, b: string) =>
  compareCoreVersions(parseCoreVersion(a)!, parseCoreVersion(b)!);

describe("parseCoreVersion", () => {
  it("accepts a leading v and a prerelease identifier", () => {
    expect(parseCoreVersion("v0.1.5")).toEqual({ major: 0, minor: 1, patch: 5, prerelease: [] });
    expect(parseCoreVersion("0.2.0-rc.1")).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: ["rc", "1"],
    });
  });

  it("rejects anything that is not X.Y.Z", () => {
    expect(parseCoreVersion("unknown")).toBeNull();
    expect(parseCoreVersion("1.2")).toBeNull();
  });
});

describe("compareCoreVersions", () => {
  it("orders by major, minor, then patch, with prereleases ranked lower", () => {
    expect(cmp("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(cmp("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(cmp("0.1.5", "0.1.5")).toBe(0);
    expect(cmp("0.2.0-rc.1", "0.2.0")).toBeLessThan(0);
  });
});

describe("isAutoUpdateEligible", () => {
  it("allows a higher release inside the same major line", () => {
    expect(isAutoUpdateEligible("0.1.5", "0.1.6")).toBe(true);
    expect(isAutoUpdateEligible("0.1.5", "0.2.0")).toBe(true);
    expect(isAutoUpdateEligible("1.4.0", "1.9.3")).toBe(true);
  });

  it("never crosses a major version", () => {
    expect(isAutoUpdateEligible("0.9.9", "1.0.0")).toBe(false);
    expect(isAutoUpdateEligible("1.2.0", "2.0.0")).toBe(false);
  });

  it("does not act on same or older versions, or on prereleases", () => {
    expect(isAutoUpdateEligible("0.1.5", "0.1.5")).toBe(false);
    expect(isAutoUpdateEligible("0.2.0", "0.1.9")).toBe(false);
    expect(isAutoUpdateEligible("0.1.5", "0.2.0-rc.1")).toBe(false);
    expect(isAutoUpdateEligible("0.1.5", "not-a-version")).toBe(false);
  });
});
