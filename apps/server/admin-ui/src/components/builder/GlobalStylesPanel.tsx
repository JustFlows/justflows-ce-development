// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { StylePreset } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import { useOptionalSessionRole } from "../SessionProvider";
import {
  deleteStylePreset,
  discardStylePresetDraft,
  fetchStylePresetUsage,
  publishStylePresets,
  saveStylePreset,
  useStylePresets,
  type StylePresetUsage,
} from "../../lib/style-presets";
import BlockLayoutPanel from "./BlockLayoutPanel";
import ThemeBlockControls from "./ThemeBlockControls";
import { THEME_PREVIEW_SCOPE, reloadThemePreviewStylesheet } from "./BlockPreview";
import { canManageStylePresets } from "./StylePresetPanel";
import type { BlockNode } from "./types";

/**
 * Global styles inside the builder (justflows-ce#301): the theme's design
 * tokens and the site's style presets, edited next to the page they affect.
 *
 * - Every token shows where its value comes from (the theme, or a change made
 *   for this site) and resets to the theme's value with one click.
 * - Changes preview on the canvas at once and are saved as the theme draft,
 *   which `/theme.css?preview=1` serves. Nothing reaches visitors until
 *   Publish, which publishes the tokens and the presets together.
 * - The tokens are site-wide, so the panel says what a change reaches.
 */

type ControlType = "color" | "font" | "text" | "image" | "range" | "code" | "select";
interface Control {
  label: string;
  type: ControlType;
  default: string | number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { label: string; value: string }[];
  description?: string;
}
interface Section {
  label: string;
  controls: Record<string, Control>;
}
type Mods = Record<string, Record<string, string | number> | undefined>;

/** Sections that are not design tokens; they keep their place in Appearance → Theme. */
const HIDDEN_SECTIONS = new Set(["identity", "navigation", "advanced"]);
const ORDER = ["colors", "colorsDark", "typography", "headings", "spacing", "radius", "shadow", "layout"];
const SAVE_DELAY_MS = 600;

/** The CSS custom property a control writes, or null when it is not a token. */
function tokenName(key: string): string | null {
  if (key.includes("__")) return null;
  if (key === "contentWidth") return "--max-width";
  if (key === "baseFontSize") return "--base-font-size";
  return key.startsWith("--") ? key : null;
}

/** Preview a token on every canvas surface of the right scheme, before the stylesheet reloads. */
function previewToken(section: string, name: string, css: string | null): void {
  const scheme = section === "colorsDark" ? "dark" : "light";
  for (const el of document.querySelectorAll<HTMLElement>(`.${THEME_PREVIEW_SCOPE}[data-theme="${scheme}"], .jf-shell__backdrop[data-theme="${scheme}"]`)) {
    if (css === null) el.style.removeProperty(name);
    else el.style.setProperty(name, css);
    if (name === "--base-font-size") {
      if (css === null) el.style.removeProperty("font-size");
      else el.style.fontSize = css;
    }
  }
}

function clearPreviewTokens(): void {
  for (const el of document.querySelectorAll<HTMLElement>(`.${THEME_PREVIEW_SCOPE}, .jf-shell__backdrop`)) {
    for (const name of Array.from(el.style)) {
      if (name.startsWith("--") || name === "font-size") el.style.removeProperty(name);
    }
  }
}

export default function GlobalStylesPanel() {
  const { t } = useT();
  const id = useId();
  const role = useOptionalSessionRole();
  const canManage = canManageStylePresets(role);
  const [schema, setSchema] = useState<Record<string, Section>>({});
  const [mods, setMods] = useState<Mods>({});
  const [published, setPublished] = useState<Mods>({});
  const [defaults, setDefaults] = useState<Mods>({});
  const [hasDraft, setHasDraft] = useState(false);
  const [open, setOpen] = useState<string>("colors");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error" | "publishing">("idle");
  const [error, setError] = useState("");
  const timer = useRef(0);
  const presetsState = useStylePresets();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/themes/customize");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? res.statusText);
      const data = (await res.json()) as { schema?: Record<string, Section>; mods?: Mods; published?: Mods; defaults?: Mods; hasDraft?: boolean };
      setSchema(data.schema ?? {});
      setMods(data.mods ?? {});
      setPublished(data.published ?? {});
      setDefaults(data.defaults ?? {});
      setHasDraft(Boolean(data.hasDraft));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      window.clearTimeout(timer.current);
      clearPreviewTokens();
    };
  }, [load]);

  const sections = useMemo(() => {
    const known = ORDER.filter((key) => schema[key]);
    const extra = Object.keys(schema).filter((key) => !ORDER.includes(key) && !HIDDEN_SECTIONS.has(key));
    return [...known, ...extra];
  }, [schema]);

  const persist = useCallback(
    async (next: Mods, publish = false) => {
      setStatus(publish ? "publishing" : "saving");
      setError("");
      try {
        const res = await fetch("/api/themes/customize", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mods: next, draft: !publish, publish }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; mods?: Mods };
        if (!res.ok) throw new Error(data.error ?? t("builder.globalStyles.saveError"));
        if (publish) {
          await publishStylePresets();
          setPublished(data.mods ?? next);
          setHasDraft(false);
        } else {
          setHasDraft(true);
        }
        clearPreviewTokens();
        reloadThemePreviewStylesheet();
        setStatus("saved");
        window.setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    },
    [t],
  );

  const update = (section: string, key: string, value: string | number) => {
    const control = schema[section]?.controls[key];
    const name = tokenName(key);
    if (control && name && !HIDDEN_SECTIONS.has(section)) {
      previewToken(section, name, control.type === "range" ? `${value}${control.unit ?? ""}` : String(value));
    }
    setMods((prev) => {
      const next = { ...prev, [section]: { ...(prev[section] ?? {}), [key]: value } };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void persist(next), SAVE_DELAY_MS);
      return next;
    });
  };

  const revert = () => {
    clearPreviewTokens();
    setMods(published);
    void persist(published);
    void discardStylePresetDraft().catch(() => {});
  };

  if (!canManage) {
    return <p className="jf-block-panel__hint jf-global-styles__locked">{t("builder.globalStyles.readOnly")}</p>;
  }

  const statusText =
    status === "saving"
      ? t("common.saving")
      : status === "publishing"
        ? t("themeCustomize.publishing")
        : status === "saved"
          ? `✓ ${t("common.saved")}`
          : "";
  const anyDraft = hasDraft || presetsState.hasDraft;

  return (
    <div className="jf-global-styles" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="jf-site-nav__heading">
        {t("builder.globalStyles.title")}
      </h2>
      <p className="jf-block-panel__hint">{t("builder.globalStyles.impact")}</p>
      <div className="jf-global-styles__bar">
        <span className="jf-global-styles__state" role="status" aria-live="polite">
          {statusText || (anyDraft ? t("builder.globalStyles.draftState") : t("builder.globalStyles.publishedState"))}
        </span>
        <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" disabled={!anyDraft || status === "publishing"} onClick={revert}>
          {t("builder.globalStyles.revert")}
        </button>
        <button type="button" className="jf-btn jf-btn--primary jf-btn--sm" disabled={!anyDraft || status === "publishing"} onClick={() => void persist(mods, true)}>
          {t("content.publish")}
        </button>
      </div>
      {error && (
        <p className="jf-block-panel__error" role="alert">
          {error}
        </p>
      )}

      {sections.map((sectionKey) => {
        const section = schema[sectionKey]!;
        const isOpen = open === sectionKey;
        const controls = Object.entries(section.controls).filter(([key, control]) => !key.includes("__") && control.type !== "image" && control.type !== "code");
        if (controls.length === 0) return null;
        const changed = controls.filter(([key]) => String(mods[sectionKey]?.[key] ?? "") !== String(defaults[sectionKey]?.[key] ?? "")).length;
        return (
          <div key={sectionKey} className="jf-accordion">
            <button type="button" className="jf-accordion__trigger" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? "" : sectionKey)}>
              <span className="jf-accordion__caret" aria-hidden="true">
                ▸
              </span>
              {section.label}
              {changed > 0 && <span className="jf-global-styles__count">{t("builder.globalStyles.changedCount", { count: changed })}</span>}
            </button>
            {isOpen && (
              <div className="jf-accordion__panel">
                {sectionKey === "colorsDark" && <p className="jf-field__hint">{t("themeCustomize.colorsDarkHint")}</p>}
                {controls.map(([key, control]) => (
                  <TokenField
                    key={key}
                    id={`${id}-${sectionKey}-${key}`}
                    control={control}
                    value={mods[sectionKey]?.[key] ?? control.default}
                    defaultValue={defaults[sectionKey]?.[key] ?? control.default}
                    publishedValue={published[sectionKey]?.[key] ?? defaults[sectionKey]?.[key] ?? control.default}
                    onChange={(value) => update(sectionKey, key, value)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <PresetLibrary presets={presetsState.presets} loaded={presetsState.loaded} />
    </div>
  );
}

function TokenField({
  id,
  control,
  value,
  defaultValue,
  publishedValue,
  onChange,
}: {
  id: string;
  control: Control;
  value: string | number;
  defaultValue: string | number;
  publishedValue: string | number;
  onChange: (value: string | number) => void;
}) {
  const { t } = useT();
  const isDefault = String(value) === String(defaultValue);
  const unpublished = String(value) !== String(publishedValue);
  const source = (
    <span className={`jf-responsive__source${isDefault ? "" : " jf-responsive__source--own"}`} id={`${id}-src`}>
      {isDefault ? t("builder.sources.themeDefault") : t("builder.sources.siteToken")}
      {unpublished ? ` · ${t("builder.globalStyles.unpublished")}` : ""}
    </span>
  );
  const reset = !isDefault && (
    <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" aria-label={t("builder.sources.resetToTheme", { field: control.label })} onClick={() => onChange(defaultValue)}>
      {t("builder.responsive.reset")}
    </button>
  );
  const describe = { "aria-describedby": `${id}-src` };

  let input: React.ReactNode;
  if (control.type === "color") {
    const hex = /^#[0-9a-fA-F]{6}$/.test(String(value)) ? String(value) : "#000000";
    input = (
      <div className="jf-row" style={{ flexWrap: "nowrap" }}>
        <input id={id} className="jf-swatch" type="color" value={hex} onChange={(e) => onChange(e.target.value)} {...describe} />
        <input className="jf-input jf-input--mono" type="text" value={String(value)} aria-label={t("themeCustomize.hexValueAriaLabel", { label: control.label })} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  } else if ((control.type === "font" || control.type === "select") && control.options) {
    input = (
      <select id={id} className="jf-input" value={String(value)} onChange={(e) => onChange(e.target.value)} {...describe}>
        {control.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  } else if (control.type === "range") {
    input = (
      <input id={id} type="range" min={control.min} max={control.max} step={control.step ?? 1} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} {...describe} />
    );
  } else {
    input = <input id={id} className="jf-input" type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} {...describe} />;
  }

  return (
    <div className="jf-field jf-global-styles__field">
      <label className="jf-field__label" htmlFor={id}>
        {control.label}
        {control.type === "range" ? `: ${value}${control.unit ?? ""}` : ""}
      </label>
      <div className="jf-responsive__row">
        {input}
        {reset || <span />}
        {source}
      </div>
    </div>
  );
}

/** The site's presets: usage, edit, delete. Edits go to the draft and show on the canvas at once. */
function PresetLibrary({ presets, loaded }: { presets: StylePreset[]; loaded: boolean }) {
  const { t } = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, StylePresetUsage | null>>({});
  const [error, setError] = useState("");

  const loadUsage = (presetId: string) => {
    if (usage[presetId] !== undefined) return;
    setUsage((prev) => ({ ...prev, [presetId]: null }));
    fetchStylePresetUsage(presetId)
      .then((u) => setUsage((prev) => ({ ...prev, [presetId]: u })))
      .catch(() => setUsage((prev) => ({ ...prev, [presetId]: { content: {}, templateParts: [], templates: [], reusableBlocks: 0, patterns: 0, total: 0 } })));
  };

  const usageText = (u: StylePresetUsage | null | undefined) => {
    if (u === undefined) return "";
    if (u === null) return t("builder.presets.usageLoading");
    if (u.total === 0) return t("builder.presets.usageNone");
    const parts: string[] = [];
    for (const [type, n] of Object.entries(u.content)) parts.push(`${n} × ${type}`);
    if (u.templateParts.length) parts.push(u.templateParts.join(", "));
    if (u.templates.length) parts.push(t("builder.presets.usageTemplates", { count: u.templates.length }));
    if (u.reusableBlocks) parts.push(t("builder.presets.usageReusable", { count: u.reusableBlocks }));
    if (u.patterns) parts.push(t("builder.presets.usagePatterns", { count: u.patterns }));
    return t("builder.presets.usage", { count: u.total, where: parts.join(" · ") });
  };

  async function remove(preset: StylePreset) {
    const u = usage[preset.id];
    const message = u && u.total > 0 ? t("builder.presets.deleteUsedConfirm", { name: preset.name, count: u.total }) : t("builder.presets.deleteConfirm", { name: preset.name });
    if (!window.confirm(message)) return;
    try {
      await deleteStylePreset(preset.id);
      reloadThemePreviewStylesheet();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="jf-global-styles__presets" aria-label={t("builder.presets.library")}>
      <h3 className="jf-site-nav__heading">{t("builder.presets.library")}</h3>
      <p className="jf-block-panel__hint">{t("builder.presets.libraryHint")}</p>
      {loaded && presets.length === 0 && <p className="jf-block-panel__hint">{t("builder.presets.empty")}</p>}
      {error && (
        <p className="jf-block-panel__error" role="alert">
          {error}
        </p>
      )}
      <ul className="jf-presets__list">
        {presets.map((preset) => (
          <li key={preset.id} className="jf-presets__item">
            <div className="jf-presets__row">
              <span className="jf-presets__name">
                {preset.name} <code className="jf-presets__id">{preset.id}</code>
              </span>
              <button
                type="button"
                className="jf-btn jf-btn--ghost jf-btn--sm"
                aria-expanded={editing === preset.id}
                onClick={() => {
                  setEditing(editing === preset.id ? null : preset.id);
                  loadUsage(preset.id);
                }}
              >
                {editing === preset.id ? t("builder.presets.done") : t("builder.presets.edit")}
              </button>
              <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" onClick={() => void remove(preset)} onFocus={() => loadUsage(preset.id)}>
                {t("builder.actions.delete")}
              </button>
            </div>
            {editing === preset.id && (
              <div className="jf-presets__editor">
                <p className="jf-block-panel__hint" aria-live="polite">
                  {usageText(usage[preset.id])}
                </p>
                <PresetEditor preset={preset} onError={setError} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Edits a preset with the same controls a block has, on a stand-in block. */
function PresetEditor({ preset, onError }: { preset: StylePreset; onError: (message: string) => void }) {
  const { t } = useT();
  const [name, setName] = useState(preset.name);
  const timer = useRef(0);
  const stand: BlockNode = useMemo(() => ({ id: `preset-${preset.id}`, type: "core.group", version: 1, props: { style: preset.style } }), [preset]);

  const save = (next: { name?: string; style?: Record<string, unknown> }) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveStylePreset({ id: preset.id, name: next.name ?? name, style: next.style ?? preset.style })
        .then(() => reloadThemePreviewStylesheet())
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
    }, SAVE_DELAY_MS);
  };

  return (
    <div>
      <label className="jf-block-panel__field">
        {t("builder.presets.name")}
        <input
          type="text"
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);
            if (e.target.value.trim()) save({ name: e.target.value.trim() });
          }}
        />
      </label>
      <BlockLayoutPanel block={stand} onChange={(props) => save({ style: (props.style as Record<string, unknown>) ?? {} })} />
      <ThemeBlockControls block={stand} onChange={(props) => save({ style: (props.style as Record<string, unknown>) ?? {} })} />
    </div>
  );
}
