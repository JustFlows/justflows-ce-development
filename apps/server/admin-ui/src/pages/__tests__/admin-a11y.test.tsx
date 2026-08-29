import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginMenuProvider } from "@components/PluginMenuProvider";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../i18n/I18nProvider";
import { expectNoCriticalAxe } from "../../test/a11y";
import LoginPage from "../LoginPage";
import InstallPage from "../InstallPage";
import ContentListPage from "../admin/ContentListPage";
import MediaPage from "../admin/MediaPage";
import PluginsPage from "../admin/PluginsPage";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function mockFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/bootstrap/status")) return jsonResponse({ ready: true });
      if (path.includes("/api/install/status")) return jsonResponse({ tokenRequired: false, tokenFile: null });
      if (path.includes("/api/auth/registration")) return jsonResponse({ enabled: false });
      if (path.includes("/api/auth/csrf")) return jsonResponse({ ok: true });
      if (path.includes("/api/auth/me")) return jsonResponse({ id: "u1", email: "admin@example.com", role: "administrator" });
      if (path.includes("/api/content-types")) {
        return jsonResponse({
          types: [
            { slug: "post", label: "Post" },
            { slug: "page", label: "Page" },
          ],
        });
      }
      if (path.includes("/api/content")) return jsonResponse({ items: [] });
      if (path.includes("/api/plugins/admin-menu")) return jsonResponse({ items: [] });
      if (path.includes("/api/plugins")) return jsonResponse({ plugins: [] });
      return jsonResponse({});
    }),
  );
}

describe("admin accessibility", () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has no critical axe findings on login", async () => {
    const { container } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Sign in to your site" })).toBeInTheDocument();
    await expectNoCriticalAxe(container);
  });

  it("completes the login form with the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    await user.tab();
    expect(screen.getByLabelText("Email address")).toHaveFocus();
    await user.keyboard("admin@example.com");
    await user.tab();
    expect(screen.getByLabelText("Password")).toHaveFocus();
    await user.keyboard("secret-password");
    await user.tab();
    expect(screen.getByRole("button", { name: /sign in/i })).toHaveFocus();
  });

  it("holds the site wizard until first-run files are ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/bootstrap/status")) {
          return jsonResponse({ ready: false, log: "npm install" });
        }
        return jsonResponse({});
      }),
    );
    render(
      <MemoryRouter>
        <InstallPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Preparing files…" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Database" })).not.toBeInTheDocument();
  });

  it("has no critical axe findings on the install wizard", async () => {
    const { container } = render(
      <MemoryRouter>
        <InstallPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Installation" })).toBeInTheDocument();
    await expectNoCriticalAxe(container);
  });

  it("completes install welcome and database steps with the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InstallPage />
      </MemoryRouter>,
    );

    await user.tab();
    expect(screen.getByRole("button", { name: /let's go/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Database" })).toBeInTheDocument();

    await user.tab();
    expect(screen.getByLabelText("Database type")).toHaveFocus();
    await expectNoCriticalAxe(screen.getByRole("heading", { name: "Database" }).closest(".jf-auth") as HTMLElement);
  });

  it("has no critical axe findings on the content list", async () => {
    const { container } = render(
      <MemoryRouter>
        <ContentListPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /new post/i })).toBeInTheDocument();
    });
    await expectNoCriticalAxe(container);
  });

  it("has no critical axe findings on media", async () => {
    const { container } = render(
      <MemoryRouter>
        <MediaPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Media Library" })).toBeInTheDocument();
    await expectNoCriticalAxe(container);
  });

  it("reaches the media dropzone with the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MediaPage />
      </MemoryRouter>,
    );

    await user.tab();
    expect(screen.getByRole("button", { name: "Upload files" })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: /upload files\. drop files here/i }),
    ).toHaveFocus();
  });

  it("has no critical axe findings on plugins", async () => {
    const { container } = render(
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
    await waitFor(() => {
      expect(screen.getByText("No plugins installed")).toBeInTheDocument();
    });
    await expectNoCriticalAxe(container);
  });

  it("reaches the plugin upload control with the keyboard", async () => {
    const user = userEvent.setup();
    render(
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

    await waitFor(() => {
      expect(screen.getByText("No plugins installed")).toBeInTheDocument();
    });
    await user.tab();
    expect(
      screen.getByRole("button", { name: /upload a plugin package/i }),
    ).toHaveFocus();
  });
});
