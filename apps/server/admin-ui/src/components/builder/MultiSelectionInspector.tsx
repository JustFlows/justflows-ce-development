// SPDX-License-Identifier: MIT
import { isBlockLocked } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import BlockLayoutPanel from "./BlockLayoutPanel";
import { inspectorSections, type InspectorSections } from "./inspector-sections";
import { ACTION_SHORTCUTS } from "./BlockActionsMenu";
import type { ActionState, BlockAction } from "./block-actions";
import type { BlockCatalogEntry, BlockNode } from "./types";

const PANEL_ACTIONS: BlockAction[] = ["duplicate", "group", "resetStyle", "delete"];

function styleObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** A block whose schema owns `style` as a scalar variant cannot take generic style values. */
function takesGenericStyle(node: BlockNode, catalog: Map<string, BlockCatalogEntry>): boolean {
  return !catalog.get(node.type)?.schema?.style;
}

/**
 * Apply one style edit made on `primary` to every target: only the style
 * fields that changed are copied, so each block keeps its other values.
 */
export function applySharedStyle(
  primary: BlockNode,
  nextProps: Record<string, unknown>,
  targets: BlockNode[],
): Map<string, Record<string, unknown>> {
  const before = styleObject(primary.props.style);
  const after = styleObject(nextProps.style);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  const out = new Map<string, Record<string, unknown>>();
  for (const node of targets) {
    const style = styleObject(node.props.style);
    for (const key of changed) {
      if (after[key] === undefined || after[key] === "") delete style[key];
      else style[key] = after[key];
    }
    const props = { ...node.props };
    if (Object.keys(style).length > 0) props.style = style;
    else delete props.style;
    out.set(node.id, props);
  }
  return out;
}

/**
 * The inspector for several selected siblings (justflows-ce#298): what is
 * selected, the batch actions, and the style fields every selected block
 * supports. Edit-locked blocks and blocks with their own style setting are
 * left out of style changes, and the panel says so.
 */
export default function MultiSelectionInspector({
  nodes,
  catalog,
  states,
  onRun,
  onChangeProps,
}: {
  nodes: BlockNode[];
  catalog: Map<string, BlockCatalogEntry>;
  states: Record<BlockAction, ActionState>;
  onRun: (action: BlockAction) => void;
  onChangeProps: (changes: Map<string, Record<string, unknown>>) => void;
}) {
  const { t } = useT();
  const targets = nodes.filter((n) => !isBlockLocked(n, "edit") && takesGenericStyle(n, catalog));
  const primary = targets[0];
  const all = targets.map((n) => inspectorSections(n, catalog.get(n.type)));
  const shared: Pick<InspectorSections, "spacing" | "size" | "appearance" | "colors" | "field"> = {
    spacing: all.length > 0 && all.every((s) => s.spacing),
    size: all.length > 0 && all.every((s) => s.size),
    appearance: all.length > 0 && all.every((s) => s.appearance),
    colors: all.length > 0 && all.every((s) => s.colors),
    field: (name) => all.length > 0 && all.every((s) => s.field(name)),
  };
  const anyShared = shared.spacing || shared.size || shared.appearance || shared.colors;

  return (
    <div className="jf-inspector jf-inspector--multi">
      <div className="jf-inspector__title">{t("builder.actions.multi.title", { count: nodes.length })}</div>
      <ul className="jf-inspector__multi-list">
        {nodes.map((node) => (
          <li key={node.id}>
            {catalog.get(node.type)?.icon} {node.editor?.label || catalog.get(node.type)?.title || node.type}
          </li>
        ))}
      </ul>
      <div className="jf-inspector__multi-actions">
        {PANEL_ACTIONS.map((action) => {
          const state = states[action];
          return (
            <button
              key={action}
              type="button"
              className="jf-btn jf-btn--ghost jf-btn--sm"
              disabled={!state.ok}
              title={state.ok ? ACTION_SHORTCUTS[action] : t(`builder.actions.blocked.${state.reason}`)}
              onClick={() => onRun(action)}
            >
              {t(`builder.actions.${action}`)}
            </button>
          );
        })}
      </div>
      <p className="jf-block-panel__hint">{t("builder.actions.multi.menuHint")}</p>
      {primary && anyShared ? (
        <section aria-label={t("builder.actions.multi.sharedStyle")}>
          <h3 className="jf-inspector__subtitle">{t("builder.actions.multi.sharedStyle")}</h3>
          {targets.length < nodes.length && (
            <p className="jf-block-panel__hint">
              {t("builder.actions.multi.styleSubset", { count: targets.length, total: nodes.length })}
            </p>
          )}
          <BlockLayoutPanel
            key={primary.id}
            block={primary}
            sections={shared}
            onChange={(next) => onChangeProps(applySharedStyle(primary, next, targets))}
          />
        </section>
      ) : (
        <p className="jf-block-panel__hint">{t("builder.actions.multi.noSharedStyle")}</p>
      )}
    </div>
  );
}
