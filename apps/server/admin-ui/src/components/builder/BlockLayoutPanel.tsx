import {
  ALIGN_SELF,
  RADIUS_PRESETS,
  SHADOW_PRESETS,
  SPACE_STEPS,
  TEXT_ALIGN,
  WIDTH_PRESETS,
  compactBlockStyle,
  parseBlockStyle,
  type BlockStyle,
} from "@justflows/blocks";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import type { BlockNode } from "./types";
import { resolveStyleValue, setBreakpointValue, type BreakpointSource, type StylePreset } from "@justflows/blocks";

/** Whether a preset sets this field at all. */
function isPresetValue(presetStyle: BlockStyle, key: keyof BlockStyle): boolean {
  const value = presetStyle[key];
  return key === "vars" ? Object.keys(value as Record<string, string>).length > 0 : value !== "" && value !== 0;
}
import { readComputedBlockValues, type ComputedBlockValues } from "./computed-block-values";
import type { InspectorSections } from "./inspector-sections";

const EMPTY_COMPUTED: ComputedBlockValues = {
  background: "",
  textColor: "",
  accent: "",
  opacity: "",
  minHeight: "",
  maxWidth: "",
  maxHeight: "",
  textAlign: "",
  radius: "",
  shadow: "",
};

const ALL_SECTIONS = { spacing: true, size: true, appearance: true, colors: true, field: () => true };

const SPACE_LABELS: Record<string, string> = {
  "": "—",
  "0": "0",
  "1": "XXS",
  "2": "XS",
  "3": "S",
  "4": "M",
  "5": "L",
  "6": "XL",
  "7": "2XL",
  "8": "3XL",
};

/**
 * Spacing, size and alignment for any block.
 *
 * Every value is a step on the theme's scale rather than a raw length, so a
 * page keeps its rhythm and the whole site tightens up on a phone when the
 * scale does.
 *
 * `sections` hides the groups and fields a block does not offer; with none
 * left the panel renders nothing.
 */
export default function BlockLayoutPanel({
  block,
  onChange,
  sections = ALL_SECTIONS,
  preset = null,
  previewing = "desktop",
  templateLayer = null,
}: {
  block: BlockNode;
  onChange: (props: Record<string, unknown>) => void;
  sections?: Pick<InspectorSections, "spacing" | "size" | "appearance" | "colors" | "field">;
  /** The preset the block uses, so a value it supplies is labelled as such (justflows-ce#301). */
  preset?: StylePreset | null;
  /** The breakpoint the canvas previews, so an override there is labelled and can be reset. */
  previewing?: BreakpointSource;
  /** The template's default style for this block type, named after the template (justflows-ce#301). */
  templateLayer?: { name: string; style: Record<string, unknown> } | null;
}) {
  const { t } = useT();
  const style = parseBlockStyle(block.props.style);
  const presetStyle = preset ? parseBlockStyle(preset.style) : null;

  /**
   * Where a field's value comes from, and a reset for that layer only: a
   * breakpoint override resets to inheriting, a local value to the preset or
   * theme beneath it. Preset and theme values are read-only here.
   */
  const sourceNote = (key: keyof BlockStyle, label: string) => {
    const resolved = resolveStyleValue(block.props, key, preset, previewing, templateLayer?.style);
    let text: string;
    let reset: (() => void) | null = null;
    if (resolved.layer === "breakpoint-override") {
      text = t("builder.sources.breakpoint", { breakpoint: t(`builder.shell.breakpointLabel.${resolved.breakpoint}`) });
      reset = () => onChange(setBreakpointValue(block.props, resolved.breakpoint!, "style", key, undefined));
    } else if (resolved.layer === "local") {
      text = preset && presetStyle && isPresetValue(presetStyle, key) ? t("builder.sources.localOverPreset", { name: preset.name }) : t("builder.sources.local");
      reset = () => set({ [key]: typeof style[key] === "number" ? 0 : "" } as Partial<BlockStyle>);
    } else if (resolved.layer === "style-preset") {
      text = t("builder.sources.preset", { name: preset!.name });
    } else if (resolved.layer === "template-default") {
      text = t("builder.sources.template", { name: templateLayer!.name });
    } else {
      text = t("builder.sources.theme");
    }
    return (
      <span className={`jf-responsive__source${resolved.layer === "local" || resolved.layer === "breakpoint-override" ? " jf-responsive__source--own" : ""}`}>
        {text}
        {reset && (
          <>
            {" · "}
            <button type="button" className="jf-source-reset" aria-label={t("builder.sources.resetField", { field: label })} onClick={reset}>
              {t("builder.responsive.reset")}
            </button>
          </>
        )}
      </span>
    );
  };
  const [computed, setComputed] = useState<ComputedBlockValues>(EMPTY_COMPUTED);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let timer = 0;
    const read = () => {
      const element = [...document.querySelectorAll("[data-jf-block-preview]")].find(
        (candidate) => candidate.getAttribute("data-jf-block-preview") === block.id,
      );
      if (element && !cancelled) setComputed(readComputedBlockValues(element));
    };
    frame = requestAnimationFrame(read);
    timer = window.setTimeout(read, 250);
    const stylesheet = document.getElementById("jf-theme-preview-css");
    stylesheet?.addEventListener("load", read);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      stylesheet?.removeEventListener("load", read);
    };
  }, [block.id, block.props]);

  function set(patch: Partial<BlockStyle>) {
    const props = { ...block.props };
    const next = compactBlockStyle(parseBlockStyle({ ...style, ...patch }));
    if (next) props.style = next;
    else delete props.style;
    onChange(props);
  }

  const spaceField = (label: string, key: keyof BlockStyle) => (
    <div className="jf-source-field">
      <label className="jf-block-panel__field jf-block-panel__field--inline">
        {label}
        <select
          value={String(style[key])}
          onChange={(e) => set({ [key]: e.target.value } as Partial<BlockStyle>)}
        >
          {SPACE_STEPS.map((step) => (
            <option key={step} value={step}>
              {step === "" && presetStyle && presetStyle[key] ? `${t("builder.layout.auto")} · ${SPACE_LABELS[String(presetStyle[key])] ?? presetStyle[key]}` : (SPACE_LABELS[step] ?? step)}
            </option>
          ))}
        </select>
      </label>
      {sourceNote(key, label)}
    </div>
  );

  const choiceField = (
    label: string,
    key: keyof BlockStyle,
    options: readonly string[],
    inherited = "",
  ) => (
    <div className="jf-source-field">
      <label className="jf-block-panel__field jf-block-panel__field--inline">
        {label}
        <select
          value={String(style[key])}
          onChange={(e) => set({ [key]: e.target.value } as Partial<BlockStyle>)}
        >
          {options.map((value) => (
            <option key={value} value={value}>
              {value === ""
                ? inherited
                  ? `${t("builder.layout.auto")} · ${inherited}`
                  : "—"
                : t(`builder.layout.value.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {sourceNote(key, label)}
    </div>
  );

  // Uses the generic `.jf-field` markup, not `.jf-block-panel__field`, so the
  // panel's `input { width: 100% }` rule does not stretch the colour swatch.
  const clearBtnStyle: React.CSSProperties = {
    flexShrink: 0,
    height: 34,
    padding: "0 0.5rem",
    border: "1px solid var(--jf-border-strong)",
    borderRadius: "var(--jf-radius-sm)",
    background: "var(--jf-surface)",
    color: "var(--jf-text-3)",
    cursor: "pointer",
    fontSize: "0.8rem",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };

  const colorField = (label: string, key: "background" | "textColor" | "accent") => {
    const current = String(style[key] ?? "");
    const inherited = computed[key];
    const id = `${block.id}-${key}`;
    const swatch = /^#[0-9a-fA-F]{6}$/.test(current) ? current : inherited || "#ffffff";
    const isNone = current === "transparent" || current === "none";
    return (
      <div className="jf-field" style={{ marginBottom: "0.6rem" }}>
        <label className="jf-field__label" htmlFor={id}>
          {label}
        </label>
        <div className="jf-row" style={{ flexWrap: "nowrap" }}>
          <input
            id={id}
            type="color"
            className="jf-swatch"
            value={swatch}
            title={current || inherited || t("builder.layout.auto")}
            onChange={(e) => set({ [key]: e.target.value } as Partial<BlockStyle>)}
          />
          <input
            type="text"
            className="jf-input jf-input--mono"
            placeholder={
              inherited ? `${t("builder.layout.auto")} · ${inherited}` : t("builder.layout.auto")
            }
            value={current}
            spellCheck={false}
            onChange={(e) => set({ [key]: e.target.value } as Partial<BlockStyle>)}
          />
          {key === "background" ? (
            <button
              type="button"
              aria-pressed={isNone}
              onClick={() =>
                set({ background: isNone ? "" : "transparent" } as Partial<BlockStyle>)
              }
              style={{
                ...clearBtnStyle,
                background: isNone ? "var(--jf-accent-soft)" : "var(--jf-surface)",
                color: isNone ? "var(--jf-accent)" : "var(--jf-text-3)",
              }}
              title={t("builder.layout.transparentHint")}
            >
              {t("builder.layout.transparent")}
            </button>
          ) : null}
          {current && !isNone ? (
            <button
              type="button"
              aria-label={t("common.clearField", { label })}
              onClick={() => set({ [key]: "" } as Partial<BlockStyle>)}
              style={{ ...clearBtnStyle, width: 28, padding: 0, fontSize: "1rem" }}
            >
              ×
            </button>
          ) : null}
        </div>
        {sourceNote(key, label)}
      </div>
    );
  };

  if (!sections.spacing && !sections.size && !sections.appearance && !sections.colors) return null;

  return (
    <section className="jf-block-panel" aria-labelledby={`jf-layout-${block.id}`}>
      <h3 id={`jf-layout-${block.id}`}>{t("builder.layout.title")}</h3>
      <p className="jf-block-panel__hint">{t("builder.layout.hint")}</p>
      <p className="jf-block-panel__hint">{t("builder.layout.inheritedHint")}</p>

      {sections.spacing && <div className="jf-block-panel__grid2">
        {sections.field("padTop") && spaceField(t("builder.layout.padTop"), "padTop")}
        {sections.field("padBottom") && spaceField(t("builder.layout.padBottom"), "padBottom")}
        {sections.field("padX") && spaceField(t("builder.layout.padX"), "padX")}
        {sections.field("marginTop") && spaceField(t("builder.layout.marginTop"), "marginTop")}
        {sections.field("marginBottom") && spaceField(t("builder.layout.marginBottom"), "marginBottom")}
      </div>}

      {(sections.size || sections.appearance) && <div className="jf-block-panel__grid2">
        {sections.field("width") && choiceField(t("builder.layout.widthPreset"), "width", WIDTH_PRESETS)}
        {sections.field("alignSelf") && choiceField(t("builder.layout.alignSelf"), "alignSelf", ALIGN_SELF)}
        {sections.field("textAlign") && choiceField(t("builder.layout.textAlign"), "textAlign", TEXT_ALIGN, computed.textAlign)}
        {sections.field("radius") && choiceField(t("builder.layout.radius"), "radius", RADIUS_PRESETS, computed.radius)}
        {sections.field("shadow") && choiceField(t("builder.layout.shadow"), "shadow", SHADOW_PRESETS, computed.shadow)}
        {sections.field("minHeight") && <label className="jf-block-panel__field jf-block-panel__field--inline">
          {t("builder.layout.minHeight")}
          <input
            type="number"
            min={0}
            max={100}
            placeholder={computed.minHeight || t("builder.layout.auto")}
            value={style.minHeight || ""}
            onChange={(e) => set({ minHeight: Number(e.target.value) || 0 })}
          />
        </label>}
        {sections.field("maxWidth") && <label className="jf-block-panel__field jf-block-panel__field--inline">
          {t("builder.layout.maxWidth")}
          <input
            type="number"
            min={0}
            max={10000}
            placeholder={computed.maxWidth || t("builder.layout.auto")}
            value={style.maxWidth || ""}
            onChange={(e) => set({ maxWidth: Number(e.target.value) || 0 })}
          />
        </label>}
        {sections.field("maxHeight") && <label className="jf-block-panel__field jf-block-panel__field--inline">
          {t("builder.layout.maxHeight")}
          <input
            type="number"
            min={0}
            max={10000}
            placeholder={computed.maxHeight || t("builder.layout.auto")}
            value={style.maxHeight || ""}
            onChange={(e) => set({ maxHeight: Number(e.target.value) || 0 })}
          />
        </label>}
      </div>}

      {sections.colors && <div style={{ marginTop: "0.25rem" }}>
        {sections.field("background") && colorField(t("builder.layout.background"), "background")}
        {sections.field("textColor") && colorField(t("builder.layout.textColor"), "textColor")}
        {sections.field("accent") && colorField(t("builder.layout.accent"), "accent")}

        {sections.field("opacity") && <div className="jf-field" style={{ marginBottom: "0.6rem" }}>
          <label className="jf-field__label" htmlFor={`${block.id}-opacity`}>
            {t("builder.layout.opacity")}:{" "}
            {style.opacity
              ? `${style.opacity}%`
              : `${t("builder.layout.auto")}${computed.opacity ? ` · ${computed.opacity}` : ""}`}
          </label>
          <div className="jf-row" style={{ flexWrap: "nowrap" }}>
            <input
              id={`${block.id}-opacity`}
              type="range"
              min={0}
              max={100}
              step={5}
              value={style.opacity ? Number(style.opacity) : 100}
              onChange={(e) => {
                const v = Number(e.target.value);
                set({ opacity: v >= 100 ? "" : String(v) } as Partial<BlockStyle>);
              }}
            />
            {style.opacity ? (
              <button
                type="button"
                aria-label={t("common.clearField", { label: t("builder.layout.opacity") })}
                onClick={() => set({ opacity: "" } as Partial<BlockStyle>)}
                style={{ ...clearBtnStyle, width: 28, padding: 0, fontSize: "1rem" }}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>}
      </div>}
    </section>
  );
}
