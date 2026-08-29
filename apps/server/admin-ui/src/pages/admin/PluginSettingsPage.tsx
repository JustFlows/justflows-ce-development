import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useSessionRole } from "@components/SessionProvider";
import { initialJson } from "../../ssr-data";

interface SettingField {
  type: "string" | "number" | "boolean" | "text";
  label: string;
  description?: string;
  default?: unknown;
  localized?: boolean;
}

interface SiteLanguage {
  code: string;
  nativeName: string;
  isDefault?: boolean;
}

interface PluginSettingsPayload {
  schema?: Record<string, SettingField>;
  values?: Record<string, unknown>;
  languages?: SiteLanguage[];
  error?: string;
}

function localeValue(value: unknown, locale: string): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entry = (value as Record<string, unknown>)[locale];
    return typeof entry === "string" ? entry : "";
  }
  return "";
}

function asSettingsSchema(value: unknown): Record<string, SettingField> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, SettingField>;
}

export default function PluginSettingsPage() {
  const { id } = useParams<{ id: string }>();
  // Reading and saving plugin settings are both administrator-only on the
  // server, unlike the plugin list itself (administrator + editor).
  const role = useSessionRole();
  const canManage = role === "administrator";
  const prefetched = id ? initialJson<PluginSettingsPayload>(`/api/plugins/${id}/settings`) : undefined;
  const prefetchedSchema = asSettingsSchema(prefetched?.schema);
  const [schema, setSchema] = useState<Record<string, SettingField>>(prefetchedSchema ?? {});
  const [values, setValues] = useState<Record<string, unknown>>(prefetched?.values ?? {});
  const [languages, setLanguages] = useState<SiteLanguage[]>(prefetched?.languages ?? []);
  const [locale, setLocale] = useState("en-US");
  const [loading, setLoading] = useState(!prefetchedSchema);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function applyPayload(data: PluginSettingsPayload): void {
    if (data.error) throw new Error(data.error);
    const nextSchema = asSettingsSchema(data.schema);
    if (!nextSchema) {
      throw new Error("Plugin settings could not be loaded.");
    }
    const langs = data.languages ?? [];
    setSchema(nextSchema);
    setValues(data.values ?? {});
    setLanguages(langs);
    setLocale((current) => langs.find((lang) => lang.isDefault)?.code ?? langs[0]?.code ?? current);
    setError("");
  }

  useEffect(() => {
    if (!id || !canManage) return;
    fetch(`/api/plugins/${id}/settings`)
      .then(async (r) => {
        const data = (await r.json()) as PluginSettingsPayload;
        if (!r.ok) throw new Error(data.error ?? "Could not load plugin settings");
        applyPayload(data);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [id, canManage]);

  const localizedEntries = useMemo(
    () => Object.entries(schema).filter(([, field]) => field.localized),
    [schema],
  );
  const globalEntries = useMemo(
    () => Object.entries(schema).filter(([, field]) => !field.localized),
    [schema],
  );

  function setLocalized(key: string, next: string) {
    setValues((current) => {
      const previous = current[key];
      const map =
        previous && typeof previous === "object" && !Array.isArray(previous)
          ? { ...(previous as Record<string, string>) }
          : {};
      map[locale] = next;
      return { ...current, [key]: map };
    });
  }

  async function save() {
    if (!id) return;
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`/api/plugins/${id}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const next = await res.json() as PluginSettingsPayload;
      if (!res.ok) {
        setError(next.error ?? "Save failed");
        return;
      }
      if (asSettingsSchema(next.schema)) {
        applyPayload(next);
      } else {
        const refreshed = await fetch(`/api/plugins/${id}/settings`);
        const data = (await refreshed.json()) as PluginSettingsPayload;
        if (!refreshed.ok) throw new Error(data.error ?? "Could not reload plugin settings");
        applyPayload(data);
      }
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function renderField(key: string, field: SettingField, localized: boolean) {
    const value = localized ? localeValue(values[key], locale) : values[key];
    return (
      <label key={`${key}-${localized ? locale : "global"}`} className="jf-stack jf-stack--sm">
        <span>{field.label}</span>
        {field.description && <span className="jf-meta">{field.description}</span>}
        {field.type === "boolean" ? (
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) =>
              localized
                ? setLocalized(key, e.target.checked ? "true" : "")
                : setValues((v) => ({ ...v, [key]: e.target.checked }))
            }
          />
        ) : field.type === "text" ? (
          <textarea
            className="jf-input"
            rows={4}
            value={String(value ?? "")}
            onChange={(e) =>
              localized
                ? setLocalized(key, e.target.value)
                : setValues((v) => ({ ...v, [key]: e.target.value }))
            }
          />
        ) : (
          <input
            className="jf-input"
            type={field.type === "number" ? "number" : "text"}
            value={String(value ?? "")}
            onChange={(e) => {
              if (localized) {
                setLocalized(key, e.target.value);
                return;
              }
              setValues((v) => ({
                ...v,
                [key]: field.type === "number" ? Number(e.target.value) : e.target.value,
              }));
            }}
          />
        )}
      </label>
    );
  }

  // Reachable by a direct URL even though the plugin list no longer links
  // here for a non-administrator — bounce rather than render a form that
  // would just fail its fetch.
  if (role !== null && !canManage) {
    return <Navigate to="/admin/plugins" replace />;
  }

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>Plugin settings</h1>
          <p><code className="jf-code">{id}</code></p>
        </div>
        <Link to="/admin/plugins" className="jf-btn jf-btn--ghost">Back</Link>
      </header>

      {loading ? (
        <div className="jf-card"><div className="jf-card__body">Loading…</div></div>
      ) : error ? (
        <div className="jf-card">
          <div className="jf-alert jf-alert--error" role="alert">{error}</div>
        </div>
      ) : Object.keys(schema).length === 0 ? (
        <div className="jf-card">
          <div className="jf-empty">
            <span className="jf-empty__title">No settings</span>
            <p>This plugin does not declare a settings schema.</p>
          </div>
        </div>
      ) : (
        <div className="jf-stack">
          {error && <div className="jf-alert jf-alert--error" role="alert">{error}</div>}
          {saved && <div className="jf-alert jf-alert--success">Saved</div>}

          {localizedEntries.length > 0 && (
            <div className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">Per language</h2>
              </div>
              <div className="jf-card__body jf-stack">
                {languages.length > 1 && (
                  <div className="jf-tabs" role="tablist">
                    {languages.map((lang) => (
                      <button
                        key={lang.code}
                        type="button"
                        role="tab"
                        className="jf-tab"
                        aria-selected={locale === lang.code}
                        onClick={() => setLocale(lang.code)}
                      >
                        {lang.nativeName}
                        {lang.isDefault ? " · default" : ""}
                      </button>
                    ))}
                  </div>
                )}
                {localizedEntries.map(([key, field]) => renderField(key, field, true))}
              </div>
            </div>
          )}

          {globalEntries.length > 0 && (
            <div className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{localizedEntries.length > 0 ? "All languages" : "Settings"}</h2>
              </div>
              <div className="jf-card__body jf-stack">
                {globalEntries.map(([key, field]) => renderField(key, field, false))}
              </div>
            </div>
          )}

          <div className="jf-row">
            <button className="jf-btn jf-btn--primary" onClick={() => void save()}>Save settings</button>
          </div>
        </div>
      )}
    </div>
  );
}
