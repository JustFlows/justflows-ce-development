import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PluginMenuProvider } from "@components/PluginMenuProvider";
import PluginHostPage from "../admin/PluginHostPage";

const shopMenu = [
  {
    pluginId: "justflows.shop",
    id: "shop",
    label: "Shop",
    labelKey: "nav.shop",
    path: "/admin/shop",
    icon: "🛍",
    domain: "commerce",
    end: true,
    setupPath: "/admin/shop",
  },
  {
    pluginId: "justflows.shop",
    id: "products",
    label: "Products",
    labelKey: "nav.shopProducts",
    path: "/admin/shop/products",
    icon: "📦",
    domain: "commerce",
    setupPath: "/admin/shop",
    contentType: "product",
  },
  {
    pluginId: "justflows.shop",
    id: "orders",
    label: "Orders",
    labelKey: "nav.shopOrders",
    path: "/admin/shop/orders",
    icon: "🧾",
    domain: "commerce",
    setupPath: "/admin/shop",
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
        <PluginMenuProvider>
          <PluginHostPage />
        </PluginMenuProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("PluginHostPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the plugin page declared on the admin menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
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
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
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
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHost("/admin/shop");

    expect(await screen.findByRole("heading", { name: "Commerce database" })).toBeInTheDocument();
    expect(screen.getByLabelText("Storage topology")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText("This plugin is active")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Products" })).not.toBeInTheDocument();
  });

  it("does not mount the setup wizard on a nested shop page", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
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
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHost("/admin/shop/products");

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
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/setup"))).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/api/content?type=product")),
    ).toBe(true);
  });

  it("pages through every product until the content cursor is exhausted", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
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
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHost("/admin/shop/products");

    expect(await screen.findByRole("link", { name: "First product" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Second product" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("cursor=c1"))).toBe(true);
  });

  it("shows an empty catalog when there are no product entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
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
    );

    renderHost("/admin/shop/products");

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
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/api/plugins/admin-menu")) {
          return jsonResponse({ items: shopMenu });
        }
        return jsonResponse({});
      }),
    );

    renderHost("/admin/shop/orders");

    expect(await screen.findByRole("heading", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getByText(/Orders will appear here/)).toBeInTheDocument();
  });

  it("shows shop landing tiles after setup is complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
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
    );

    renderHost("/admin/shop");

    expect(await screen.findByRole("link", { name: "Products" })).toHaveAttribute(
      "href",
      "/admin/shop/products",
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
