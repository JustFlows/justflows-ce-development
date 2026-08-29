import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../i18n/I18nProvider";
import PluginSettingsPage from "../admin/PluginSettingsPage";

const SCHEMA = {
  storeName: { type: "string" as const, label: "Store name", localized: true, default: "" },
  sandbox: { type: "boolean" as const, label: "Sandbox / test mode", default: false },
};

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/plugins/justflows.shop/settings"]}>
      <I18nProvider>
        <SessionProvider>
          <Routes>
            <Route path="/admin/plugins/:id/settings" element={<PluginSettingsPage />} />
          </Routes>
        </SessionProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("PluginSettingsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders fields from the settings schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/auth/me") {
          return jsonResponse({ id: "self", email: "self@example.com", role: "administrator" });
        }
        if (path === "/api/plugins/justflows.shop/settings") {
          return jsonResponse({
            schema: SCHEMA,
            values: { storeName: { "en-US": "Demo" }, sandbox: false },
            languages: [{ code: "en-US", nativeName: "English", isDefault: true }],
          });
        }
        return jsonResponse({});
      }),
    );

    renderPage();
    expect(await screen.findByText("Store name")).toBeInTheDocument();
    expect(screen.getByText("Sandbox / test mode")).toBeInTheDocument();
  });

  it("does not treat a save acknowledgement as a missing schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/auth/me") {
          return jsonResponse({ id: "self", email: "self@example.com", role: "administrator" });
        }
        if (path === "/api/plugins/justflows.shop/settings") {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({});
      }),
    );

    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Plugin settings could not be loaded.");
    expect(screen.queryByText("This plugin does not declare a settings schema.")).not.toBeInTheDocument();
  });

  it("keeps the form after save returns the schema", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/auth/me") {
        return jsonResponse({ id: "self", email: "self@example.com", role: "administrator" });
      }
      if (path === "/api/plugins/justflows.shop/settings" && method === "PUT") {
        return jsonResponse({
          schema: SCHEMA,
          values: { storeName: { "en-US": "Saved" }, sandbox: true },
          languages: [{ code: "en-US", nativeName: "English", isDefault: true }],
        });
      }
      if (path === "/api/plugins/justflows.shop/settings") {
        return jsonResponse({
          schema: SCHEMA,
          values: { storeName: { "en-US": "Demo" }, sandbox: false },
          languages: [{ code: "en-US", nativeName: "English", isDefault: true }],
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    expect(await screen.findByText("Store name")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Store name")).toBeInTheDocument();
  });
});
