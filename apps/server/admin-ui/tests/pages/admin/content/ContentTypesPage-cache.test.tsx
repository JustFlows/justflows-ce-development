// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("../../../../src/i18n/I18nProvider", () => ({ useT: () => ({ t: (key: string) => key }) }));
vi.mock("../../../../src/components/SessionProvider", () => ({ useSessionRole: () => "administrator" }));
vi.mock("../../../../src/ssr-data", () => ({ initialJson: () => null }));
import ContentTypesPage from "../../../../src/pages/admin/content/ContentTypesPage";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("omits account cache controls and override payloads while allowing ordinary types", async () => {
  const types = ["account", "page"].map(slug => ({ slug, label: slug, description: "", builtin: true, fields: [], cacheControl: slug === "account" ? "private, no-store" : null, cacheControlEditable: slug !== "account" }));
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => ({ ok: true, json: async () => init?.method === "PATCH" ? { type: types[0] } : { types } }));
  vi.stubGlobal("fetch", fetcher);
  render(<ContentTypesPage />);
  await screen.findByText("account", { selector: "strong" });
  fireEvent.click(screen.getAllByText("contentTypes.editFields")[0]!);
  expect(screen.queryByLabelText("contentTypes.cacheControlLabel")).toBeNull();
  fireEvent.click(screen.getByText("contentTypes.saveFields"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/content-types/account", expect.objectContaining({ method: "PATCH" })));
  const patch = fetcher.mock.calls.find(call => call[1]?.method === "PATCH")?.[1];
  expect(JSON.parse(String(patch?.body))).not.toHaveProperty("cacheControl");
  fireEvent.click(screen.getByText("contentTypes.editFields"));
  expect(screen.getByLabelText("contentTypes.cacheControlLabel")).toBeTruthy();
});
