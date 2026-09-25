import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../src/i18n/I18nProvider";
import { PluginMenuProvider } from "@components/PluginMenuProvider";
import { SessionProvider } from "@components/SessionProvider";
import PluginHostPage from "../../../../src/pages/admin/extensions/PluginHostPage";

/**
 * PluginMenuProvider only fetches the admin menu once SessionProvider
 * resolves a real session — wrap every test's own fetch mock so
 * `/api/auth/me` resolves to one, instead of falling through to that mock's
 * generic `{}` fallback (which is a valid 200 but not a valid SessionInfo,
 * and would leave the menu fetch — and every assertion below — never firing).
 */
function withSession(
  handler: (path: string) => Promise<Response>,
): (input: RequestInfo | URL) => Promise<Response> {
  return (input) => {
    const path = String(input);
    if (path.includes("/api/auth/me")) {
      return jsonResponse({ id: "u1", email: "admin@example.com", role: "administrator" });
    }
    return handler(path);
  };
}

const shopMenu = [
  {
    pluginId: "justflows.shop",
    id: "shop",
    label: "Shop",
    labelKey: "nav.shop",
    path: "/admin/plugins/justflows.shop",
    icon: "🛍",
    domain: "commerce",
    end: true,
    setupPath: "/admin/plugins/justflows.shop",
  },
  {
    pluginId: "justflows.shop",
    id: "products",
    label: "Products",
    labelKey: "nav.shopProducts",
    path: "/admin/plugins/justflows.shop/products",
    icon: "📦",
    domain: "commerce",
    setupPath: "/admin/plugins/justflows.shop",
    contentType: "product",
  },
  {
    pluginId: "justflows.shop",
    id: "orders",
    label: "Orders",
    labelKey: "nav.shopOrders",
    path: "/admin/plugins/justflows.shop/orders",
    icon: "🧾",
    domain: "commerce",
    setupPath: "/admin/plugins/justflows.shop",
  },
];

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response);
}

function renderHost(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <SessionProvider>
          <PluginMenuProvider>
            <PluginHostPage />
          </PluginMenuProvider>
        </SessionProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("PluginHostPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the plugin page declared on the admin menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        withSession((path) => {
          if (path.includes("/api/plugins/admin-menu")) {
            return jsonResponse({
              items: [
                {
                  pluginId: "acme.reports",
                  id: "reports",
                  label: "Reports",
                  path: "/admin/reports",
                  icon: "🛍",
                  domain: "extensions",
                },
              ],
            });
          }
          return jsonResponse({});
        }),
      ),
    );

    renderHost("/admin/reports");

    expect(await screen.findByRole("heading", { name: "Reports" })).toBeInTheDocument();
    expect(screen.getByText("acme.reports")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/admin/plugins/acme.reports/settings",
    );
    expect(await screen.findByText("This plugin is active")).toBeInTheDocument();
  });

  it("renders a first-run setup wizard from GET /ext/{id}/setup", async () => {
    const fetchMock = vi.fn(
      withSession((path) => {
        if (path.includes("/api/plugins/admin-menu")) {
          return jsonResponse({ items: shopMenu });
        }
        if (path.includes("/ext/justflows.shop/setup")) {
          return jsonResponse({
            kind: "setup",
            complete: false,
            title: "Commerce database",
            description: "Choose a topology.",
            step: 1,
            steps: [
              { id: "welcome", label: "Welcome" },
              { id: "topology", label: "Database" },
              { id: "probe", label: "Health check" },
            ],
            fields: [
              {
                name: "topology",
                label: "Storage topology",
                type: "select",
                options: [
                  { value: "shared", label: "Use the current Justflows database" },
                  { value: "separate", label: "Use a separate commerce database" },
                ],
              },
            ],
            values: { topology: "shared" },
            envManaged: false,
            passwordConfigured: false,
            readOnly: false,
            canContinue: true,
            canFinish: false,
          });
        }
        return jsonResponse({});
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHost("/admin/plugins/justflows.shop");

    expect(await screen.findByRole("heading", { name: "Commerce database" })).toBeInTheDocument();
    expect(screen.getByLabelText("Storage topology")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText("This plugin is active")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Products" })).not.toBeInTheDocument();
  });

  it("does not mount the setup wizard on a nested shop page", async () => {
    const fetchMock = vi.fn(
      withSession((path) => {
        if (path.includes("/api/plugins/admin-menu")) {
          return jsonResponse({ items: shopMenu });
        }
        if (path.includes("/api/content-types")) {
          return jsonResponse({ types: [{ slug: "product", label: "Product" }] });
        }
        if (path.includes("/api/content?")) {
          return jsonResponse({
            items: [
              {
                id: "prod-1",
                type: "product",
                title: "Canvas tote",
                slug: "canvas-tote",
                locale: "en-US",
                status: "published",
                updatedAt: "2026-08-28T00:00:00.000Z",
              },
              {
                id: "prod-2",
                type: "product",
                title: "Draft mug",
                slug: "draft-mug",
                locale: "nl-NL",
                status: "draft",
                updatedAt: "2026-08-27T00:00:00.000Z",
              },
            ],
          });
        }
        return jsonResponse({});
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHost("/admin/plugins/justflows.shop/products");

    expect(await screen.findByRole("heading", { name: "Products" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Canvas tote" })).toHaveAttribute(
      "href",
      "/admin/content/prod-1",
    );
    expect(screen.getByText("Draft mug")).toBeInTheDocument();
    expect(screen.getByText("en-US")).toBeInTheDocument();
    expect(screen.getByText("nl-NL")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New product" })).toHaveAttribute(
      "href",
      "/admin/content/new?type=product",
    );
    expect(screen.queryByText("Commerce database")).not.toBeInTheDocument();
    expect(screen.queryByText(/Products will appear here/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Import" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/setup"))).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/api/content?type=product")),
    ).toBe(true);
  });

  it("lists the default language once when a product has translations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        withSession((path) => {
          if (path.includes("/api/plugins/admin-menu")) return jsonResponse({ items: shopMenu });
          if (path.includes("/api/content-types")) {
            return jsonResponse({ types: [{ slug: "product", label: "Product" }] });
          }
          if (path.includes("/api/languages/active")) {
            return jsonResponse({
              languages: [
                { code: "en-US", isDefault: true },
                { code: "nl-NL", isDefault: false },
              ],
            });
          }
          if (path.includes("/api/content?")) {
            return jsonResponse({
              items: [
                {
                  id: "prod-nl",
                  type: "product",
                  title: "",
                  slug: "kids-raincoat",
                  locale: "nl-NL",
                  translationGroupId: "prod-en",
                  status: "draft",
                  updatedAt: "2026-09-24T00:00:00.000Z",
                },
                {
                  id: "prod-en",
                  type: "product",
                  title: "Kids raincoat",
                  slug: "kids-raincoat",
                  locale: "en-US",
                  translationGroupId: "prod-en",
                  status: "published",
                  updatedAt: "2026-09-24T00:00:00.000Z",
                },
                {
                  id: "prod-only-nl",
                  type: "product",
                  title: "Alleen Nederlands",
                  slug: "alleen-nederlands",
                  locale: "nl-NL",
                  translationGroupId: "prod-only-nl",
                  status: "draft",
                  updatedAt: "2026-09-23T00:00:00.000Z",
                },
              ],
            });
          }
          return jsonResponse({});
        }),
      ),
    );

    renderHost("/admin/plugins/justflows.shop/products");

    expect(await screen.findByRole("link", { name: "Kids raincoat" })).toHaveAttribute(
      "href",
      "/admin/content/prod-en",
    );
    expect(screen.getAllByText("/kids-raincoat")).toHaveLength(1);
    expect(screen.getAllByText("nl-NL")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Alleen Nederlands" })).toHaveAttribute(
      "href",
      "/admin/content/prod-only-nl",
    );
  });

  it("links the product list to a separate import page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        withSession((path) => {
          if (path.includes("/api/plugins/admin-menu")) {
            return jsonResponse({
              items: [
                ...shopMenu,
                {
                  pluginId: "justflows.shop",
                  id: "import",
                  label: "Import",
                  path: "/admin/plugins/justflows.shop/products/import",
                  icon: "📥",
                  domain: "commerce",
                  listed: false,
                  adminAppUrl: "/ext/justflows.shop/admin/products.html",
                },
              ],
            });
          }
          if (path.includes("/api/content-types")) {
            return jsonResponse({ types: [{ slug: "product", label: "Product" }] });
          }
          if (path.includes("/api/content?")) return jsonResponse({ items: [] });
          return jsonResponse({});
        }),
      ),
    );

    renderHost("/admin/plugins/justflows.shop/products");

    expect(await screen.findByRole("link", { name: "Import" })).toHaveAttribute(
      "href",
      "/admin/plugins/justflows.shop/products/import",
    );
    expect(screen.queryByTitle("Import products")).not.toBeInTheDocument();
    expect(await screen.findByText("No Products yet")).toBeInTheDocument();
  });

  it("moves the selected products to trash together", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(
      withSession((path) => {
        if (path.includes("/api/plugins/admin-menu")) return jsonResponse({ items: shopMenu });
        if (path.includes("/api/content-types")) {
          return jsonResponse({ types: [{ slug: "product", label: "Product" }] });
        }
        if (path.includes("/api/content/prod-1") || path.includes("/api/content/prod-2")) {
          return jsonResponse({ ok: true });
        }
        if (path.includes("/api/content?")) {
          return jsonResponse({
            items: [
              {
                id: "prod-1",
                type: "product",
                title: "Canvas tote",
                slug: "canvas-tote",
                locale: "en-US",
                status: "published",
                updatedAt: "2026-08-28T00:00:00.000Z",
              },
              {
                id: "prod-2",
                type: "product",
                title: "Draft mug",
                slug: "draft-mug",
                locale: "nl-NL",
                status: "draft",
                updatedAt: "2026-08-27T00:00:00.000Z",
              },
            ],
          });
        }
        return jsonResponse({});
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHost("/admin/plugins/justflows.shop/products");

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));

    expect(confirm).toHaveBeenCalled();
    await waitFor(() => {
      const deleted = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").map(([input]) => String(input));
      expect(deleted.some((url) => url.includes("/api/content/prod-1"))).toBe(true);
      expect(deleted.some((url) => url.includes("/api/content/prod-2"))).toBe(true);
    });
    confirm.mockRestore();
  });

  it("pages through every product until the content cursor is exhausted", async () => {
    const fetchMock = vi.fn(
      withSession((path) => {
        if (path.includes("/api/plugins/admin-menu")) {
          return jsonResponse({ items: shopMenu });
        }
        if (path.includes("/api/content-types")) {
          return jsonResponse({ types: [{ slug: "product", label: "Product" }] });
        }
        if (path.includes("/api/content?")) {
          if (path.includes("cursor=")) {
            return jsonResponse({
              items: [
                {
                  id: "prod-2",
                  type: "product",
                  title: "Second product",
                  slug: "second",
                  locale: "en-US",
                  status: "published",
                  updatedAt: "2026-08-27T00:00:00.000Z",
                },
              ],
            });
          }
          return jsonResponse({
            items: [
              {
                id: "prod-1",
                type: "product",
                title: "First product",
                slug: "first",
                locale: "en-US",
                status: "published",
                updatedAt: "2026-08-28T00:00:00.000Z",
              },
            ],
            nextCursor: "c1",
          });
        }
        return jsonResponse({});
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHost("/admin/plugins/justflows.shop/products");

    expect(await screen.findByRole("link", { name: "First product" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Second product" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("cursor=c1"))).toBe(true);
  });

  it("shows an empty catalog when there are no product entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        withSession((path) => {
          if (path.includes("/api/plugins/admin-menu")) {
            return jsonResponse({ items: shopMenu });
          }
          if (path.includes("/api/content-types")) {
            return jsonResponse({ types: [{ slug: "product", label: "Product" }] });
          }
          if (path.includes("/api/content?")) {
            return jsonResponse({ items: [] });
          }
          return jsonResponse({});
        }),
      ),
    );

    renderHost("/admin/plugins/justflows.shop/products");

    expect(await screen.findByText("No Products yet")).toBeInTheDocument();
    expect(screen.getByText("Create the first product to get started.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New product" })).toHaveAttribute(
      "href",
      "/admin/content/new?type=product",
    );
  });

  it("keeps a placeholder on nested pages that do not list a content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        withSession((path) => {
          if (path.includes("/api/plugins/admin-menu")) {
            return jsonResponse({ items: shopMenu });
          }
          return jsonResponse({});
        }),
      ),
    );

    renderHost("/admin/plugins/justflows.shop/orders");

    expect(await screen.findByRole("heading", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getByText(/Orders will appear here/)).toBeInTheDocument();
  });

  it("shows shop landing tiles after setup is complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        withSession((path) => {
          if (path.includes("/api/plugins/admin-menu")) {
            return jsonResponse({ items: shopMenu });
          }
          if (path.includes("/ext/justflows.shop/setup")) {
            return jsonResponse({
              kind: "setup",
              complete: true,
              title: "Store settings",
              description: "Using the current Justflows database.",
              step: 5,
              steps: [
                { id: "welcome", label: "Welcome" },
                { id: "review", label: "Review" },
              ],
              fields: [
                { name: "storeName", label: "Store name", type: "text" },
                { name: "address", label: "Business address", type: "text" },
                { name: "sandbox", label: "Sandbox / test mode", type: "checkbox" },
              ],
              values: { storeName: "JS store", address: "Keizersgracht 1", sandbox: false },
              envManaged: false,
              passwordConfigured: false,
              readOnly: false,
              canContinue: false,
              canFinish: false,
            });
          }
          return jsonResponse({});
        }),
      ),
    );

    renderHost("/admin/plugins/justflows.shop");

    expect(await screen.findByRole("link", { name: "Products" })).toHaveAttribute(
      "href",
      "/admin/plugins/justflows.shop/products",
    );
    expect(screen.getByRole("heading", { name: "Shop" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/admin/plugins/justflows.shop/settings",
    );
    expect(screen.queryByRole("heading", { name: "Store settings" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Store name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Setup steps")).not.toBeInTheDocument();
  });
});
