import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import ProductCatalogFields from "../admin/ProductCatalogFields";

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
  contentId: "11111111-1111-4111-8111-111111111111",
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

describe("ProductCatalogFields", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lets a merchant enter price and SKU, then generate variations", async () => {
    const user = userEvent.setup();
    const saveRef = { current: null as (() => Promise<boolean>) | null };
    const putBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (init?.method === "PUT") {
          putBodies.push(JSON.parse(String(init.body)));
          return jsonResponse({ ...catalog, type: "variable", sku: "SHIRT", regularAmount: "20.00" });
        }
        if (path.includes("/ext/justflows.shop/catalog/")) return jsonResponse(catalog);
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter>
        <I18nProvider>
          <ProductCatalogFields
            contentId={catalog.contentId}
            saveRef={saveRef}
            onDirtyChange={() => undefined}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText("SKU")).toBeInTheDocument();
    await user.type(screen.getByLabelText("SKU"), "SHIRT");
    await user.type(screen.getByLabelText(/Regular price/), "20.00");
    await user.selectOptions(screen.getByLabelText("Product type"), "variable");
    expect(await screen.findByRole("button", { name: "Add attribute" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add attribute" }));
    await user.type(screen.getByLabelText("Attribute"), "Size");
    await user.type(screen.getByLabelText("Values"), "S, M");
    await user.click(screen.getByRole("button", { name: "Generate variations" }));
    expect(await screen.findByText("Size: S")).toBeInTheDocument();
    expect(screen.getByText("Size: M")).toBeInTheDocument();

    expect(saveRef.current).toBeTypeOf("function");
    await saveRef.current?.();
    expect(putBodies[0]).toEqual(
      expect.objectContaining({
        sku: "SHIRT",
        regularAmount: "20.00",
        type: "variable",
        attributes: [{ name: "Size", values: ["S", "M"] }],
        variations: expect.arrayContaining([
          expect.objectContaining({ options: { Size: "S" } }),
          expect.objectContaining({ options: { Size: "M" } }),
        ]),
      }),
    );
  });

  it("loads product data from the translation group", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const translationId = "22222222-2222-4222-8222-222222222222";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        urls.push(String(input));
        return jsonResponse({ ...catalog, sku: "sku001", regularAmount: "10.00", stock: 20 });
      }),
    );

    render(
      <MemoryRouter>
        <I18nProvider>
          <ProductCatalogFields
            contentId={translationId}
            translationGroupId={groupId}
            saveRef={{ current: null }}
            onDirtyChange={() => undefined}
          />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByDisplayValue("sku001")).toBeInTheDocument();
    expect(urls[0]).toContain(`/ext/justflows.shop/catalog/${translationId}`);
    expect(urls[0]).toContain(`group=${groupId}`);
    expect(screen.getByText(/SKU, prices, and stock are the same for every translation/)).toBeInTheDocument();
  });
});
