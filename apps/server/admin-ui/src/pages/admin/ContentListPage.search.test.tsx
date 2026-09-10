// SPDX-License-Identifier: MIT
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import ContentListPage from "./ContentListPage";
import { setAdminSsrPayload } from "../../ssr-data";

function setup(fail = false) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      let data: unknown = {};
      let ok = true;
      if (url === "/api/languages") data = { languages: [{ code: "en-US", isDefault: true }] };
      if (url === "/api/content-types") data = { types: [{ slug: "post", label: "Posts" }] };
      if (url.startsWith("/api/content?")) data = { items: [] };
      if (url.startsWith("/api/search?")) {
        ok = !fail;
        data = {
          items: [
            {
              id: "result-1",
              title: "Found beyond the first page",
              type: "post",
              slug: "found",
              status: "published",
              updatedAt: "2026-01-01",
            },
          ],
          total: 21,
        };
      }
      return { ok, json: async () => data } as Response;
    }),
  );
  render(
    <MemoryRouter>
      <I18nProvider>
        <ContentListPage />
      </I18nProvider>
    </MemoryRouter>,
  );
  return calls;
}
afterEach(() => {
  vi.unstubAllGlobals();
  setAdminSsrPayload(null);
});
it("searches on the server and preserves query when paging", async () => {
  const calls = setup();
  const user = userEvent.setup();
  await user.type(screen.getByRole("searchbox", { name: "Search content" }), "astronomy");
  expect(
    await screen.findByRole("link", { name: "Found beyond the first page" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(
      calls.some(
        (url) =>
          url.includes("/api/search?") && url.includes("q=astronomy") && url.includes("page=2"),
      ),
    ).toBe(true),
  );
});
it("reports search failures without presenting stale matches", async () => {
  setup(true);
  const user = userEvent.setup();
  await user.type(screen.getByRole("searchbox"), "astronomy");
  expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
  expect(
    screen.queryByRole("link", { name: "Found beyond the first page" }),
  ).not.toBeInTheDocument();
});
