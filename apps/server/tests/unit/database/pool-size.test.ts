// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { controlPoolMax, SECONDARY_POOL_MAX } from "../../../src/lib/database/db.js";

describe("database pool size", () => {
  it("defaults the installation database to 10 connections", () => {
    expect(controlPoolMax({})).toBe(10);
    expect(controlPoolMax({ DATABASE_POOL_MAX: "" })).toBe(10);
  });

  it("reads DATABASE_POOL_MAX within 1 to 100", () => {
    expect(controlPoolMax({ DATABASE_POOL_MAX: "25" })).toBe(25);
    expect(controlPoolMax({ DATABASE_POOL_MAX: " 1 " })).toBe(1);
    expect(controlPoolMax({ DATABASE_POOL_MAX: "500" })).toBe(100);
  });

  it("falls back to 10 for values that are not a positive whole number", () => {
    for (const value of ["0", "-3", "2.5", "many"]) expect(controlPoolMax({ DATABASE_POOL_MAX: value })).toBe(10);
  });

  it("keeps separate tenant databases at a smaller pool", () => {
    expect(SECONDARY_POOL_MAX).toBe(5);
  });
});
