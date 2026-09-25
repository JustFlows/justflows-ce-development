import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../src/i18n/I18nProvider";
import ContentNewPage from "../../../../src/pages/admin/content/ContentNewPage";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response);
}

describe("ContentNewPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a content row and opens the editor", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("/api/languages/active")) {
          return jsonResponse({ languages: [{ code: "en-US", nativeName: "English", isDefault: true }] });
        }
        if (path.includes("/api/content-types/")) {
          return jsonResponse({ type: { label: "Product" } });
        }
        if (path === "/api/content" && init?.method === "POST") {
          return jsonResponse({ id: "11111111-1111-4111-8111-111111111111" }, 201);
        }
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/content/new?type=product"]}>
        <I18nProvider>
          <Routes>
            <Route path="/admin/content/new" element={<ContentNewPage />} />
            <Route path="/admin/content/:id" element={<div>editor</div>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText("SKU")).not.toBeInTheDocument();
    await user.type(await screen.findByPlaceholderText("Title"), "Test product");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("editor")).toBeInTheDocument();
  });
});
