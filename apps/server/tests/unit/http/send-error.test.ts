// SPDX-License-Identifier: MIT
import type { Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendServerError } from "../../../src/lib/http/send-error.js";
import { QuotaRefusalError } from "../../../src/lib/tenancy/quotas.js";
afterEach(() => vi.restoreAllMocks());
function response() {
  const result = { headersSent: false, status: vi.fn(), json: vi.fn() };
  result.status.mockReturnValue(result);
  return result;
}
describe("storage refusal responses", () => {
  it("reports actionable quota errors without treating them as unexpected server failures", () => {
    const res = response();
    sendServerError(res as unknown as Response, "storage move", new QuotaRefusalError({ status: 409, error: "Storage limit exceeded", code: "quota_exceeded", meter: "storage.bytes" }));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: "Storage limit exceeded", code: "quota_exceeded", meter: "storage.bytes" });
  });
  it("keeps unexpected internal details out of API responses", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = response(); sendServerError(res as unknown as Response, "storage", new Error("internal filesystem details"));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal server error" }));
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("internal filesystem details");
  });
});
