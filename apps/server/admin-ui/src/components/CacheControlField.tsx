// SPDX-License-Identifier: MIT
import { useT } from "../i18n/I18nProvider";

export default function CacheControlField({ id, value, disabled, onChange, inheritLabelKey = "contentTypes.cacheInherit", hintKey = "contentTypes.cacheHint" }: { id: string; value: string | null; disabled: boolean; onChange: (value: string | null) => void; inheritLabelKey?: string; hintKey?: string }) {
  const { t } = useT();
  const mode = value === null ? "inherit" : value === "private, no-store" ? "never" : "custom";
  return <div className="jf-field">
    <label className="jf-field__label" htmlFor={id}>{t("contentTypes.cacheControlLabel")}</label>
    <select id={id} className="jf-input" value={mode} disabled={disabled} onChange={e => onChange(e.target.value === "inherit" ? null : e.target.value === "never" ? "private, no-store" : "public, max-age=300")}>
      <option value="inherit">{t(inheritLabelKey)}</option>
      <option value="never">{t("contentTypes.cacheNever")}</option>
      <option value="custom">{t("contentTypes.cacheCustom")}</option>
    </select>
    {mode === "custom" && <input className="jf-input" aria-label={t("contentTypes.cacheControlValue")} value={value ?? ""} disabled={disabled} onChange={e => onChange(e.target.value)} placeholder={t("contentTypes.cacheControlPlaceholder")} />}
    <span className="jf-field__hint">{t(hintKey)}</span>
  </div>;
}
