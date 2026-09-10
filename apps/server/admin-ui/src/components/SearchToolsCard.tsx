// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { useT } from "../i18n/I18nProvider";

export function SearchToolsCard() {
  const { t } = useT();
  const [settings, setSettings] = useState<{ publicTypes: string[]; queryLogging: boolean } | null>(
    null,
  );
  const [types, setTypes] = useState<Array<{ slug: string; label: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([fetch("/api/search/settings"), fetch("/api/content-types")])
      .then(async ([config, catalog]) => {
        if (!config.ok || !catalog.ok) throw new Error();
        const [s, c] = await Promise.all([config.json(), catalog.json()]);
        if (active) {
          setSettings(s);
          setTypes(c.types ?? []);
        }
      })
      .catch(() => {
        if (active) setError(t("search.error"));
      });
    return () => {
      active = false;
    };
  }, [t]);
  async function run(rebuild: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(rebuild ? "/api/search/rebuild" : "/api/search/settings", {
        method: rebuild ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rebuild ? {} : settings),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setMessage(rebuild ? t("search.rebuilt", { count: result.indexed }) : t("search.saved"));
    } catch {
      setError(t("search.error"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="jf-card">
      <div className="jf-card__head">
        <h2 className="jf-card__title">{t("search.title")}</h2>
      </div>
      <div className="jf-card__body jf-stack">
        <p className="jf-prose">{t("search.description")}</p>
        {error && (
          <div className="jf-alert jf-alert--error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className="jf-alert jf-alert--success" role="status">
            {message}
          </div>
        )}
        {!settings && !error && (
          <p className="jf-field__hint" role="status">
            {t("search.loading")}
          </p>
        )}
        {settings && (
          <>
            <fieldset className="jf-choice" disabled={busy}>
              <legend className="jf-field__label">{t("search.publicTypes")}</legend>
              {types.map((type) => (
                <label className="jf-checkrow" key={type.slug}>
                  <input
                    type="checkbox"
                    checked={settings.publicTypes.includes(type.slug)}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        publicTypes: e.target.checked
                          ? [...settings.publicTypes, type.slug]
                          : settings.publicTypes.filter((v) => v !== type.slug),
                      })
                    }
                  />
                  <span>{type.label}</span>
                </label>
              ))}
            </fieldset>
            <label className="jf-checkrow">
              <input
                type="checkbox"
                disabled={busy}
                checked={settings.queryLogging}
                onChange={(e) => setSettings({ ...settings, queryLogging: e.target.checked })}
              />
              <span>{t("search.logging")}</span>
            </label>
            <p className="jf-field__hint">{t("search.privacy")}</p>
            <div className="jf-row">
              <button
                type="button"
                className="jf-btn jf-btn--primary"
                disabled={busy}
                onClick={() => void run(false)}
              >
                {t("search.save")}
              </button>
              <button
                type="button"
                className="jf-btn jf-btn--ghost"
                disabled={busy}
                onClick={() => void run(true)}
              >
                {busy ? t("search.working") : t("search.rebuild")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
