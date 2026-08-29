import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/I18nProvider";

export type CatalogAttribute = {
  name: string;
  valuesText: string;
};

export type CatalogVariation = {
  id: string;
  enabled: boolean;
  sku: string;
  options: Record<string, string>;
  regularAmount: string;
  saleAmount: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  trackInventory: boolean;
  stock: number;
};

type CatalogProduct = {
  kind: "catalog";
  contentId: string;
  type: string;
  visibility: string;
  sku: string;
  barcode: string;
  regularAmount: string;
  saleAmount: string;
  saleStartsAt: string;
  saleEndsAt: string;
  costAmount: string;
  currency: string;
  precision: number;
  taxClass: string;
  shippingClass: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  trackInventory: boolean;
  stock: number;
  backorder: string;
  soldIndividually: boolean;
  minQty: number;
  maxQty: string;
  qtyStep: number;
  weightUnit: string;
  dimensionUnit: string;
  attributes: CatalogAttribute[];
  variations: CatalogVariation[];
  setupRequired?: boolean;
};

const PRODUCT_TYPES = ["simple", "variable", "virtual", "downloadable"] as const;
const VISIBILITIES = ["public", "hidden", "catalog-only", "search-only"] as const;
const BACKORDERS = ["disabled", "allowed", "notify"] as const;

function optionKey(options: Record<string, string>): string {
  return Object.keys(options)
    .sort()
    .map((key) => `${key}=${options[key]}`)
    .join("|");
}

function cartesian(attributes: Array<{ name: string; values: string[] }>): Record<string, string>[] {
  const usable = attributes.filter((attr) => attr.name.trim() && attr.values.length > 0);
  if (usable.length === 0) return [];
  return usable.reduce<Record<string, string>[]>(
    (combos, attr) => {
      const next: Record<string, string>[] = [];
      const names = combos.length > 0 ? combos : [{}];
      for (const combo of names) {
        for (const value of attr.values) {
          next.push({ ...combo, [attr.name]: value });
        }
      }
      return next;
    },
    [],
  );
}

function emptyVariation(options: Record<string, string>, draft: CatalogProduct): CatalogVariation {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    sku: "",
    options,
    regularAmount: draft.regularAmount,
    saleAmount: "",
    weight: draft.weight,
    length: draft.length,
    width: draft.width,
    height: draft.height,
    trackInventory: draft.trackInventory,
    stock: 0,
  };
}

function valuesFromInput(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function toApiAttributes(attributes: CatalogAttribute[]): Array<{ name: string; values: string[] }> {
  return attributes.map((attr) => ({ name: attr.name, values: valuesFromInput(attr.valuesText) }));
}

function fromApiAttributes(raw: Array<{ name: string; values: string[] }> | undefined): CatalogAttribute[] {
  return (raw ?? []).map((attr) => ({ name: attr.name, valuesText: attr.values.join(", ") }));
}

function toDatetimeLocal(raw: string): string {
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return match ? `${match[1]}T${match[2]}` : "";
}

type CatalogApi = Omit<CatalogProduct, "attributes"> & {
  attributes?: Array<{ name: string; values: string[] }>;
  error?: string;
};

function hydrateCatalog(data: CatalogApi): CatalogProduct {
  const { error: _error, attributes, ...rest } = data;
  return {
    ...rest,
    saleStartsAt: toDatetimeLocal(rest.saleStartsAt),
    saleEndsAt: toDatetimeLocal(rest.saleEndsAt),
    attributes: fromApiAttributes(attributes),
  };
}

function variationLabel(options: Record<string, string>): string {
  const parts = Object.entries(options).map(([name, value]) => (name ? `${name}: ${value}` : value));
  return parts.join(" · ") || "—";
}

function fallbackCatalog(contentId: string): CatalogProduct {
  return {
    kind: "catalog",
    contentId,
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
}

function catalogPutBody(draft: CatalogProduct): Record<string, unknown> {
  return { ...draft, attributes: toApiAttributes(draft.attributes) };
}

function catalogUrl(contentId: string | null, translationGroupId?: string | null): string {
  if (!contentId) return "/ext/justflows.shop/catalog";
  const path = `/ext/justflows.shop/catalog/${encodeURIComponent(contentId)}`;
  const group = translationGroupId && translationGroupId.trim() ? translationGroupId : contentId;
  return `${path}?group=${encodeURIComponent(group)}`;
}

export default function ProductCatalogFields({
  contentId,
  translationGroupId,
  saveRef,
  payloadRef,
  onDirtyChange,
  onDraftChange,
}: {
  contentId: string | null;
  translationGroupId?: string | null;
  saveRef: MutableRefObject<(() => Promise<boolean>) | null>;
  payloadRef?: MutableRefObject<unknown>;
  onDirtyChange: (dirty: boolean) => void;
  onDraftChange?: (draft: CatalogProduct | null) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<CatalogProduct | null>(null);
  const [baseline, setBaseline] = useState("");
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () => Boolean(draft) && JSON.stringify(draft) !== baseline,
    [draft, baseline],
  );

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  useEffect(() => {
    if (payloadRef) payloadRef.current = draft ? catalogPutBody(draft) : null;
  }, [draft, payloadRef]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMissing(false);
    setError(null);
    const fallback = fallbackCatalog(contentId ?? "");
    const url = catalogUrl(contentId, translationGroupId);
    fetch(url)
      .then(async (res) => {
        if (res.status === 401) {
          if (!cancelled) setMissing(true);
          return;
        }
        if (!res.ok) {
          if (!cancelled) {
            setDraft(fallback);
            setBaseline(JSON.stringify(fallback));
          }
          return;
        }
        const data = (await res.json()) as CatalogApi;
        if (cancelled) return;
        if (data.kind !== "catalog") {
          setDraft(fallback);
          setBaseline(JSON.stringify(fallback));
          return;
        }
        const next = hydrateCatalog(data);
        setDraft(next);
        setBaseline(JSON.stringify(next));
      })
      .catch(() => {
        if (!cancelled) {
          setDraft(fallback);
          setBaseline(JSON.stringify(fallback));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contentId, translationGroupId]);

  useEffect(() => {
    saveRef.current = async () => {
      if (!draft || missing) return true;
      if (!contentId) return true;
      if (JSON.stringify(draft) === baseline) return true;
      setError(null);
      try {
        const res = await fetch(catalogUrl(contentId, translationGroupId), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(catalogPutBody(draft)),
        });
        const data = (await res.json()) as CatalogApi;
        if (!res.ok || data.kind !== "catalog") {
          setError(data.error ?? t("shop.saveFailed"));
          return false;
        }
        const next = hydrateCatalog(data);
        setDraft(next);
        setBaseline(JSON.stringify(next));
        return true;
      } catch {
        setError(t("shop.saveFailed"));
        return false;
      }
    };
    return () => {
      saveRef.current = null;
    };
  }, [draft, baseline, contentId, translationGroupId, missing, saveRef, t]);

  function patch(changes: Partial<CatalogProduct>) {
    setDraft((prev) => (prev ? { ...prev, ...changes } : prev));
  }

  function generateVariations() {
    if (!draft) return;
    const combos = cartesian(toApiAttributes(draft.attributes));
    const existing = new Map(draft.variations.map((row) => [optionKey(row.options), row]));
    patch({
      variations: combos.map(
        (options) => existing.get(optionKey(options)) ?? emptyVariation(options, draft),
      ),
    });
  }

  function patchVariation(index: number, changes: Partial<CatalogVariation>) {
    if (!draft) return;
    const variations = draft.variations.slice();
    variations[index] = { ...variations[index], ...changes };
    patch({ variations });
  }

  if (loading) {
    return (
      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">{t("shop.productData")}</h2>
        </div>
        <div className="jf-card__body">
          <div className="jf-skeleton" style={{ height: 120 }} />
        </div>
      </div>
    );
  }

  if (missing || !draft) return null;

  const physical = draft.type === "simple" || draft.type === "variable";
  const showVariations = draft.type === "variable";

  return (
    <div className="jf-card">
      <div className="jf-card__head">
        <h2 className="jf-card__title">{t("shop.productData")}</h2>
      </div>
      <div className="jf-card__body jf-product-body">
        <p className="jf-field__hint" style={{ margin: 0 }}>
          {t("shop.sharedAcrossTranslations")}
        </p>
        {draft.setupRequired && (
          <p className="jf-field__hint" style={{ margin: 0 }}>
            {t("shop.setupRequired")}{" "}
            <Link to="/admin/shop">{t("shop.openSetup")}</Link>
          </p>
        )}
        {error && (
          <div className="jf-alert jf-alert--error" role="alert">
            {error}
          </div>
        )}

        <section className="jf-product-section">
          <h3 className="jf-card__title">{t("shop.pricing")}</h3>
          <div className="jf-grid jf-grid--2">
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-type">
                {t("shop.productType")}
              </label>
              <select
                id="jf-product-type"
                className="jf-input"
                value={draft.type}
                onChange={(e) => patch({ type: e.target.value })}
              >
                {PRODUCT_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`shop.types.${value}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-visibility">
                {t("shop.visibility")}
              </label>
              <select
                id="jf-product-visibility"
                className="jf-input"
                value={draft.visibility}
                onChange={(e) => patch({ visibility: e.target.value })}
              >
                {VISIBILITIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`shop.visibilities.${value}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-sku">
                {t("shop.sku")}
              </label>
              <input
                id="jf-product-sku"
                className="jf-input"
                value={draft.sku}
                onChange={(e) => patch({ sku: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-barcode">
                {t("shop.barcode")}
              </label>
              <input
                id="jf-product-barcode"
                className="jf-input"
                value={draft.barcode}
                onChange={(e) => patch({ barcode: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-regular">
                {t("shop.regularPrice")} ({draft.currency})
              </label>
              <input
                id="jf-product-regular"
                className="jf-input"
                inputMode="decimal"
                value={draft.regularAmount}
                onChange={(e) => patch({ regularAmount: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-sale">
                {t("shop.salePrice")} ({draft.currency})
              </label>
              <input
                id="jf-product-sale"
                className="jf-input"
                inputMode="decimal"
                value={draft.saleAmount}
                onChange={(e) => patch({ saleAmount: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-sale-start">
                {t("shop.saleStarts")}
              </label>
              <input
                id="jf-product-sale-start"
                className="jf-input"
                type="datetime-local"
                value={draft.saleStartsAt}
                onChange={(e) => patch({ saleStartsAt: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-sale-end">
                {t("shop.saleEnds")}
              </label>
              <input
                id="jf-product-sale-end"
                className="jf-input"
                type="datetime-local"
                value={draft.saleEndsAt}
                onChange={(e) => patch({ saleEndsAt: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-cost">
                {t("shop.cost")} ({draft.currency})
              </label>
              <input
                id="jf-product-cost"
                className="jf-input"
                inputMode="decimal"
                value={draft.costAmount}
                onChange={(e) => patch({ costAmount: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-tax">
                {t("shop.taxClass")}
              </label>
              <input
                id="jf-product-tax"
                className="jf-input"
                value={draft.taxClass}
                onChange={(e) => patch({ taxClass: e.target.value })}
              />
            </div>
          </div>
        </section>

        <section className="jf-product-section">
          <h3 className="jf-card__title">{t("shop.inventory")}</h3>
          <label className="jf-checkrow">
            <input
              type="checkbox"
              checked={draft.trackInventory}
              onChange={(e) => patch({ trackInventory: e.target.checked })}
            />
            {t("shop.trackInventory")}
          </label>
          <div className="jf-grid jf-grid--2">
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-stock">
                {t("shop.stock")}
              </label>
              <input
                id="jf-product-stock"
                className="jf-input"
                type="number"
                min={0}
                disabled={!draft.trackInventory || showVariations}
                value={draft.stock}
                onChange={(e) => patch({ stock: Number(e.target.value) || 0 })}
              />
              {showVariations && <span className="jf-field__hint">{t("shop.stockOnVariations")}</span>}
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-backorder">
                {t("shop.backorder")}
              </label>
              <select
                id="jf-product-backorder"
                className="jf-input"
                value={draft.backorder}
                onChange={(e) => patch({ backorder: e.target.value })}
              >
                {BACKORDERS.map((value) => (
                  <option key={value} value={value}>
                    {t(`shop.backorders.${value}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-min">
                {t("shop.minQty")}
              </label>
              <input
                id="jf-product-min"
                className="jf-input"
                type="number"
                min={1}
                value={draft.minQty}
                onChange={(e) => patch({ minQty: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-max">
                {t("shop.maxQty")}
              </label>
              <input
                id="jf-product-max"
                className="jf-input"
                inputMode="numeric"
                value={draft.maxQty}
                onChange={(e) => patch({ maxQty: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-product-step">
                {t("shop.qtyStep")}
              </label>
              <input
                id="jf-product-step"
                className="jf-input"
                type="number"
                min={1}
                value={draft.qtyStep}
                onChange={(e) => patch({ qtyStep: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
          </div>
          <label className="jf-checkrow">
            <input
              type="checkbox"
              checked={draft.soldIndividually}
              onChange={(e) => patch({ soldIndividually: e.target.checked })}
            />
            {t("shop.soldIndividually")}
          </label>
        </section>

        {physical && (
          <section className="jf-product-section">
            <h3 className="jf-card__title">{t("shop.shipping")}</h3>
            <div className="jf-grid jf-grid--2">
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-product-weight">
                  {t("shop.weight")} ({draft.weightUnit})
                </label>
                <input
                  id="jf-product-weight"
                  className="jf-input"
                  inputMode="decimal"
                  value={draft.weight}
                  onChange={(e) => patch({ weight: e.target.value })}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-product-ship-class">
                  {t("shop.shippingClass")}
                </label>
                <input
                  id="jf-product-ship-class"
                  className="jf-input"
                  value={draft.shippingClass}
                  onChange={(e) => patch({ shippingClass: e.target.value })}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-product-length">
                  {t("shop.length")} ({draft.dimensionUnit})
                </label>
                <input
                  id="jf-product-length"
                  className="jf-input"
                  inputMode="decimal"
                  value={draft.length}
                  onChange={(e) => patch({ length: e.target.value })}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-product-width">
                  {t("shop.width")} ({draft.dimensionUnit})
                </label>
                <input
                  id="jf-product-width"
                  className="jf-input"
                  inputMode="decimal"
                  value={draft.width}
                  onChange={(e) => patch({ width: e.target.value })}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-product-height">
                  {t("shop.height")} ({draft.dimensionUnit})
                </label>
                <input
                  id="jf-product-height"
                  className="jf-input"
                  inputMode="decimal"
                  value={draft.height}
                  onChange={(e) => patch({ height: e.target.value })}
                />
              </div>
            </div>
          </section>
        )}

        {showVariations && (
          <section className="jf-product-section">
            <h3 className="jf-card__title">{t("shop.attributes")}</h3>
            <p className="jf-field__hint" style={{ margin: 0 }}>
              {t("shop.generateHint")}
            </p>
            {draft.attributes.map((attr, index) => (
              <div key={`attr-${index}`} className="jf-product-attr">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor={`jf-attr-name-${index}`}>
                    {t("shop.attributeName")}
                  </label>
                  <input
                    id={`jf-attr-name-${index}`}
                    className="jf-input"
                    value={attr.name}
                    onChange={(e) => {
                      const attributes = draft.attributes.slice();
                      attributes[index] = { ...attr, name: e.target.value };
                      patch({ attributes });
                    }}
                  />
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor={`jf-attr-values-${index}`}>
                    {t("shop.attributeValues")}
                  </label>
                  <input
                    id={`jf-attr-values-${index}`}
                    className="jf-input"
                    value={attr.valuesText}
                    onChange={(e) => {
                      const attributes = draft.attributes.slice();
                      attributes[index] = { ...attr, valuesText: e.target.value };
                      patch({ attributes });
                    }}
                  />
                  <span className="jf-field__hint">{t("shop.attributeValuesHint")}</span>
                </div>
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost jf-product-attr__remove"
                  onClick={() =>
                    patch({ attributes: draft.attributes.filter((_, itemIndex) => itemIndex !== index) })
                  }
                >
                  {t("shop.removeAttribute")}
                </button>
              </div>
            ))}
            <div className="jf-product-actions">
              <button
                type="button"
                className="jf-btn jf-btn--ghost"
                onClick={() => patch({ attributes: [...draft.attributes, { name: "", valuesText: "" }] })}
              >
                {t("shop.addAttribute")}
              </button>
              <button type="button" className="jf-btn jf-btn--ghost" onClick={generateVariations}>
                {t("shop.generateVariations")}
              </button>
            </div>
          </section>
        )}

        {showVariations && (
          <section className="jf-product-section">
            <h3 className="jf-card__title">{t("shop.variations")}</h3>
            {draft.variations.length === 0 ? (
              <p className="jf-field__hint" style={{ margin: 0 }}>
                {t("shop.noVariations")}
              </p>
            ) : (
              <div className="jf-product-variations">
                {draft.variations.map((variation, index) => (
                  <article key={variation.id} className="jf-product-variation">
                    <div className="jf-product-variation__head">
                      <label className="jf-checkrow">
                        <input
                          type="checkbox"
                          checked={variation.enabled}
                          aria-label={t("shop.variationEnabled")}
                          onChange={(e) => patchVariation(index, { enabled: e.target.checked })}
                        />
                        <span className="jf-product-variation__title">{variationLabel(variation.options)}</span>
                      </label>
                      <button
                        type="button"
                        className="jf-btn jf-btn--quiet"
                        onClick={() =>
                          patch({
                            variations: draft.variations.filter((_, itemIndex) => itemIndex !== index),
                          })
                        }
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                    <div className="jf-grid jf-grid--2">
                      <div className="jf-field">
                        <label className="jf-field__label" htmlFor={`jf-var-sku-${variation.id}`}>
                          {t("shop.sku")}
                        </label>
                        <input
                          id={`jf-var-sku-${variation.id}`}
                          className="jf-input"
                          value={variation.sku}
                          onChange={(e) => patchVariation(index, { sku: e.target.value })}
                        />
                      </div>
                      <div className="jf-field">
                        <label className="jf-field__label" htmlFor={`jf-var-stock-${variation.id}`}>
                          {t("shop.stock")}
                        </label>
                        <input
                          id={`jf-var-stock-${variation.id}`}
                          className="jf-input"
                          type="number"
                          min={0}
                          disabled={!variation.trackInventory}
                          value={variation.stock}
                          onChange={(e) => patchVariation(index, { stock: Number(e.target.value) || 0 })}
                        />
                      </div>
                      <div className="jf-field">
                        <label className="jf-field__label" htmlFor={`jf-var-regular-${variation.id}`}>
                          {t("shop.regularPrice")} ({draft.currency})
                        </label>
                        <input
                          id={`jf-var-regular-${variation.id}`}
                          className="jf-input"
                          inputMode="decimal"
                          value={variation.regularAmount}
                          onChange={(e) => patchVariation(index, { regularAmount: e.target.value })}
                        />
                      </div>
                      <div className="jf-field">
                        <label className="jf-field__label" htmlFor={`jf-var-sale-${variation.id}`}>
                          {t("shop.salePrice")} ({draft.currency})
                        </label>
                        <input
                          id={`jf-var-sale-${variation.id}`}
                          className="jf-input"
                          inputMode="decimal"
                          value={variation.saleAmount}
                          onChange={(e) => patchVariation(index, { saleAmount: e.target.value })}
                        />
                      </div>
                      {physical && (
                        <>
                          <div className="jf-field">
                            <label className="jf-field__label" htmlFor={`jf-var-weight-${variation.id}`}>
                              {t("shop.weight")} ({draft.weightUnit})
                            </label>
                            <input
                              id={`jf-var-weight-${variation.id}`}
                              className="jf-input"
                              inputMode="decimal"
                              value={variation.weight}
                              onChange={(e) => patchVariation(index, { weight: e.target.value })}
                            />
                          </div>
                          <div className="jf-field">
                            <label className="jf-field__label" htmlFor={`jf-var-length-${variation.id}`}>
                              {t("shop.length")} ({draft.dimensionUnit})
                            </label>
                            <input
                              id={`jf-var-length-${variation.id}`}
                              className="jf-input"
                              inputMode="decimal"
                              value={variation.length}
                              onChange={(e) => patchVariation(index, { length: e.target.value })}
                            />
                          </div>
                          <div className="jf-field">
                            <label className="jf-field__label" htmlFor={`jf-var-width-${variation.id}`}>
                              {t("shop.width")} ({draft.dimensionUnit})
                            </label>
                            <input
                              id={`jf-var-width-${variation.id}`}
                              className="jf-input"
                              inputMode="decimal"
                              value={variation.width}
                              onChange={(e) => patchVariation(index, { width: e.target.value })}
                            />
                          </div>
                          <div className="jf-field">
                            <label className="jf-field__label" htmlFor={`jf-var-height-${variation.id}`}>
                              {t("shop.height")} ({draft.dimensionUnit})
                            </label>
                            <input
                              id={`jf-var-height-${variation.id}`}
                              className="jf-input"
                              inputMode="decimal"
                              value={variation.height}
                              onChange={(e) => patchVariation(index, { height: e.target.value })}
                            />
                          </div>
                        </>
                      )}
                    </div>
                    <label className="jf-checkrow">
                      <input
                        type="checkbox"
                        checked={variation.trackInventory}
                        onChange={(e) => patchVariation(index, { trackInventory: e.target.checked })}
                      />
                      {t("shop.trackInventory")}
                    </label>
                  </article>
                ))}
              </div>
            )}
            <button
              type="button"
              className="jf-btn jf-btn--ghost"
              onClick={() =>
                patch({
                  variations: [...draft.variations, emptyVariation({}, draft)],
                })
              }
            >
              {t("shop.addVariation")}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
