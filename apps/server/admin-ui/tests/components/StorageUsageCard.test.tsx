// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
vi.mock("../../src/i18n/I18nProvider", () => ({ useT: () => ({ t: (key: string) => key }) }));
import StorageUsageCard, { formatStorageBytes } from "../../src/components/StorageUsageCard";
afterEach(() => vi.unstubAllGlobals());
describe("storage usage card", () => {
  it("displays measured local/external usage and passes fresh usage to limits", async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      rows: [
        { category: "media", local: { bytes: 512, files: 1 }, external: { bytes: 2048, files: 1 } },
      ],
      local: { bytes: 512, files: 1 },
      external: { bytes: 2048, files: 1 },
      totalBytes: 2560,
      logicalBytes: 1024,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ state: "ready", report }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    const update = vi.fn();
    render(<StorageUsageCard endpoint="/storage" onMeasured={update} />);
    await waitFor(() => expect(update).toHaveBeenCalledWith(report));
    expect(screen.getByText("2.50 KB")).toBeTruthy();
    expect(formatStorageBytes(512)).toBe("512 B");
  });
  it("shows unknown when provider usage fails instead of reporting zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("storage unavailable")));
    render(<StorageUsageCard endpoint="/storage" />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("storageUsage.unknown"),
    );
    expect(screen.queryByText("0 B")).toBeNull();
  });
});
