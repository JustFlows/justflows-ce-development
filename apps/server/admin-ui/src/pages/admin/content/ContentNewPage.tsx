import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useNavigate } from "../../../admin-router";
import { useT } from "../../../i18n/I18nProvider";

interface SiteLanguage {
  code: string;
  nativeName: string;
  isDefault: boolean;
}

function slugify(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function NewContentForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const type = searchParams.get("type") ?? "post";
  const { t } = useT();
  const [typeLabel, setTypeLabel] = useState(type);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [excerpt, setExcerpt] = useState("");
  const [locale, setLocale] = useState("en-US");
  const [languages, setLanguages] = useState<SiteLanguage[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/languages/active")
      .then((r) => r.json())
      .then((data: { languages: SiteLanguage[] }) => {
        const langs = data.languages ?? [];
        setLanguages(langs);
        const def = langs.find((l) => l.isDefault);
        if (def) setLocale(def.code);
      })
      .catch(() => null);
    fetch(`/api/content-types/${encodeURIComponent(type)}`)
      .then((r) => r.json())
      .then((data: { type?: { label?: string } }) => {
        if (data.type?.label) setTypeLabel(data.type.label);
      })
      .catch(() => null);
  }, [type]);

  function handleTitleChange(v: string) {
    setTitle(v);
    if (!slugEdited) setSlug(slugify(v));
  }

  async function create(status: "draft" | "published") {
    if (!title.trim()) {
      setError(t("content.titleRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title: title.trim(),
          slug: slug || slugify(title),
          excerpt,
          locale,
          status,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? t("content.new.createFailed"));
        return;
      }
      navigate(`/admin/content/${data.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const label = type === "page" ? t("content.newPage") : type === "post" ? t("content.newPost") : t("content.new.newTypeLabel", { typeLabel });

  return (
    <>
      <header className="jf-topbar">
        <button className="jf-btn jf-btn--quiet" onClick={() => navigate(-1)}>
          ← {t("common.back")}
        </button>
        <div className="jf-topbar__title">
          <span className="jf-topbar__eyebrow">{type}</span>
          <h1>{label}</h1>
        </div>
        <div className="jf-topbar__actions">
          <button className="jf-btn jf-btn--ghost" disabled={saving} onClick={() => create("draft")}>
            {saving ? t("common.saving") : t("content.saveDraft")}
          </button>
          <button className="jf-btn jf-btn--primary" disabled={saving} onClick={() => create("published")}>
            {t("content.publish")}
          </button>
        </div>
      </header>

      <div className="jf-page">
        {error && <div className="jf-alert jf-alert--error" role="alert">{error}</div>}

        <div className="jf-card" style={{ maxWidth: 820, width: "100%" }}>
          <div className="jf-card__body jf-stack">
            <div className="jf-field">
              <label className="jf-sr-only" htmlFor="jf-new-title">{t("content.title")}</label>
              <input
                id="jf-new-title"
                className="jf-input jf-input--title"
                placeholder={t("content.title")}
                autoFocus
                value={title}
                onChange={(e) => handleTitleChange(e.target.value)}
              />
            </div>

            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-new-slug">{t("content.slug")}</label>
              <div className="jf-inputgroup">
                <span className="jf-inputgroup__prefix">/</span>
                <input
                  id="jf-new-slug"
                  className="jf-input"
                  value={slug}
                  onChange={(e) => { setSlugEdited(true); setSlug(e.target.value); }}
                />
              </div>
              <span className="jf-field__hint">{t("content.new.slugHint")}</span>
            </div>

            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-new-locale">{t("content.locale")}</label>
              <select
                id="jf-new-locale"
                className="jf-input"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
              >
                {languages.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.nativeName} ({lang.code})</option>
                ))}
              </select>
            </div>

            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-new-excerpt">{t("content.excerpt")}</label>
              <textarea
                id="jf-new-excerpt"
                className="jf-input"
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                rows={3}
              />
              <span className="jf-field__hint">{t("content.new.excerptHint")}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function NewContentPage() {
  return (
    <Suspense>
      <NewContentForm />
    </Suspense>
  );
}
