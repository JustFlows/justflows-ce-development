// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { isLocalDatabaseHost, sanitizeProbeError } from "../db-probe.js";

describe("sanitizeProbeError", () => {
  it("redacts credentials embedded in a connection string", () => {
    expect(sanitizeProbeError(new Error("connect postgres://shop:hunter2@db.example/shop"))).toBe(
      "connect postgres://shop:****@db.example/shop",
    );
  });

  it("strips newlines so the message cannot break log lines", () => {
    expect(sanitizeProbeError("boom\npassword=secret")).toBe("boom password=secret");
  });
});

describe("isLocalDatabaseHost", () => {
  it("treats loopback names as local", () => {
    expect(isLocalDatabaseHost("localhost")).toBe(true);
    expect(isLocalDatabaseHost("127.0.0.1")).toBe(true);
    expect(isLocalDatabaseHost("db.example.com")).toBe(false);
  });
});
