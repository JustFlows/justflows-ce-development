// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { pollStaticExportJob, readStaticExportJson } from "../../src/lib/static-export-request";
describe("export API responses", () => {
  it("handles HTML proxy errors without exposing a JSON parser error", async () => {
    const response = new Response("<!DOCTYPE html><h1>Gateway timeout</h1>", {
      status: 504,
      headers: { "content-type": "text/html" },
    });
    await expect(
      readStaticExportJson(response, "Export response unavailable (504)"),
    ).rejects.toThrow("Export response unavailable (504)");
  });
  it("handles valid JSON and invalid JSON bodies", async () => {
    expect(
      await readStaticExportJson(
        new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
        "invalid",
      ),
    ).toEqual({ ok: true });
    await expect(
      readStaticExportJson(
        new Response("<!DOCTYPE html>", { headers: { "content-type": "application/json" } }),
        "invalid",
      ),
    ).rejects.toThrow("invalid");
  });
  it("polls until completion and publishes progress", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ job: { id: "a", state: "running", log: ["Crawl"] } })
      .mockResolvedValueOnce({ job: { id: "a", state: "completed", log: ["Done"] } });
    const update = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);
    expect((await pollStaticExportJob("a", status, update, "unavailable", delay)).state).toBe(
      "completed",
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(2);
  });
  it("reports a failed job and refuses another job's result", async () => {
    expect(
      (
        await pollStaticExportJob(
          "a",
          async () => ({ job: { id: "a", state: "failed", log: [], error: "Failed" } }),
          vi.fn(),
          "unavailable",
          async () => {},
        )
      ).error,
    ).toBe("Failed");
    await expect(
      pollStaticExportJob(
        "a",
        async () => ({ job: { id: "b", state: "completed", log: [] } }),
        vi.fn(),
        "unavailable",
        async () => {},
      ),
    ).rejects.toThrow("unavailable");
  });
});
