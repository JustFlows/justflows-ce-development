import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMenuProvider } from "@components/PluginMenuProvider";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../i18n/I18nProvider";
import PluginsPage from "../admin/PluginsPage";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

const PLUGINS = [
  { id: "seo-kit", name: "SEO Kit", version: "1.0.0", status: "active", publisher: "Justflows" },
];

function mockFetch(role: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return jsonResponse({ id: "self", email: "self@example.com", role });
      if (path === "/api/plugins/admin-menu") return jsonResponse({ items: [] });
      if (path === "/api/plugins") return jsonResponse({ plugins: PLUGINS });
      return jsonResponse({});
    }),
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <SessionProvider>
          <PluginMenuProvider>
            <PluginsPage />
          </PluginMenuProvider>
        </SessionProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("PluginsPage as an administrator", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows upload, activate/deactivate, and delete controls", async () => {
    mockFetch("administrator");
    renderPage();

    expect(await screen.findByText("SEO Kit")).toBeInTheDocument();
    expect(screen.getByText("Upload plugin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("does not delete when the confirmation is cancelled", async () => {
    mockFetch("administrator");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText("SEO Kit")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/cannot be undone/i);
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/database/i);
    const fetchMock = vi.mocked(fetch);
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]).includes("/api/plugins/seo-kit") &&
          (call[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
    confirm.mockRestore();
  });

  it("deletes after the confirmation is accepted", async () => {
    mockFetch("administrator");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText("SEO Kit")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No plugins installed")).toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          String(call[0]).includes("/api/plugins/seo-kit") &&
          (call[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
    confirm.mockRestore();
  });

  it("opens setupPath after activating a plugin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/auth/me") {
          return jsonResponse({ id: "self", email: "self@example.com", role: "administrator" });
        }
        if (path === "/api/plugins/admin-menu") return jsonResponse({ items: [] });
        if (path === "/api/plugins") {
          return jsonResponse({
            plugins: [
              {
                id: "justflows.shop",
                name: "Shop",
                version: "0.1.0",
                status: "inactive",
                publisher: "Justflows",
              },
            ],
          });
        }
        if (path === "/api/plugins/justflows.shop/activate" && method === "POST") {
          return jsonResponse({ ok: true, setupPath: "/admin/shop" });
        }
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/plugins"]}>
        <I18nProvider>
          <SessionProvider>
            <PluginMenuProvider>
              <Routes>
                <Route path="/admin/plugins" element={<PluginsPage />} />
                <Route path="/admin/shop" element={<div>Shop setup host</div>} />
              </Routes>
            </PluginMenuProvider>
          </SessionProvider>
        </I18nProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    expect(await screen.findByText("Shop")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByText("Shop setup host")).toBeInTheDocument();
  });
});

describe("PluginsPage as an editor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the installed list read-only, with no upload or manage controls", async () => {
    mockFetch("editor");
    renderPage();

    expect(await screen.findByText("SEO Kit")).toBeInTheDocument();
    expect(screen.queryByText("Upload plugin")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});
