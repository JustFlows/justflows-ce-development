import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../../src/i18n/I18nProvider";
import ThemeCustomizePage from "../../../../src/pages/admin/design/ThemeCustomizePage";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
}

function mockFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/api/auth/me")) {
        return jsonResponse({ id: "u1", email: "admin@example.com", role: "administrator" });
      }
      if (path.includes("/api/themes/customize")) {
        return jsonResponse({ theme: { name: "Default" }, schema: {}, mods: {}, pages: [] });
      }
      if (path.includes("/api/template-parts/footer")) return jsonResponse({ blocks: [] });
      if (path.includes("/api/languages/active")) return jsonResponse({ languages: [{ code: "en-US", isDefault: true }] });
      if (path.includes("/api/languages")) {
        return jsonResponse({ languages: [{ code: "en-US", isDefault: true, isActive: true }] });
      }
      if (path.includes("/api/menus/design-presets")) return jsonResponse({ presets: [] });
      if (path === "/api/menus") {
        return jsonResponse({ menus: [{ id: "m1", slug: "primary", name: "Primary", items: [] }] });
      }
      if (path.startsWith("/api/menus/")) {
        return jsonResponse({ menu: { id: "m1", slug: "primary", name: "Primary", items: [] } });
      }
      if (path.includes("/api/content-types")) return jsonResponse({ types: [] });
      if (path.includes("/api/content")) return jsonResponse({ items: [] });
      return jsonResponse({});
    }),
  );
}

function renderPage(initialPath = "/admin/themes/customize") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <I18nProvider>
        <SessionProvider>
          <ThemeCustomizePage />
        </SessionProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("ThemeCustomizePage menus tab", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hosts the menu designer under a Menus tab instead of a separate page", async () => {
    mockFetch();
    const user = userEvent.setup();
    renderPage();

    const menusTab = await screen.findByRole("button", { name: "Menus" });
    await user.click(menusTab);
    expect(menusTab.className).toContain("jf-theme-builder__tab--active");
    expect(await screen.findByText("Add menu items")).toBeInTheDocument();
    // Embedded in the customizer, the standalone page's own "back" link is redundant.
    expect(screen.queryByRole("link", { name: /back to themes/i })).not.toBeInTheDocument();
  });

  it("opens directly on the Menus tab when linked with ?tab=menus", async () => {
    mockFetch();
    renderPage("/admin/themes/customize?tab=menus");

    expect(await screen.findByText("Add menu items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menus" }).className).toContain(
      "jf-theme-builder__tab--active",
    );
  });
});

function mockSiteParts(): void {
  const base = (fetch as unknown as { getMockImplementation: () => (input: RequestInfo | URL) => Promise<Response> }).getMockImplementation();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/templates") {
        return jsonResponse({ slots: [{ slug: "single", customised: false }, { slug: "page", customised: true }], creatable: [] });
      }
      if (path.startsWith("/api/templates/")) return jsonResponse({ blocks: [], fromThemeDefault: true });
      if (path === "/api/headers") return jsonResponse({ library: { version: 1, defaultId: null, entries: [] } });
      if (path.includes("/api/blocks")) return jsonResponse({ blocks: [] });
      return base(input);
    }),
  );
}

describe("ThemeCustomizePage site parts in the builder shell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("opens the footer in the shell with its own save buttons and the site navigation", async () => {
    mockFetch();
    mockSiteParts();
    const user = userEvent.setup();
    renderPage("/admin/themes/customize?tab=footer");

    expect(await screen.findByText("Global footer", { selector: ".jf-shell__context" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Default");
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    /** The customizer's own tab row is replaced by the Site panel. */
    expect(document.querySelector(".jf-theme-builder__tabs")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Site" }));
    const nav = screen.getByRole("navigation", { name: "Site parts" });
    expect(within(nav).getByRole("button", { name: "Footer" })).toHaveAttribute("aria-current", "page");

    await user.click(within(nav).getByRole("button", { name: "Templates" }));
    expect(await screen.findByText("Template", { selector: ".jf-shell__context" })).toBeInTheDocument();

    await user.click(within(screen.getByRole("navigation", { name: "Site parts" })).getByRole("button", { name: "Menus" }));
    expect(await screen.findByText("Add menu items")).toBeInTheDocument();
    expect(document.querySelector(".jf-theme-builder__tabs")).not.toBeNull();
  });

  it("opens the first template slot instead of an empty canvas", async () => {
    mockFetch();
    mockSiteParts();
    renderPage("/admin/themes/customize?tab=templates");

    expect(await screen.findByText("Template", { selector: ".jf-shell__context" })).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/templates/single")).toBe(true),
    );
  });

  it("keeps the header part in the shell when no header is saved yet", async () => {
    mockFetch();
    mockSiteParts();
    renderPage("/admin/themes/customize?tab=header");

    expect(await screen.findByRole("navigation", { name: "Site parts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Default");
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });
});

describe("ThemeCustomizePage site part conflicts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  function withPut(path: string, status: number, body: unknown) {
    const base = vi.mocked(fetch).getMockImplementation()!;
    const puts: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === path && init?.method === "PUT") {
          puts.push(JSON.parse(String(init.body)));
          return jsonResponse(body, status);
        }
        if (String(input) === "/api/template-parts/footer") return jsonResponse({ blocks: [], draft: [], revision: 7 });
        if (String(input) === "/api/headers") {
          return jsonResponse({ library: { version: 1, defaultId: null, entries: [] }, draft: null, revision: 3 });
        }
        return base(input);
      }),
    );
    return puts;
  }

  it("sends the footer revision it loaded and stops on a conflict", async () => {
    mockFetch();
    mockSiteParts();
    const puts = withPut("/api/template-parts/footer", 409, { code: "document_conflict", expectedRevision: 7, actualRevision: 8 });
    const user = userEvent.setup();
    renderPage("/admin/themes/customize?tab=footer");

    await user.click(await screen.findByRole("button", { name: "Save draft" }));
    expect(puts[0]).toMatchObject({ draft: true, expectedRevision: 7 });
    expect(await screen.findByText(/Someone else saved this after you opened it/)).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((el) => /Not saved/.test(el.textContent ?? ""))).toBe(true);
  });

  it("only overwrites the footer after confirmation, using the latest revision", async () => {
    mockFetch();
    mockSiteParts();
    const puts = withPut("/api/template-parts/footer", 409, { code: "document_conflict" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage("/admin/themes/customize?tab=footer");

    await user.click(await screen.findByRole("button", { name: "Save draft" }));
    await user.click(await screen.findByRole("button", { name: "Save mine over it" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/will be lost/));
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ draft: true, expectedRevision: 7 });
  });

  it("sends the header library revision and shows a conflict", async () => {
    mockFetch();
    mockSiteParts();
    const puts = withPut("/api/headers", 409, { code: "document_conflict" });
    const user = userEvent.setup();
    renderPage("/admin/themes/customize?tab=header");

    await user.click(await screen.findByRole("button", { name: "Save draft" }));
    expect(puts[0]).toMatchObject({ draft: true, expectedRevision: 3 });
    expect(await screen.findByText(/Someone else saved this after you opened it/)).toBeInTheDocument();
  });
});

describe("ThemeCustomizePage site part revisions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("lists footer versions and loads one into the editor without saving", async () => {
    mockFetch();
    mockSiteParts();
    const base = vi.mocked(fetch).getMockImplementation()!;
    const puts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PUT") puts.push(url);
        if (url === "/api/document-history?kind=template_part&key=footer") {
          return jsonResponse({ items: [{ id: "h1", revision: 2, state: "published", createdAt: "2026-11-12T08:00:00Z", createdByName: "Ada" }] });
        }
        if (url === "/api/document-history/h1?kind=template_part&key=footer") {
          return jsonResponse({ doc: { version: 1, blocks: [{ id: "f1", type: "core.paragraph", version: 1, props: {} }] } });
        }
        return base(input);
      }),
    );
    const user = userEvent.setup();
    renderPage("/admin/themes/customize?tab=footer");

    await user.click(await screen.findByRole("button", { name: "Revisions" }));
    await user.click(await screen.findByRole("button", { name: /Published · Ada/ }));
    expect(await screen.findByRole("heading", { name: /Add 1 block/ })).toBeInTheDocument();
    expect(screen.getByText(/Save a draft or publish to keep it/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(await screen.findByText("1 block")).toBeInTheDocument();
    expect(puts).toEqual([]);
  });
});
