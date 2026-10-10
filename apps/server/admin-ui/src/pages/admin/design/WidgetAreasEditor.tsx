import { useCallback, useEffect, useMemo, useState } from "react";
import PageBuilder, { type BlockDocument } from "@components/builder/PageBuilder";
import { useT } from "../../../i18n/I18nProvider";

type Position = "left" | "right" | "top";
type Blocks = BlockDocument["blocks"];

interface AreaSummary {
  key: string;
  label: string;
  description?: string;
  source: "core" | "theme" | "plugin";
  defaultLayout?: { contentTypes: string[]; position: Position };
  saved: boolean;
  hasDraft: boolean;
}

interface AreaDoc {
  version: 1;
  blocks: Blocks;
  locales: Record<string, Blocks>;
}

interface LayoutRule {
  area: string | null;
  position: Position;
}

interface ActiveLanguage {
  code: string;
  nativeName?: string;
}

const BASE_LOCALE = "";
/** Layout select value for "no saved rule": the plugin or theme default applies. */
const DEFAULT_RULE = "__default";
/** Layout select value for "show no widget area". */
const NO_AREA = "__none";

function emptyDoc(): AreaDoc {
  return { version: 1, blocks: [], locales: {} };
}

/**
 * The theme customizer's "Widgets" tab: fill each widget area with blocks
 * (base blocks plus optional per-language replacements) and choose which area
 * each content type shows, and on which side.
 */
export default function WidgetAreasEditor() {
  const { t } = useT();
  const [areas, setAreas] = useState<AreaSummary[]>([]);
  const [contentTypes, setContentTypes] = useState<Array<{ slug: string; label: string }>>([]);
  const [layout, setLayout] = useState<Record<string, LayoutRule>>({});
  const [languages, setLanguages] = useState<ActiveLanguage[]>([]);
  const [areaKey, setAreaKey] = useState("");
  const [doc, setDoc] = useState<AreaDoc>(emptyDoc);
  /** The area `doc` belongs to; the builder waits until it matches the selection. */
  const [loadedKey, setLoadedKey] = useState("");
  const [fromDefault, setFromDefault] = useState(false);
  const [locale, setLocale] = useState(BASE_LOCALE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "layoutSaved" | "error">("");
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => {
    const res = await fetch("/api/widgets");
    if (!res.ok) throw new Error(t("widgets.loadError"));
    const body = (await res.json()) as {
      areas?: AreaSummary[];
      layout?: Record<string, LayoutRule>;
      contentTypes?: Array<{ slug: string; label: string }>;
    };
    const list = body.areas ?? [];
    setAreas(list);
    setLayout(body.layout ?? {});
    setContentTypes(body.contentTypes ?? []);
    setAreaKey((current) => (list.some((area) => area.key === current) ? current : (list[0]?.key ?? "")));
  }, [t]);

  useEffect(() => {
    loadOverview()
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      })
      .finally(() => setLoading(false));
    fetch("/api/languages/active")
      .then((r) => r.json())
      .then((data: { languages?: ActiveLanguage[] }) => setLanguages(data.languages ?? []))
      .catch(() => setLanguages([]));
  }, [loadOverview]);

  useEffect(() => {
    if (!areaKey) return;
    let cancelled = false;
    setLoadedKey("");
    fetch(`/api/widgets/areas/${encodeURIComponent(areaKey)}`)
      .then((r) => r.json())
      .then((body: { doc?: AreaDoc; draft?: AreaDoc | null; fromDefault?: boolean }) => {
        if (cancelled) return;
        setDoc(body.draft ?? body.doc ?? emptyDoc());
        setFromDefault(Boolean(body.fromDefault) && !body.draft);
        setLocale(BASE_LOCALE);
        setStatus("");
        setLoadedKey(areaKey);
      })
      .catch(() => {
        if (cancelled) return;
        setDoc(emptyDoc());
        setLoadedKey(areaKey);
      });
    return () => {
      cancelled = true;
    };
  }, [areaKey]);

  const area = useMemo(() => areas.find((row) => row.key === areaKey) ?? null, [areas, areaKey]);
  const ready = Boolean(area) && loadedKey === areaKey;
  const overridden = locale !== BASE_LOCALE && Boolean(doc.locales[locale]);
  const editing: Blocks = locale === BASE_LOCALE ? doc.blocks : (doc.locales[locale] ?? doc.blocks);

  function onBlocksChange(next: BlockDocument) {
    setStatus("");
    setDoc((prev) =>
      locale === BASE_LOCALE
        ? { ...prev, blocks: next.blocks }
        : { ...prev, locales: { ...prev.locales, [locale]: next.blocks } },
    );
  }

  function resetLocale() {
    if (locale === BASE_LOCALE) return;
    setDoc((prev) => {
      const locales = { ...prev.locales };
      delete locales[locale];
      return { ...prev, locales };
    });
  }

  async function saveArea(publish: boolean) {
    if (!area || !ready) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch(`/api/widgets/areas/${encodeURIComponent(area.key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: doc.blocks, locales: doc.locales, draft: !publish }),
      });
      const body = (await res.json()) as { error?: string; doc?: AreaDoc };
      if (!res.ok) throw new Error(body.error ?? t("widgets.saveError"));
      if (body.doc) setDoc(body.doc);
      setFromDefault(false);
      setAreas((prev) =>
        prev.map((row) =>
          row.key === area.key ? { ...row, saved: row.saved || publish, hasDraft: !publish } : row,
        ),
      );
      setStatus("saved");
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      setSaving(false);
    }
  }

  function ruleValue(type: string): string {
    const rule = layout[type];
    if (!rule) return DEFAULT_RULE;
    return rule.area ?? NO_AREA;
  }

  function defaultFor(type: string): { area: AreaSummary; position: Position } | null {
    const match = areas.find((row) => row.defaultLayout?.contentTypes.includes(type));
    return match?.defaultLayout ? { area: match, position: match.defaultLayout.position } : null;
  }

  function positionLabel(position: Position): string {
    return t(`widgets.position.${position}`);
  }

  function setRuleArea(type: string, value: string) {
    setStatus("");
    setLayout((prev) => {
      const next = { ...prev };
      if (value === DEFAULT_RULE) {
        delete next[type];
        return next;
      }
      const position = prev[type]?.position ?? defaultFor(type)?.position ?? "right";
      next[type] = { area: value === NO_AREA ? null : value, position };
      return next;
    });
  }

  function setRulePosition(type: string, position: Position) {
    setStatus("");
    setLayout((prev) => (prev[type] ? { ...prev, [type]: { ...prev[type], position } } : prev));
  }

  async function saveLayout() {
    setLayoutSaving(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/widgets/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout }),
      });
      const body = (await res.json()) as { error?: string; layout?: Record<string, LayoutRule> };
      if (!res.ok) throw new Error(body.error ?? t("widgets.saveError"));
      setLayout(body.layout ?? {});
      setStatus("layoutSaved");
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      setLayoutSaving(false);
    }
  }

  if (loading) return <div className="jf-center">{t("widgets.loading")}</div>;

  return (
    <div className="jf-customizer">
      <aside
        className="jf-customizer__controls"
        style={{ padding: "1.1rem", display: "flex", flexDirection: "column", gap: "1.4rem" }}
      >
        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-widget-area">{t("widgets.areaLabel")}</label>
          <select
            id="jf-widget-area"
            className="jf-input"
            value={areaKey}
            onChange={(e) => setAreaKey(e.target.value)}
          >
            {areas.length === 0 && <option value="">{t("widgets.noAreas")}</option>}
            {areas.map((row) => (
              <option key={row.key} value={row.key}>
                {row.label}
                {row.hasDraft ? ` ${t("widgets.draftSuffix")}` : ""}
              </option>
            ))}
          </select>
          {area?.description && <p className="jf-field__hint">{area.description}</p>}
          {fromDefault && <p className="jf-field__hint">{t("widgets.fromDefaultHint")}</p>}
        </div>

        {ready && languages.length > 1 && (
          <div className="jf-field">
            <span className="jf-field__label">{t("widgets.language")}</span>
            <div
              role="tablist"
              aria-label={t("widgets.language")}
              style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={locale === BASE_LOCALE}
                className={`jf-btn jf-btn--sm ${locale === BASE_LOCALE ? "jf-btn--primary" : "jf-btn--ghost"}`}
                onClick={() => setLocale(BASE_LOCALE)}
              >
                {t("widgets.allLanguages")}
              </button>
              {languages.map((lang) => (
                <button
                  key={lang.code}
                  type="button"
                  role="tab"
                  aria-selected={locale === lang.code}
                  className={`jf-btn jf-btn--sm ${locale === lang.code ? "jf-btn--primary" : "jf-btn--ghost"}`}
                  onClick={() => setLocale(lang.code)}
                >
                  {lang.nativeName || lang.code}
                  {doc.locales[lang.code] ? " •" : ""}
                </button>
              ))}
            </div>
            {locale !== BASE_LOCALE && (
              <div
                className="jf-field__hint"
                style={{ display: "flex", flexDirection: "column", gap: "0.4rem", alignItems: "flex-start" }}
              >
                <span>{overridden ? t("widgets.overriddenHint") : t("widgets.inheritedHint")}</span>
                {overridden && (
                  <button type="button" className="jf-btn jf-btn--sm jf-btn--ghost" onClick={resetLocale}>
                    {t("widgets.resetToBase")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {ready && (
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="jf-btn jf-btn--ghost"
              style={{ flex: 1 }}
              disabled={saving}
              onClick={() => void saveArea(false)}
            >
              {saving ? t("common.saving") : t("content.saveDraft")}
            </button>
            <button
              type="button"
              className="jf-btn jf-btn--primary"
              style={{ flex: 1 }}
              disabled={saving}
              onClick={() => void saveArea(true)}
            >
              {t("content.publish")}
            </button>
          </div>
        )}
        {status === "saved" && (
          <span className="jf-field__hint" style={{ color: "var(--jf-success)" }}>✓ {t("common.saved")}</span>
        )}

        <div
          className="jf-field"
          style={{ paddingTop: "0.9rem", borderTop: "1px solid var(--jf-border)", gap: "0.75rem" }}
        >
          <span className="jf-field__label">{t("widgets.layoutHeading")}</span>
          <p className="jf-field__hint">{t("widgets.layoutHint")}</p>
          {contentTypes.map((type) => {
            const value = ruleValue(type.slug);
            const fallback = defaultFor(type.slug);
            const rule = layout[type.slug];
            return (
              <div key={type.slug} style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                <label className="jf-field__label" htmlFor={`jf-widget-type-${type.slug}`}>
                  {type.label}
                </label>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <select
                    id={`jf-widget-type-${type.slug}`}
                    className="jf-input"
                    style={{ flex: 2, minWidth: 0 }}
                    value={value}
                    onChange={(e) => setRuleArea(type.slug, e.target.value)}
                  >
                    <option value={DEFAULT_RULE}>
                      {fallback
                        ? t("widgets.defaultArea", {
                            area: fallback.area.label,
                            position: positionLabel(fallback.position),
                          })
                        : t("widgets.defaultNone")}
                    </option>
                    <option value={NO_AREA}>{t("widgets.noArea")}</option>
                    {areas.map((row) => (
                      <option key={row.key} value={row.key}>
                        {row.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="jf-input"
                    style={{ flex: 1, minWidth: 0 }}
                    aria-label={t("widgets.positionLabel", { type: type.label })}
                    value={rule?.position ?? fallback?.position ?? "right"}
                    disabled={!rule || rule.area === null}
                    onChange={(e) => setRulePosition(type.slug, e.target.value as Position)}
                  >
                    {(["left", "right", "top"] as const).map((position) => (
                      <option key={position} value={position}>
                        {positionLabel(position)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="jf-btn jf-btn--primary"
            disabled={layoutSaving}
            onClick={() => void saveLayout()}
          >
            {layoutSaving ? t("common.saving") : t("widgets.saveLayout")}
          </button>
          {status === "layoutSaved" && (
            <span className="jf-field__hint" style={{ color: "var(--jf-success)" }}>✓ {t("common.saved")}</span>
          )}
        </div>

        {status === "error" && (
          <span className="jf-field__hint" style={{ color: "var(--jf-danger)" }}>{error}</span>
        )}
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {ready && area ? (
          <PageBuilder
            key={`${area.key}:${locale}`}
            value={{ version: 1, blocks: editing }}
            onChange={onBlocksChange}
          />
        ) : (
          <div className="jf-center">{area ? t("widgets.loading") : t("widgets.noAreas")}</div>
        )}
      </div>
    </div>
  );
}
