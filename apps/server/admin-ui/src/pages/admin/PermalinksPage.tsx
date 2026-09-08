// SPDX-License-Identifier: MIT

import { useEffect, useState, type FormEvent } from "react";
import { useT } from "../../i18n/I18nProvider";

type Settings = {
  structure: string;
  typeBases: Record<string, string>;
  categoryBase: string;
  tagBase: string;
  taxonomyBases: Record<string, string>;
  trailingSlash: "never" | "always";
};
type Config = {
  settings: Settings;
  presets: Record<string, string>;
  types: Array<{ slug: string; label: string }>;
  taxonomies: Array<{ slug: string; name: string }>;
  redirects: Record<string, string>;
};

export default function PermalinksPage() {
  const { t } = useT();
  const [config, setConfig] = useState<Config | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  async function load() {
    setError("");
    try {
      const response = await fetch("/api/settings/permalinks");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? t("permalinks.failed"));
      setConfig(body);
      setSettings(body.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("permalinks.failed"));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const response = await fetch("/api/settings/permalinks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? t("permalinks.failed"));
      setSaved(t("permalinks.saved", { count: body.redirectsCreated }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("permalinks.failed"));
    } finally {
      setSaving(false);
    }
  }
  const preset =
    Object.entries(config?.presets ?? {}).find(([, value]) => value === settings?.structure)?.[0] ??
    "custom";
  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{t("permalinks.title")}</h1>
          <p>{t("permalinks.description")}</p>
        </div>
      </header>
      {error && (
        <div role="alert" className="jf-alert jf-alert--error">
          {error}{" "}
          {!config && (
            <button className="jf-btn" onClick={() => void load()}>
              {t("permalinks.retry")}
            </button>
          )}
        </div>
      )}
      {saved && (
        <div role="status" className="jf-alert jf-alert--success">
          {saved}
        </div>
      )}
      {!settings || !config ? (
        !error && <p>{t("common.loading")}</p>
      ) : (
        <form onSubmit={save} className="jf-stack">
          <p className="jf-alert">{t("permalinks.warning")}</p>
          <fieldset
            disabled={saving}
            className="jf-stack"
            style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
            aria-label={t("permalinks.title")}
          >
            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("permalinks.structure")}</h2>
              </div>
              <div className="jf-card__body jf-stack">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="permalink-preset">
                    {t("permalinks.preset")}
                  </label>
                  <select
                    className="jf-input"
                    id="permalink-preset"
                    value={preset}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        structure: config.presets[e.target.value] ?? "/%type%/%postname%/",
                      })
                    }
                  >
                    {Object.keys(config.presets).map((key) => (
                      <option key={key} value={key}>
                        {t(`permalinks.${key}`)}
                      </option>
                    ))}
                    <option value="custom">{t("permalinks.custom")}</option>
                  </select>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="permalink-structure">
                    {t("permalinks.structure")}
                  </label>
                  <input
                    className="jf-input"
                    id="permalink-structure"
                    aria-describedby="permalink-tokens"
                    spellCheck={false}
                    value={settings.structure}
                    maxLength={240}
                    required
                    onChange={(e) => setSettings({ ...settings, structure: e.target.value })}
                  />
                  <p className="jf-field__hint" id="permalink-tokens">
                    {t("permalinks.tokens")}
                  </p>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="permalink-slash">
                    {t("permalinks.slash")}
                  </label>
                  <select
                    className="jf-input"
                    id="permalink-slash"
                    value={settings.trailingSlash}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        trailingSlash: e.target.value as Settings["trailingSlash"],
                      })
                    }
                  >
                    <option value="never">{t("permalinks.never")}</option>
                    <option value="always">{t("permalinks.always")}</option>
                  </select>
                </div>
                <p className="jf-field__hint">{t("permalinks.localeHelp")}</p>
              </div>
            </section>
            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("permalinks.types")}</h2>
              </div>
              <div className="jf-card__body jf-stack">
                <p className="jf-field__hint" id="permalink-base-help">
                  {t("permalinks.baseHelp")}
                </p>
                <div className="jf-grid jf-grid--2">
                  {config.types
                    .filter((type) => type.slug !== "post")
                    .map((type) => (
                      <div className="jf-field" key={type.slug}>
                        <label className="jf-field__label" htmlFor={`base-${type.slug}`}>
                          {type.label}
                        </label>
                        <input
                          className="jf-input"
                          id={`base-${type.slug}`}
                          aria-describedby="permalink-base-help"
                          spellCheck={false}
                          value={settings.typeBases[type.slug] ?? ""}
                          maxLength={120}
                          onChange={(e) => {
                            const typeBases = { ...settings.typeBases };
                            if (e.target.value) typeBases[type.slug] = e.target.value;
                            else delete typeBases[type.slug];
                            setSettings({ ...settings, typeBases });
                          }}
                        />
                      </div>
                    ))}
                </div>
              </div>
            </section>
            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("permalinks.taxonomies")}</h2>
              </div>
              <div className="jf-card__body jf-grid jf-grid--2">
                {(["categoryBase", "tagBase"] as const).map((key) => (
                  <div className="jf-field" key={key}>
                    <label className="jf-field__label" htmlFor={key}>
                      {t(`permalinks.${key}`)}
                    </label>
                    <input
                      className="jf-input"
                      id={key}
                      value={settings[key]}
                      maxLength={120}
                      required
                      onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
                    />
                  </div>
                ))}
                {(config.taxonomies ?? [])
                  .filter((term) => !["category", "tag"].includes(term.slug))
                  .map((term) => (
                    <div className="jf-field" key={term.slug}>
                      <label className="jf-field__label" htmlFor={`taxonomy-${term.slug}`}>
                        {term.name}
                      </label>
                      <input
                        className="jf-input"
                        id={`taxonomy-${term.slug}`}
                        value={settings.taxonomyBases[term.slug] ?? term.slug}
                        maxLength={120}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            taxonomyBases: {
                              ...settings.taxonomyBases,
                              [term.slug]: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  ))}
              </div>
            </section>
            <div className="jf-row">
              <button className="jf-btn jf-btn--primary" type="submit">
                {t(saving ? "permalinks.saving" : "permalinks.save")}
              </button>
            </div>
          </fieldset>
          <details className="jf-card jf-card__body">
            <summary className="jf-card__title">
              {t("permalinks.history", { count: Object.keys(config.redirects).length })}
            </summary>
            <ul>
              {Object.entries(config.redirects).map(([path, id]) => (
                <li key={path}>
                  <code>{path}</code> → <code>{id}</code>
                </li>
              ))}
            </ul>
          </details>
        </form>
      )}
    </div>
  );
}
