// SPDX-License-Identifier: MIT
import { useEffect, useId, useMemo, useState } from "react";
import { sanitizeTemplateDefaults, type TemplateDefaults } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import BlockLayoutPanel from "./BlockLayoutPanel";
import type { BlockCatalogEntry, BlockNode } from "./types";

/**
 * A template's style defaults (justflows-ce#301): per block type, the values
 * the content it wraps starts from. Edited with the same controls a block
 * has, on a stand-in block. Saved with the template.
 */
export default function TemplateDefaultsPanel({
  value,
  onChange,
  templateLabel,
}: {
  value: TemplateDefaults;
  onChange: (next: TemplateDefaults) => void;
  templateLabel: string;
}) {
  const { t } = useT();
  const id = useId();
  const [catalog, setCatalog] = useState<BlockCatalogEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  useEffect(() => {
    fetch("/api/blocks")
      .then((r) => r.json())
      .then((data: { blocks?: BlockCatalogEntry[] }) => setCatalog(data.blocks ?? []))
      .catch(() => setCatalog([]));
  }, []);

  const titleOf = (type: string) => catalog.find((b) => b.type === type)?.title ?? type;
  const types = useMemo(() => Object.keys(value).sort(), [value]);
  const addable = catalog.filter((b) => !value[b.type]).sort((a, b) => a.title.localeCompare(b.title));

  /**
   * Entries stay in the editor while they are empty, so a type just added can
   * be filled in; the save drops anything without values (`sanitizeTemplateDefaults`).
   */
  const write = (next: TemplateDefaults) => {
    const clean: TemplateDefaults = {};
    for (const [type, style] of Object.entries(next)) {
      clean[type] = sanitizeTemplateDefaults({ [type]: style })?.[type] ?? {};
    }
    onChange(clean);
  };
  const add = (type: string) => {
    if (!type) return;
    write({ ...value, [type]: {} });
    setOpen(type);
    setAdding("");
  };

  return (
    <section className="jf-field jf-template-defaults" aria-labelledby={`${id}-title`}>
      <label id={`${id}-title`} className="jf-field__label">
        {t("builder.templateDefaults.title")}
      </label>
      <p className="jf-field__hint" style={{ marginTop: 0 }}>
        {t("builder.templateDefaults.hint", { template: templateLabel })}
      </p>
      {types.length === 0 && <p className="jf-field__hint">{t("builder.templateDefaults.empty")}</p>}
      <ul className="jf-presets__list">
        {types.map((type) => {
          const stand: BlockNode = { id: `tpl-default-${type}`, type, version: 1, props: { style: value[type] } };
          const isOpen = open === type;
          return (
            <li key={type} className="jf-presets__item">
              <div className="jf-presets__row">
                <span className="jf-presets__name">
                  {titleOf(type)} <code className="jf-presets__id">{type}</code>
                </span>
                <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : type)}>
                  {isOpen ? t("builder.presets.done") : t("builder.presets.edit")}
                </button>
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost jf-btn--sm"
                  aria-label={t("builder.templateDefaults.remove", { type: titleOf(type) })}
                  onClick={() => {
                    const next = { ...value };
                    delete next[type];
                    write(next);
                  }}
                >
                  {t("builder.actions.delete")}
                </button>
              </div>
              {isOpen && (
                <div className="jf-presets__editor">
                  <BlockLayoutPanel
                    block={stand}
                    onChange={(props) => {
                      const style = props.style && typeof props.style === "object" ? (props.style as Record<string, unknown>) : {};
                      write({ ...value, [type]: style });
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <label className="jf-field__label" htmlFor={`${id}-add`} style={{ marginTop: "0.5rem" }}>
        {t("builder.templateDefaults.add")}
      </label>
      <select id={`${id}-add`} className="jf-input" value={adding} onChange={(e) => add(e.target.value)}>
        <option value="">{t("builder.templateDefaults.addPlaceholder")}</option>
        {addable.map((b) => (
          <option key={b.type} value={b.type}>
            {b.title}
          </option>
        ))}
      </select>
    </section>
  );
}
