// SPDX-License-Identifier: MIT
import type { ContentTypeSettings } from "@justflows/content";
import { useT } from "../i18n/I18nProvider";
import ContentVisibilityFields from "./ContentVisibilityFields";

export type TypeSettings = Partial<ContentTypeSettings>;

export default function ContentTypeSettingsFields({
  slug,
  settings = {},
  onChange,
}: {
  slug: string;
  settings?: TypeSettings;
  onChange: (settings: TypeSettings) => void;
}) {
  const { t } = useT();
  const protectedType = slug === "account" || slug === "auth";
  const update = (patch: TypeSettings) => onChange({ ...settings, ...patch });
  return (
    <>
      <div className="jf-field">
        <label className="jf-field__label" htmlFor="ct-plural">
          {t("contentTypes.pluralLabel")}
        </label>
        <input
          id="ct-plural"
          className="jf-input"
          maxLength={255}
          value={settings.pluralLabel ?? ""}
          onChange={(e) => update({ pluralLabel: e.target.value })}
        />
        <span className="jf-field__hint">{t("contentTypes.pluralHint")}</span>
      </div>
      <div className="jf-field">
        <label className="jf-field__label" htmlFor="ct-editor">
          {t("contentTypes.editorLabel")}
        </label>
        <select
          id="ct-editor"
          className="jf-input"
          value={settings.editor ?? "auto"}
          onChange={(e) => update({ editor: e.target.value as ContentTypeSettings["editor"] })}
        >
          {["auto", "blocks", "fields"].map((value) => (
            <option key={value} value={value}>
              {t(`contentTypes.editors.${value}`)}
            </option>
          ))}
        </select>
        <span className="jf-field__hint">{t("contentTypes.editorHint")}</span>
      </div>
      <label className="jf-ct-setting">
        <input
          type="checkbox"
          checked={settings.quickAction ?? (slug === "page" || slug === "post")}
          onChange={(e) => update({ quickAction: e.target.checked })}
        />
        <span>
          {t("contentTypes.settingsLabels.quickAction")}
          <span className="jf-field__hint">{t("contentTypes.settingsHints.quickAction")}</span>
        </span>
      </label>
      <h3 className="jf-card__title">{t("contentTypes.features")}</h3>
      {(["revisions", "preview", "seo"] as const).map((key) => (
        <label key={key} className="jf-ct-setting">
          <input
            type="checkbox"
            disabled={protectedType && key === "seo"}
            checked={protectedType && key === "seo" ? false : (settings[key] ?? true)}
            onChange={(e) => update({ [key]: e.target.checked })}
          />
          <span>
            {t(`contentTypes.settingsLabels.${key}`)}
            <span className="jf-field__hint">{t(`contentTypes.settingsHints.${key}`)}</span>
          </span>
        </label>
      ))}
      <div className="jf-field">
        <label className="jf-field__label" htmlFor="ct-search">
          {t("contentTypes.settingsLabels.search")}
        </label>
        <select
          id="ct-search"
          className="jf-input"
          disabled={protectedType}
          value={
            protectedType
              ? "disabled"
              : settings.search == null
                ? "inherit"
                : settings.search
                  ? "enabled"
                  : "disabled"
          }
          onChange={(e) =>
            update({ search: e.target.value === "inherit" ? null : e.target.value === "enabled" })
          }
        >
          {["inherit", "enabled", "disabled"].map((value) => (
            <option key={value} value={value}>
              {t(`contentTypes.modes.${value}`)}
            </option>
          ))}
        </select>
        <span className="jf-field__hint">{t("contentTypes.settingsHints.search")}</span>
      </div>
      <div className="jf-field">
        <label className="jf-field__label" htmlFor="ct-comments">
          {t("contentTypes.settingsLabels.comments")}
        </label>
        <select
          id="ct-comments"
          className="jf-input"
          disabled={protectedType}
          value={protectedType ? "disabled" : (settings.comments ?? "inherit")}
          onChange={(e) => update({ comments: e.target.value as ContentTypeSettings["comments"] })}
        >
          {["inherit", "enabled", "disabled"].map((value) => (
            <option key={value} value={value}>
              {t(`contentTypes.modes.${value}`)}
            </option>
          ))}
        </select>
        <span className="jf-field__hint">{t("contentTypes.settingsHints.comments")}</span>
      </div>
      {!protectedType && (
        <>
          <h3 className="jf-card__title">{t("visibility.typeTitle")}</h3>
          <p className="jf-field__hint">{t("visibility.typeHint")}</p>
          <ContentVisibilityFields
            idPrefix="ct-visibility"
            policy={settings.visibility ?? null}
            onChange={(visibility) => update({ visibility })}
          />
        </>
      )}
    </>
  );
}
