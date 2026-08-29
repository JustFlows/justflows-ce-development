import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import ContentNewPage from "../admin/ContentNewPage";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response);
}

const catalog = {
  kind: "catalog",
  contentId: "",
  type: "simple",
  visibility: "public",
  sku: "",
  barcode: "",
  regularAmount: "",
  saleAmount: "",
  saleStartsAt: "",
  saleEndsAt: "",
  costAmount: "",
  currency: "EUR",
  precision: 2,
  taxClass: "",
  shippingClass: "",
  weight: "",
  length: "",
  width: "",
  height: "",
  trackInventory: false,
  stock: 0,
  backorder: "disabled",
  soldIndividually: false,
  minQty: 1,
  maxQty: "",
  qtyStep: 1,
  weightUnit: "kg",
  dimensionUnit: "cm",
  attributes: [],
  variations: [],
};

describe("ContentNewPage product", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows product fields and writes shop catalog after creating content", async () => {
    const user = userEvent.setup();
    const putBodies: unknown[] = [];
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
        if (path === "/ext/justflows.shop/catalog") return jsonResponse(catalog);
        if (path === "/api/content" && init?.method === "POST") {
          return jsonResponse({ id: "11111111-1111-4111-8111-111111111111" }, 201);
        }
        if (init?.method === "PUT" && path.includes("/ext/justflows.shop/catalog/")) {
          putBodies.push(JSON.parse(String(init.body)));
          return jsonResponse({ ...catalog, contentId: "11111111-1111-4111-8111-111111111111", sku: "SKU-1" });
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

    expect(await screen.findByLabelText("SKU")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Title"), "Test product");
    await user.type(screen.getByLabelText("SKU"), "SKU-1");
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("editor")).toBeInTheDocument();
    expect(putBodies[0]).toEqual(
      expect.objectContaining({
        sku: "SKU-1",
        contentId: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });
});
