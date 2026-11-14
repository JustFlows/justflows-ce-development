// SPDX-License-Identifier: MIT
import { useId } from "react";
import {
  BASIS_PRESETS,
  CONTAINER_ALIGN,
  CONTAINER_ELEMENTS,
  CONTAINER_ELEMENT_TYPES,
  CONTAINER_JUSTIFY,
  OVERFLOW_VALUES,
  SPACE_STEPS,
  compactBlockStyle,
  containerElementAllowed,
  parseBlockStyle,
  sanitizeContainerLayout,
  type BlockStyle,
  type ContainerLayout,
} from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import type { BlockNode } from "./types";

/**
 * Layout controls (justflows-ce#299): how a container arranges its children,
 * and how a block behaves inside a row. Every choice is a fixed option that
 * maps to the same classes on the canvas and the public page; nothing here
 * writes CSS. Visual order always follows source order.
 */

export type LayoutMode = "stack" | "row" | "column" | "grid";

/** Short names for the spacing steps, shared with the canvas handles. */
export const SPACE_LABELS: Record<string, string> = {
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

export function layoutMode(layout: ContainerLayout | undefined): LayoutMode {
  if (layout?.display === "grid") return "grid";
  if (layout?.display === "flex") return layout.direction === "column" ? "column" : "row";
  return "stack";
}

/** The layout after choosing a mode, keeping the settings that still apply. */
export function withLayoutMode(layout: ContainerLayout | undefined, mode: LayoutMode): ContainerLayout | undefined {
  const { display: _d, direction: _dir, wrap: _w, columns: _c, ...shared } = layout ?? {};
  if (mode === "stack") {
    const rest: ContainerLayout = {};
    if (shared.element) rest.element = shared.element;
    return Object.keys(rest).length ? rest : undefined;
  }
  if (mode === "grid") return { ...shared, display: "grid", columns: layout?.columns ?? 2 };
  return { ...shared, display: "flex", direction: mode === "column" ? "column" : "row", ...(layout?.wrap ? { wrap: layout.wrap } : {}) };
}

function writeLayout(block: BlockNode, layout: ContainerLayout | undefined): Record<string, unknown> {
  const props = { ...block.props };
  const clean = sanitizeContainerLayout(layout);
  if (clean) props.containerLayout = clean;
  else delete props.containerLayout;
  return props;
}

interface ContainerLayoutPanelProps {
  block: BlockNode;
  onChange: (props: Record<string, unknown>) => void;
  /** Elements the block's ancestors render as, outermost first, to refuse invalid nesting. */
  ancestorElements?: readonly string[];
}

export function ContainerLayoutPanel({ block, onChange, ancestorElements = [] }: ContainerLayoutPanelProps) {
  const { t } = useT();
  const id = useId();
  const layout = sanitizeContainerLayout(block.props.containerLayout);
  const mode = layoutMode(layout);
  const set = (patch: Partial<ContainerLayout>) => onChange(writeLayout(block, { ...layout, ...patch }));
  const unset = (key: keyof ContainerLayout) => {
    const next = { ...layout };
    delete next[key];
    onChange(writeLayout(block, next));
  };

  const choice = <K extends keyof ContainerLayout>(key: K, label: string, options: readonly string[], valueLabel: (v: string) => string) => (
    <label className="jf-block-panel__field jf-block-panel__field--inline">
      {label}
      <select
        value={String(layout?.[key] ?? "")}
        onChange={(e) => (e.target.value ? set({ [key]: e.target.value } as Partial<ContainerLayout>) : unset(key))}
      >
        <option value="">{t("builder.layout.auto")}</option>
        {options.map((value) => (
          <option key={value} value={value}>
            {valueLabel(value)}
          </option>
        ))}
      </select>
    </label>
  );

  const justifyOptions = mode === "grid" ? ["start", "center", "end"] : CONTAINER_JUSTIFY;
  const elementChoice = CONTAINER_ELEMENT_TYPES.has(block.type);

  return (
    <section className="jf-block-panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t("builder.container.title")}</h3>
      <div className="jf-layout-modes" role="radiogroup" aria-label={t("builder.container.mode")}>
        {(["stack", "row", "column", "grid"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={`jf-layout-modes__option${mode === value ? " is-active" : ""}`}
            onClick={() => onChange(writeLayout(block, withLayoutMode(layout, value)))}
          >
            <span aria-hidden="true" className={`jf-layout-modes__icon jf-layout-modes__icon--${value}`} />
            {t(`builder.container.modes.${value}`)}
          </button>
        ))}
      </div>
      <p className="jf-block-panel__hint">{t(`builder.container.modeHint.${mode}`)}</p>

      {mode === "grid" && (
        <label className="jf-block-panel__field jf-block-panel__field--inline">
          {t("builder.container.columns")}
          <input
            type="number"
            min={1}
            max={12}
            value={layout?.columns ?? 2}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1 && n <= 12) set({ columns: n });
            }}
          />
        </label>
      )}
      {mode !== "stack" && (
        <>
          {mode === "row" &&
            choice("wrap", t("builder.container.wrap"), ["wrap", "nowrap"], (v) => t(`builder.container.wrapValue.${v}`))}
          {choice("justify", t(mode === "column" ? "builder.container.justifyColumn" : "builder.container.justify"), justifyOptions, (v) =>
            t(`builder.container.justifyValue.${v}`),
          )}
          {choice("align", t(mode === "column" ? "builder.container.alignColumn" : "builder.container.align"), CONTAINER_ALIGN, (v) =>
            t(`builder.container.alignValue.${v}`),
          )}
          {choice("gap", t("builder.container.gap"), SPACE_STEPS.filter(Boolean), (v) => SPACE_LABELS[v] ?? v)}
          {(mode === "row" || mode === "grid") && (
            <label className="jf-block-panel__check">
              <input
                type="checkbox"
                checked={layout?.stack !== "never"}
                onChange={(e) => (e.target.checked ? unset("stack") : set({ stack: "never" }))}
              />
              {t("builder.container.stackOnPhones")}
            </label>
          )}
          <p className="jf-block-panel__hint">{t("builder.container.orderHint")}</p>
        </>
      )}
      {elementChoice && (
        <label className="jf-block-panel__field jf-block-panel__field--inline">
          {t("builder.container.element")}
          <select
            value={layout?.element ?? "div"}
            aria-describedby={`${id}-element-hint`}
            onChange={(e) => (e.target.value === "div" ? unset("element") : set({ element: e.target.value as ContainerLayout["element"] }))}
          >
            {CONTAINER_ELEMENTS.map((element) => {
              const allowed = containerElementAllowed(element, ancestorElements);
              return (
                <option key={element} value={element} disabled={!allowed}>
                  {t(`builder.container.elements.${element}`)}
                  {allowed ? "" : ` — ${t("builder.container.elementNotHere")}`}
                </option>
              );
            })}
          </select>
        </label>
      )}
      {elementChoice && (
        <p id={`${id}-element-hint`} className="jf-block-panel__hint">
          {t("builder.container.elementHint")}
        </p>
      )}
    </section>
  );
}

interface FlexItemPanelProps {
  block: BlockNode;
  onChange: (props: Record<string, unknown>) => void;
  /** The parent's layout; grow and share only apply inside a row or column. */
  parentLayout?: unknown;
}

/** How a block sits inside its parent's row, and what happens to content that does not fit. */
export function FlexItemPanel({ block, onChange, parentLayout }: FlexItemPanelProps) {
  const { t } = useT();
  const id = useId();
  const style = parseBlockStyle(block.props.style);
  const parent = sanitizeContainerLayout(parentLayout);
  const inFlex = parent?.display === "flex";
  const set = (patch: Partial<BlockStyle>) => {
    const props = { ...block.props };
    const next = compactBlockStyle(parseBlockStyle({ ...style, ...patch }));
    if (next) props.style = next;
    else delete props.style;
    onChange(props);
  };

  return (
    <section className="jf-block-panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t(inFlex ? "builder.container.item.title" : "builder.container.item.overflowTitle")}</h3>
      {inFlex && (
        <>
          <label className="jf-block-panel__field jf-block-panel__field--inline">
            {t("builder.container.item.basis")}
            <select value={style.basis} onChange={(e) => set({ basis: e.target.value })}>
              {BASIS_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {value === "" ? t("builder.layout.auto") : t(`builder.container.item.basisValue.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="jf-block-panel__check">
            <input type="checkbox" checked={style.grow === "1"} onChange={(e) => set({ grow: e.target.checked ? "1" : "" })} />
            {t("builder.container.item.grow")}
          </label>
        </>
      )}
      <label className="jf-block-panel__field jf-block-panel__field--inline">
        {t("builder.container.item.overflow")}
        <select value={style.overflow} onChange={(e) => set({ overflow: e.target.value })}>
          {OVERFLOW_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`builder.container.item.overflowValue.${value || "visible"}`)}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

/** The element a block renders as, for nesting checks: its chosen element, else its native one. */
export function renderedElement(node: BlockNode): string {
  const chosen = sanitizeContainerLayout(node.props.containerLayout)?.element;
  if (chosen) return chosen;
  return node.type === "core.section" ? "section" : "div";
}

/** Elements the ancestors of `id` render as, outermost first. */
export function ancestorElementsOf(blocks: BlockNode[], id: string): string[] {
  const walk = (list: BlockNode[], trail: BlockNode[]): BlockNode[] | null => {
    for (const node of list) {
      if (node.id === id) return trail;
      const found = node.children ? walk(node.children, [...trail, node]) : null;
      if (found) return found;
    }
    return null;
  };
  return (walk(blocks, []) ?? []).map(renderedElement);
}
