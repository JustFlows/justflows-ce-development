import { createContext, useContext } from "react";

const TAG_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export const PRODUCT_TAG_INSERTS = [
  { tag: "{{title}}", label: "title" },
  { tag: "{{excerpt}}", label: "excerpt" },
  { tag: "{{price}}", label: "price" },
  { tag: "{{regularPrice}}", label: "regularPrice" },
  { tag: "{{salePrice}}", label: "salePrice" },
  { tag: "{{comparePrice}}", label: "comparePrice" },
  { tag: "{{sku}}", label: "sku" },
  { tag: "{{barcode}}", label: "barcode" },
  { tag: "{{stock}}", label: "stock" },
  { tag: "{{attributes}}", label: "attributes" },
  { tag: "{{weight}}", label: "weight" },
  { tag: "{{dimensions}}", label: "dimensions" },
] as const;

export function applyMergeTags(input: string, values: Record<string, string> | undefined): string {
  if (!values || !input.includes("{{")) return input;
  return input.replace(TAG_RE, (match, name: string) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : match;
  });
}

function setTag(values: Record<string, string>, name: string, value: string): void {
  values[name.toLowerCase()] = value;
}

export function catalogPreviewTags(
  catalog: {
    sku: string;
    barcode: string;
    regularAmount: string;
    saleAmount: string;
    taxClass: string;
    type: string;
    visibility: string;
    stock: number;
    trackInventory: boolean;
    weight: string;
    weightUnit: string;
    length: string;
    width: string;
    height: string;
    dimensionUnit: string;
    attributes: Array<{ name: string; valuesText?: string; values?: string[] }>;
  } | null | undefined,
  content: { title?: string; excerpt?: string | null },
): Record<string, string> {
  const values: Record<string, string> = {};
  const regular = catalog?.regularAmount.trim() ?? "";
  const sale = catalog?.saleAmount.trim() ?? "";
  const price = sale || regular;
  const parts = [catalog?.length, catalog?.width, catalog?.height].map((part) => (part ?? "").trim()).filter(Boolean);
  const dimensions = parts.length ? `${parts.join(" × ")}${catalog?.dimensionUnit ? ` ${catalog.dimensionUnit}` : ""}` : "";
  const attrs = (catalog?.attributes ?? [])
    .map((attr) => {
      const chips = (attr.values ?? (attr.valuesText ? attr.valuesText.split(",").map((item) => item.trim()).filter(Boolean) : []))
        .map((value, index) => `<span class="jf-product-swatch${index === 0 ? " jf-product-swatch--on" : ""}">${value}</span>`)
        .join("");
      return `<p class="jf-product-options__label">${attr.name}</p><div class="jf-product-swatches">${chips}</div>`;
    })
    .join("");
  setTag(values, "title", content.title ?? "");
  setTag(values, "excerpt", content.excerpt ?? "");
  setTag(values, "sku", catalog?.sku ?? "");
  setTag(values, "barcode", catalog?.barcode ?? "");
  setTag(values, "price", price);
  setTag(values, "regularPrice", regular);
  setTag(values, "regular_price", regular);
  setTag(values, "salePrice", sale);
  setTag(values, "sale_price", sale);
  setTag(values, "comparePrice", sale ? regular : "");
  setTag(values, "stock", catalog?.trackInventory ? String(catalog.stock) : "");
  setTag(values, "type", catalog?.type ?? "");
  setTag(values, "visibility", catalog?.visibility ?? "");
  setTag(values, "taxClass", catalog?.taxClass ?? "");
  setTag(values, "weight", catalog?.weight ?? "");
  setTag(values, "weightUnit", catalog?.weightUnit ?? "");
  setTag(values, "dimensions", dimensions);
  setTag(values, "attributes", attrs ? `<div class="jf-product-options">${attrs}</div>` : "");
  setTag(values, "options", values["attributes"] ?? "");
  return values;
}

export const ProductTagsContext = createContext<Record<string, string> | undefined>(undefined);

export function useProductTags(): Record<string, string> | undefined {
  return useContext(ProductTagsContext);
}
