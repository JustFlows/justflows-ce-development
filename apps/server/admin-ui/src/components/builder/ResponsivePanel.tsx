// SPDX-License-Identifier: MIT
import { useId, useState } from "react";
import {
  ALIGN_SELF,
  BREAKPOINT_MAX_WIDTH,
  CONTAINER_ALIGN,
  CONTAINER_JUSTIFY,
  FONT_SIZE_PRESETS,
  SPACE_STEPS,
  TEXT_ALIGN,
  WIDTH_PRESETS,
  normalizeDeviceList,
  resolveResponsiveValue,
  sanitizeContainerLayout,
  setBreakpointValue,
  supportsContainerLayout,
  type BreakpointSource,
  type OverrideBreakpoint,
} from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import { SPACE_LABELS } from "./LayoutControls";
import { GRID_BLOCK_TYPE } from "./grid";
import type { BlockNode } from "./types";

/**
 * Breakpoint overrides for one block (justflows-ce#300).
 *
 * Previewing at a width and writing an override are separate: the toolbar
 * only changes what the canvas shows, and only this panel writes
 * `props.breakpoints`. Every field shows the value in effect at the chosen
 * breakpoint and where it comes from; Reset removes just that override.
 */

type Group = "style" | "containerLayout" | "gridPlacement" | "order";

interface FieldSpec {
  group: Group;
  field?: string;
  label: string;
  kind: "select" | "number";
  options?: readonly string[];
  min?: number;
  max?: number;
  format?: (value: unknown) => string;
}

export type ResponsiveWarning = "hidden" | "order" | "tinyText" | "tooWide" | "nowrap" | "tall" | "bigSpacing";

/** What an author should know about a block at a breakpoint before publishing. */
export function responsiveWarnings(block: BlockNode, bp: OverrideBreakpoint): ResponsiveWarning[] {
  const props = block.props;
  const out: ResponsiveWarning[] = [];
  const devices = normalizeDeviceList(props.devices) ?? [];
  if (devices.length > 0 && !devices.includes(bp as never)) out.push("hidden");
  if (resolveResponsiveValue(props, bp, "order").value !== undefined) out.push("order");
  const fontSize = resolveResponsiveValue<string>(props, bp, "style", "fontSize").value;
  if (fontSize === "xs" && bp === "mobile") out.push("tinyText");
  const maxWidth = resolveResponsiveValue<number>(props, bp, "style", "maxWidth").value;
  if (typeof maxWidth === "number" && maxWidth > BREAKPOINT_MAX_WIDTH[bp]) out.push("tooWide");
  const layout = sanitizeContainerLayout(props.containerLayout);
  if (layout?.display === "flex") {
    const direction = resolveResponsiveValue<string>(props, bp, "containerLayout", "direction").value ?? "row";
    const wrap = resolveResponsiveValue<string>(props, bp, "containerLayout", "wrap").value;
    const stacked = bp === "mobile" && layout.stack !== "never" && !breakpointsSet(props, "mobile", "direction");
    if (direction === "row" && wrap === "nowrap" && !stacked) out.push("nowrap");
  }
  const minHeight = resolveResponsiveValue<number>(props, bp, "style", "minHeight").value;
  if (bp === "mobile" && typeof minHeight === "number" && minHeight >= 90) out.push("tall");
  const big = ["padTop", "padBottom", "padX"].some((f) => {
    const v = resolveResponsiveValue<string>(props, bp, "style", f).value;
    return bp === "mobile" && (v === "7" || v === "8");
  });
  if (big) out.push("bigSpacing");
  return out;
}

function breakpointsSet(props: Record<string, unknown>, bp: OverrideBreakpoint, field: string): boolean {
  return resolveResponsiveValue(props, bp, "containerLayout", field).source === bp;
}

interface ResponsivePanelProps {
  block: BlockNode;
  onChange: (props: Record<string, unknown>) => void;
  /** The breakpoint the canvas is previewing; the panel starts there. */
  previewing: BreakpointSource;
  /** Switch the canvas preview to a breakpoint. */
  onPreview?: (bp: OverrideBreakpoint) => void;
  parentType?: string | null;
  parentLayout?: unknown;
}

export default function ResponsivePanel({ block, onChange, previewing, onPreview, parentType, parentLayout }: ResponsivePanelProps) {
  const { t } = useT();
  const id = useId();
  const [chosen, setChosen] = useState<OverrideBreakpoint | null>(null);
  const bp: OverrideBreakpoint = chosen ?? (previewing === "desktop" ? "tablet" : previewing);
  const props = block.props;
  const layout = sanitizeContainerLayout(props.containerLayout);
  const inLayout = Boolean(sanitizeContainerLayout(parentLayout)?.display) || parentType === GRID_BLOCK_TYPE;

  const layoutValue = (v: unknown) => t(`builder.layout.value.${String(v)}`);
  const modeValue = (v: unknown) => t(`builder.container.modes.${String(v)}`);
  const wrapValue = (v: unknown) => t(`builder.container.wrapValue.${String(v)}`);
  const justifyValue = (v: unknown) => t(`builder.container.justifyValue.${String(v)}`);
  const alignValue = (v: unknown) => t(`builder.container.alignValue.${String(v)}`);
  const fontSizeValue = (v: unknown) => t(`builder.responsive.fontSizeValue.${String(v)}`);
  const space = (v: unknown) => SPACE_LABELS[String(v)] ?? String(v);

  const fields: { heading: string; specs: FieldSpec[] }[] = [
    {
      heading: t("builder.responsive.spacing"),
      specs: (["padTop", "padBottom", "padX", "marginTop", "marginBottom"] as const).map((f) => ({
        group: "style" as const,
        field: f,
        label: t(`builder.layout.${f}`),
        kind: "select" as const,
        options: SPACE_STEPS.filter(Boolean),
        format: space,
      })),
    },
    {
      heading: t("builder.responsive.size"),
      specs: [
        { group: "style", field: "width", label: t("builder.layout.widthPreset"), kind: "select", options: WIDTH_PRESETS.filter(Boolean), format: layoutValue },
        { group: "style", field: "maxWidth", label: t("builder.layout.maxWidth"), kind: "number", min: 1, max: 10000 },
        { group: "style", field: "minHeight", label: t("builder.layout.minHeight"), kind: "number", min: 1, max: 100 },
      ],
    },
    {
      heading: t("builder.responsive.text"),
      specs: [
        { group: "style", field: "textAlign", label: t("builder.layout.textAlign"), kind: "select", options: TEXT_ALIGN.filter(Boolean), format: layoutValue },
        { group: "style", field: "fontSize", label: t("builder.responsive.fontSize"), kind: "select", options: FONT_SIZE_PRESETS.filter(Boolean), format: fontSizeValue },
      ],
    },
  ];
  if (inLayout) {
    fields.push({
      heading: t("builder.responsive.item"),
      specs: [
        { group: "style", field: "alignSelf", label: t("builder.layout.alignSelf"), kind: "select", options: ALIGN_SELF.filter(Boolean), format: layoutValue },
        ...(parentType === GRID_BLOCK_TYPE
          ? ([
              { group: "gridPlacement", field: "span", label: t("builder.responsive.span"), kind: "number", min: 1, max: 12 },
              { group: "gridPlacement", field: "col", label: t("builder.responsive.col"), kind: "number", min: 1, max: 12 },
            ] as FieldSpec[])
          : []),
        { group: "order", label: t("builder.responsive.order"), kind: "number", min: -20, max: 20 },
      ],
    });
  }
  if (supportsContainerLayout(block.type) && layout?.display) {
    const flex = layout.display === "flex";
    fields.push({
      heading: t("builder.container.title"),
      specs: [
        ...(flex
          ? ([
              { group: "containerLayout", field: "direction", label: t("builder.responsive.direction"), kind: "select", options: ["row", "column"], format: modeValue },
              { group: "containerLayout", field: "wrap", label: t("builder.container.wrap"), kind: "select", options: ["wrap", "nowrap"], format: wrapValue },
            ] as FieldSpec[])
          : ([{ group: "containerLayout", field: "columns", label: t("builder.container.columns"), kind: "number", min: 1, max: 12 }] as FieldSpec[])),
        { group: "containerLayout", field: "justify", label: t("builder.container.justify"), kind: "select", options: flex ? CONTAINER_JUSTIFY : ["start", "center", "end"], format: justifyValue },
        { group: "containerLayout", field: "align", label: t("builder.container.align"), kind: "select", options: CONTAINER_ALIGN, format: alignValue },
        { group: "containerLayout", field: "gap", label: t("builder.container.gap"), kind: "select", options: SPACE_STEPS.filter(Boolean), format: space },
      ],
    });
  }

  const warnings = responsiveWarnings(block, bp);
  const write = (spec: FieldSpec, value: unknown) => onChange(setBreakpointValue(props, bp, spec.group, spec.field, value));

  const row = (spec: FieldSpec) => {
    const resolved = resolveResponsiveValue(props, bp, spec.group, spec.field);
    const own = resolved.source === bp;
    const shown = resolved.value === undefined ? t("builder.layout.auto") : (spec.format ?? String)(resolved.value);
    const fieldId = `${id}-${spec.group}-${spec.field ?? "order"}`;
    const sourceText = own
      ? t("builder.responsive.setHere")
      : resolved.source
        ? t("builder.responsive.inherited", { value: shown, from: t(`builder.shell.breakpointLabel.${resolved.source}`) })
        : t("builder.responsive.notSet");
    return (
      <div key={fieldId} className="jf-responsive__row">
        <label className="jf-block-panel__field jf-block-panel__field--inline" htmlFor={fieldId}>
          {spec.label}
          {spec.kind === "select" ? (
            <select id={fieldId} value={own ? String(resolved.value) : ""} aria-describedby={`${fieldId}-src`} onChange={(e) => write(spec, e.target.value || undefined)}>
              <option value="">{t("builder.responsive.inherit", { value: shown })}</option>
              {spec.options!.map((option) => (
                <option key={option} value={option}>
                  {(spec.format ?? String)(option)}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={fieldId}
              type="number"
              min={spec.min}
              max={spec.max}
              placeholder={shown}
              value={own ? String(resolved.value) : ""}
              aria-describedby={`${fieldId}-src`}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") return write(spec, undefined);
                const n = Math.round(Number(raw));
                if (Number.isFinite(n) && n >= (spec.min ?? 0) && n <= (spec.max ?? 10000)) write(spec, n);
              }}
            />
          )}
        </label>
        <button
          type="button"
          className="jf-btn jf-btn--ghost jf-btn--sm"
          disabled={!own}
          aria-label={t("builder.responsive.resetField", { field: spec.label, breakpoint: t(`builder.shell.breakpointLabel.${bp}`) })}
          onClick={() => write(spec, undefined)}
        >
          {t("builder.responsive.reset")}
        </button>
        <span id={`${fieldId}-src`} className={`jf-responsive__source${own ? " jf-responsive__source--own" : ""}`}>
          {sourceText}
        </span>
      </div>
    );
  };

  return (
    <section className="jf-block-panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t("builder.responsive.title")}</h3>
      <div className="jf-responsive__bps" role="radiogroup" aria-label={t("builder.responsive.editing")}>
        {(["tablet", "mobile"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={bp === name}
            className={`jf-layout-modes__option${bp === name ? " is-active" : ""}`}
            onClick={() => setChosen(name)}
          >
            {t(`builder.shell.breakpointLabel.${name}`)} · ≤{BREAKPOINT_MAX_WIDTH[name]}px
          </button>
        ))}
      </div>
      <p className="jf-block-panel__hint">{t("builder.responsive.hint")}</p>
      {previewing !== bp && (
        <p className="jf-block-panel__hint">
          {t("builder.responsive.previewMismatch", {
            breakpoint: t(`builder.shell.breakpointLabel.${bp}`),
            previewing: t(`builder.shell.breakpointLabel.${previewing}`),
          })}{" "}
          {onPreview && (
            <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" onClick={() => onPreview(bp)}>
              {t("builder.responsive.previewAt", { breakpoint: t(`builder.shell.breakpointLabel.${bp}`) })}
            </button>
          )}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="jf-responsive__warnings" aria-label={t("builder.responsive.warningsTitle")}>
          {warnings.map((w) => (
            <li key={w}>{t(`builder.responsive.warning.${w}`)}</li>
          ))}
        </ul>
      )}
      {fields.map((group) => (
        <fieldset key={group.heading} className="jf-inspector-lock">
          <legend className="jf-inspector__subtitle">{group.heading}</legend>
          {group.specs.map(row)}
        </fieldset>
      ))}
    </section>
  );
}
