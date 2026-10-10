import CacheControlField from "../../../components/CacheControlField";
import { useEffect, useState } from "react";
import { initialJson } from "../../../ssr-data";
import { useSessionRole } from "@components/SessionProvider";
import { useT } from "../../../i18n/I18nProvider";

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "textarea" | "richtext" | "number" | "boolean" | "media" | "date" | "select";
  required: boolean;
  options?: string[];
}

interface ContentType {
  slug: string;
  label: string;
  description: string;
  builtin: boolean;
  fields: FieldDef[];
  cacheControl: string | null;
  cacheControlEditable: boolean;
}

const FIELD_TYPES = [
  "text",
  "textarea",
  "richtext",
  "number",
  "boolean",
  "media",
  "date",
  "select",
] as const;


function emptyField(label: string): FieldDef {
  return { key: `field_${Date.now()}`, label, type: "text", required: false };
}

export default function ContentTypesPage() {
  const { t } = useT();
  // Everyone who can reach this page can read types; creating, editing
  // fields, and deleting are all administrator-only on the server.
  const canManage = useSessionRole() === "administrator";
  const prefetched = initialJson<{ types?: ContentType[] }>("/api/content-types");
  const [types, setTypes] = useState<ContentType[]>(prefetched?.types ?? []);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<{ slug: string; label: string; description: string; cacheControl: string | null }>({
    slug: "",
    label: "",
    description: "",
    cacheControl: null,
  });
  const [loading, setLoading] = useState(!prefetched);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/content-types");
    const data = (await res.json()) as { types?: ContentType[]; error?: string };
    if (!res.ok) throw new Error(data.error ?? t("contentTypes.loadFailed"));
    setTypes(data.types ?? []);
  }

  useEffect(() => {
    load()
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function updateLocal(slug: string, next: ContentType) {
    setTypes((prev) => prev.map((t) => (t.slug === slug ? next : t)));
  }

  async function persist(type: ContentType) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/content-types/${encodeURIComponent(type.slug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: type.label,
          description: type.description,
          fields: type.fields,
          ...(type.cacheControlEditable ? { cacheControl: type.cacheControl } : {}),
        }),
      });
      const data = (await res.json()) as { type?: ContentType; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("contentTypes.saveFailed"));
      if (data.type) updateLocal(type.slug, data.type);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveNew() {
    if (!newType.slug || !newType.label) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/content-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newType),
      });
      const data = (await res.json()) as { type?: ContentType; error?: string };
      if (!res.ok) throw new Error(data.error ?? t("contentTypes.createFailed"));
      if (data.type) setTypes((prev) => [...prev, data.type!]);
      setCreating(false);
      setNewType({ slug: "", label: "", description: "", cacheControl: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function removeType(type: ContentType) {
    if (type.builtin) return;
    if (!confirm(t("contentTypes.deleteConfirm", { label: type.label })))
      return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/content-types/${encodeURIComponent(type.slug)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("contentTypes.deleteFailed"));
      setTypes((prev) => prev.filter((t) => t.slug !== type.slug));
      if (editing === type.slug) setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="jf-page" aria-busy="true">
        <p>{t("contentTypes.loading")}</p>
      </div>
    );
  }

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{t("contentTypes.heading")}</h1>
          <p>{t("contentTypes.subtitle")}</p>
        </div>
        {canManage && (
          <div className="jf-pagehead__actions">
            <button className="jf-btn jf-btn--primary" onClick={() => setCreating(true)}>
              {t("contentTypes.newType")}
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="jf-alert jf-alert--error" role="alert">
          {error}
        </div>
      )}

      {canManage && creating && (
        <div className="jf-card jf-card--active">
          <div className="jf-card__head">
            <h2 className="jf-card__title">{t("contentTypes.newTypeHeading")}</h2>
          </div>
          <div className="jf-card__body jf-stack">
            <div className="jf-grid jf-grid--2">
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-ct-slug">
                  {t("contentTypes.slugLabel")}
                </label>
                <input
                  id="jf-ct-slug"
                  className="jf-input"
                  placeholder="product"
                  value={newType.slug}
                  onChange={(e) =>
                    setNewType({
                      ...newType,
                      slug: e.target.value.toLowerCase().replace(/\s+/g, "-"),
                    })
                  }
                />
                <span className="jf-field__hint">{t("contentTypes.slugHint")}</span>
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-ct-label">
                  {t("contentTypes.labelLabel")}
                </label>
                <input
                  id="jf-ct-label"
                  className="jf-input"
                  placeholder={t("ui.contentTypesPage.products")}
                  value={newType.label}
                  onChange={(e) => setNewType({ ...newType, label: e.target.value })}
                />
                <span className="jf-field__hint">{t("contentTypes.labelHint")}</span>
              </div>
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-ct-desc">
                {t("contentTypes.descriptionLabel")}
              </label>
              <input
                id="jf-ct-desc"
                className="jf-input"
                placeholder={t("contentTypes.optionalPlaceholder")}
                value={newType.description}
                onChange={(e) => setNewType({ ...newType, description: e.target.value })}
              />
            </div>
            <CacheControlField id="jf-ct-new-cache" value={newType.cacheControl} disabled={saving} onChange={cacheControl => setNewType({ ...newType, cacheControl })} />
            <div className="jf-row">
              <button
                className="jf-btn jf-btn--primary"
                disabled={saving}
                onClick={() => void saveNew()}
              >
                {t("common.save")}
              </button>
              <button className="jf-btn jf-btn--ghost" onClick={() => setCreating(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="jf-stack">
        {types.map((type) => {
          const isEditing = editing === type.slug;
          return (
            <div key={type.slug} className="jf-card">
              <div className="jf-card__head">
                <div style={{ minWidth: 0 }}>
                  <div className="jf-row" style={{ gap: "0.5rem" }}>
                    <strong>{type.label}</strong>
                    <code className="jf-code">{type.slug}</code>
                    {type.builtin && <span className="jf-badge">{t("contentTypes.builtinBadge")}</span>}
                  </div>
                  {type.description && <p className="jf-list__desc">{type.description}</p>}
                </div>
                <div className="jf-row">
                  <button
                    className="jf-btn jf-btn--ghost"
                    onClick={() => setEditing(isEditing ? null : type.slug)}
                  >
                    {isEditing ? t("contentTypes.closeFields") : t("contentTypes.editFields")}
                  </button>
                  {canManage && !type.builtin && (
                    <button className="jf-btn jf-btn--danger" onClick={() => void removeType(type)}>
                      {t("common.delete")}
                    </button>
                  )}
                </div>
              </div>

              {isEditing && (
                <div className="jf-card__body jf-stack">
                  {type.cacheControlEditable && <CacheControlField id={`jf-ct-cache-${type.slug}`} value={type.cacheControl ?? null} disabled={!canManage || saving} onChange={cacheControl => updateLocal(type.slug, { ...type, cacheControl })} />}
                  <h3 className="jf-card__title">{t("contentTypes.fieldsHeading", { count: type.fields.length })}</h3>

                  {type.fields.length === 0 && (
                    <p className="jf-prose">{t("contentTypes.noFieldsYet")}</p>
                  )}

                  {type.fields.map((field, i) => (
                    <div
                      key={`${type.slug}-${i}`}
                      className="jf-grid"
                      style={{
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr)) auto",
                        alignItems: "center",
                      }}
                    >
                      <input
                        className="jf-input"
                        aria-label={t("contentTypes.fieldKeyAria")}
                        placeholder="key"
                        value={field.key}
                        disabled={!canManage}
                        onChange={(e) =>
                          updateLocal(type.slug, {
                            ...type,
                            fields: type.fields.map((f, j) =>
                              j === i ? { ...f, key: e.target.value } : f,
                            ),
                          })
                        }
                      />
                      <input
                        className="jf-input"
                        aria-label={t("contentTypes.fieldLabelAria")}
                        placeholder={t("contentTypes.labelLabel")}
                        value={field.label}
                        disabled={!canManage}
                        onChange={(e) =>
                          updateLocal(type.slug, {
                            ...type,
                            fields: type.fields.map((f, j) =>
                              j === i ? { ...f, label: e.target.value } : f,
                            ),
                          })
                        }
                      />
                      <select
                        className="jf-input"
                        aria-label={t("contentTypes.fieldTypeAria")}
                        value={field.type}
                        disabled={!canManage}
                        onChange={(e) =>
                          updateLocal(type.slug, {
                            ...type,
                            fields: type.fields.map((f, j) =>
                              j === i ? { ...f, type: e.target.value as FieldDef["type"] } : f,
                            ),
                          })
                        }
                      >
                        {FIELD_TYPES.map((ft) => (
                          <option key={ft} value={ft}>
                            {ft}
                          </option>
                        ))}
                      </select>
                      <label className="jf-row" style={{ gap: "0.35rem" }}>
                        <input
                          type="checkbox"
                          checked={field.required}
                          disabled={!canManage}
                          onChange={(e) =>
                            updateLocal(type.slug, {
                              ...type,
                              fields: type.fields.map((f, j) =>
                                j === i ? { ...f, required: e.target.checked } : f,
                              ),
                            })
                          }
                        />
                        {t("contentTypes.requiredLabel")}
                      </label>
                      {field.type === "select" && (
                        <input
                          className="jf-input"
                          aria-label={t("contentTypes.selectOptionsAria")}
                          placeholder={t("ui.contentTypesPage.smallMediumLarge")}
                          value={(field.options ?? []).join(", ")}
                          disabled={!canManage}
                          onChange={(e) =>
                            updateLocal(type.slug, {
                              ...type,
                              fields: type.fields.map((f, j) =>
                                j === i
                                  ? {
                                      ...f,
                                      options: e.target.value
                                        .split(",")
                                        .map((s) => s.trim())
                                        .filter(Boolean),
                                    }
                                  : f,
                              ),
                            })
                          }
                        />
                      )}
                      {canManage && (
                        <button
                          className="jf-btn jf-btn--danger"
                          aria-label={t("contentTypes.removeFieldAria", { label: field.label })}
                          onClick={() =>
                            updateLocal(type.slug, {
                              ...type,
                              fields: type.fields.filter((_, j) => j !== i),
                            })
                          }
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}

                  {canManage && (
                    <div className="jf-row">
                      <button
                        className="jf-btn jf-btn--ghost"
                        onClick={() =>
                          updateLocal(type.slug, { ...type, fields: [...type.fields, emptyField(t("ui.contentTypesPage.newField"))] })
                        }
                      >
                        {t("contentTypes.addField")}
                      </button>
                      <button
                        className="jf-btn jf-btn--primary"
                        disabled={saving}
                        onClick={() => void persist(type)}
                      >
                        {saving ? t("common.saving") : t("contentTypes.saveFields")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
