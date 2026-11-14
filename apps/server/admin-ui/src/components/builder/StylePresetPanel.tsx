// SPDX-License-Identifier: MIT
import { useId, useState } from "react";
import { compactBlockStyle, parseBlockStyle, presetRefOf, sanitizeStyleRef } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import { useOptionalSessionRole } from "../SessionProvider";
import { presetIdFromName, saveStylePreset, useStylePresets } from "../../lib/style-presets";
import { reloadThemePreviewStylesheet } from "./BlockPreview";
import type { BlockNode } from "./types";

/** Whether the role may change the preset library; the server enforces the same roles. */
export function canManageStylePresets(role: string | null): boolean {
  return role === "administrator" || role === "editor";
}

/**
 * The preset a block uses (justflows-ce#301), at the top of its Style tab.
 * Choosing a preset stores only its id; the values come from the library, so
 * editing the preset later changes this block too. Local values below stay
 * on top of the preset.
 */
export default function StylePresetPanel({ block, onChange }: { block: BlockNode; onChange: (props: Record<string, unknown>) => void }) {
  const { t } = useT();
  const id = useId();
  const role = useOptionalSessionRole();
  const canManage = canManageStylePresets(role);
  const { presets, loaded } = useStylePresets();
  const ref = presetRefOf(block.props);
  const current = presets.find((p) => p.id === ref) ?? null;
  const localStyle = compactBlockStyle(parseBlockStyle(block.props.style));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const write = (next: Record<string, unknown>) => onChange(next);
  const setRef = (value: string) => {
    const props = { ...block.props };
    const clean = sanitizeStyleRef(value);
    if (clean) props.styleRef = clean;
    else delete props.styleRef;
    write(props);
  };

  /** Save this block's own values as a new preset and link the block to it. */
  async function saveAsPreset() {
    if (!name.trim() || !localStyle) return;
    setBusy(true);
    setError("");
    try {
      const presetId = presetIdFromName(name, presets.map((p) => p.id));
      await saveStylePreset({ id: presetId, name: name.trim(), style: localStyle });
      reloadThemePreviewStylesheet();
      const props: Record<string, unknown> = { ...block.props, styleRef: presetId };
      delete props.style;
      write(props);
      setNaming(false);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Copy the preset's values onto the block and drop the link. */
  function detach() {
    if (!current) return;
    const merged = compactBlockStyle(parseBlockStyle({ ...current.style, ...(localStyle ?? {}) }));
    const props = { ...block.props };
    delete props.styleRef;
    if (merged) props.style = merged;
    else delete props.style;
    write(props);
  }

  /** Move the block's own values into the preset, so every user of the preset gets them. */
  async function pushToPreset() {
    if (!current || !localStyle) return;
    setBusy(true);
    setError("");
    try {
      const merged = compactBlockStyle(parseBlockStyle({ ...current.style, ...localStyle })) ?? {};
      await saveStylePreset({ id: current.id, name: current.name, style: merged });
      reloadThemePreviewStylesheet();
      const props: Record<string, unknown> = { ...block.props };
      delete props.style;
      write(props);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loaded && presets.length === 0 && !canManage && !ref) return null;

  return (
    <section className="jf-block-panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t("builder.presets.title")}</h3>
      <label className="jf-block-panel__field jf-block-panel__field--inline" htmlFor={`${id}-ref`}>
        {t("builder.presets.use")}
        <select id={`${id}-ref`} value={current ? ref : ""} onChange={(e) => setRef(e.target.value)}>
          <option value="">{t("builder.presets.none")}</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {ref && !current && (
            <option value={ref} disabled>
              {t("builder.presets.missing", { id: ref })}
            </option>
          )}
        </select>
      </label>
      {ref && !current && loaded && (
        <p className="jf-block-panel__error" role="note">
          {t("builder.presets.missingHint")}
        </p>
      )}
      {current && (
        <p className="jf-block-panel__hint">
          {localStyle ? t("builder.presets.usingWithLocal", { name: current.name }) : t("builder.presets.using", { name: current.name })}
        </p>
      )}
      <div className="jf-block-panel__actions jf-presets__actions">
        {current && (
          <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" onClick={detach}>
            {t("builder.presets.detach")}
          </button>
        )}
        {current && localStyle && canManage && (
          <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" disabled={busy} onClick={() => void pushToPreset()}>
            {t("builder.presets.updateFromBlock", { name: current.name })}
          </button>
        )}
        {canManage && localStyle && !naming && (
          <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" onClick={() => setNaming(true)}>
            {t("builder.presets.saveAs")}
          </button>
        )}
      </div>
      {naming && (
        <form
          className="jf-presets__name"
          onSubmit={(e) => {
            e.preventDefault();
            void saveAsPreset();
          }}
        >
          <label className="jf-block-panel__field">
            {t("builder.presets.name")}
            <input type="text" value={name} maxLength={80} autoFocus required onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="jf-block-panel__actions">
            <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" onClick={() => setNaming(false)}>
              {t("builder.actions.save.cancel")}
            </button>
            <button type="submit" className="jf-btn jf-btn--primary jf-btn--sm" disabled={busy || !name.trim()}>
              {t("builder.presets.create")}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="jf-block-panel__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
