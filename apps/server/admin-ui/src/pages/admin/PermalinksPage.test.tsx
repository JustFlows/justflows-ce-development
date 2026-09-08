// SPDX-License-Identifier: MIT

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PermalinksPage from "./PermalinksPage";
vi.mock("../../i18n/I18nProvider", () => ({ useT: () => ({ t: (key: string) => key }) }));
const settings = {
  structure: "/%postname%/",
  typeBases: {},
  categoryBase: "category",
  tagBase: "tag",
  taxonomyBases: {},
  trailingSlash: "never",
};
const config = {
  settings,
  presets: { name: "/%postname%/", day: "/%year%/%monthnum%/%day%/%postname%/" },
  types: [{ slug: "product", label: "Products" }],
  taxonomies: [],
  redirects: {},
};
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(config))),
  );
});
describe("PermalinksPage", () => {
  it("loads settings and saves the selected preset and type base", async () => {
    const user = userEvent.setup();
    render(<PermalinksPage />);
    await user.selectOptions(await screen.findByLabelText("permalinks.preset"), "day");
    await user.type(screen.getByLabelText("Products"), "shop/products");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, redirectsCreated: 1 })),
    );
    await user.click(screen.getByRole("button", { name: "permalinks.save" }));
    await screen.findByRole("status");
    const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      ...settings,
      structure: config.presets.day,
      typeBases: { product: "shop/products" },
    });
  });
  it("keeps edits and displays server-side collision errors", async () => {
    const user = userEvent.setup();
    render(<PermalinksPage />);
    await screen.findByLabelText("Products");
    await user.type(screen.getByLabelText("Products"), "control-room");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Reserved URL" }), { status: 409 }),
    );
    await user.click(screen.getByRole("button", { name: "permalinks.save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reserved URL");
    expect(screen.getByLabelText("Products")).toHaveValue("control-room");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "permalinks.save" })).toBeEnabled(),
    );
  });
  it("offers retry after a loading failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );
    render(<PermalinksPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
    await userEvent.click(screen.getByRole("button", { name: "permalinks.retry" }));
    expect(await screen.findByLabelText("permalinks.structure")).toHaveValue(settings.structure);
  });
});
