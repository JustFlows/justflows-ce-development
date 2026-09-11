// SPDX-License-Identifier: MIT
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContentSchedule, { localDateInput, localDateIso } from "./ContentSchedule";
vi.mock("../i18n/I18nProvider", () => ({
  useT: () => ({ t: (key: string) => key, locale: "en" }),
}));
vi.mock("./SessionProvider", () => ({ useCapability: () => true }));
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("ContentSchedule", () => {
  it("converts between an instant and the user's local datetime", () => {
    const instant = "2030-06-01T15:30:00.000Z";
    expect(localDateIso(localDateInput(instant))).toBe(instant);
    expect(localDateIso("")).toBeNull();
    expect(() => localDateIso("invalid")).toThrow();
  });
  it("requires saving dirty content before scheduling", () => {
    render(
      <ContentSchedule
        item={{ id: "entry", version: 2 }}
        disabled
        siteTimezone="Europe/Amsterdam"
        onSaved={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "scheduling.save" })).toBeDisabled();
    expect(screen.getByText("scheduling.saveFirst")).toBeTruthy();
  });
  it("sends explicit UTC instants with the version and exposes a save conflict", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "Version conflict" }),
    }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <ContentSchedule
        item={{ id: "entry", version: 2, publishOn: "2030-06-01T15:30:00Z" }}
        disabled={false}
        siteTimezone="UTC"
        onSaved={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "scheduling.save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Version conflict"));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      publishOn: "2030-06-01T15:30:00.000Z",
      unpublishOn: null,
      expectedVersion: 2,
    });
  });
});
