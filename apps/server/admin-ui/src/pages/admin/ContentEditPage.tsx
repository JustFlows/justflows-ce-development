import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import BlockEditor, { type BlockDocument } from "@components/BlockEditor";
import MediaImageField from "@components/MediaImageField";
import { useSessionRole } from "@components/SessionProvider";
import { useT } from "../../i18n/I18nProvider";
import { fieldsWithHeader, headerFromFields } from "../../lib/page-header";
import ProductCatalogFields from "./ProductCatalogFields";
import { fetchProductPattern, isEmptyBlockDocument, shouldSeedProductLayout, usesPageBuilderChrome } from "../../lib/content-layout";
import { catalogPreviewTags } from "../../lib/product-tags";

interface ContentItem {
  id: string;
  type: string;
  title: string;
  slug: string;
  locale?: string;
  translationGroupId?: string | null;
  excerpt?: string;
  fields?: Record<string, unknown>;
  status: string;
  blocks?: BlockDocument;
  version?: number;
  hasWorkingRevision?: boolean;
  liveChangedSinceWorking?: boolean;
  workingRevision?: {
    id: string;
    source: string;
    baseVersion: number;
    updatedAt: string;
    updatedBy: string | null;
    updatedByName: string | null;
  } | null;
  live?: {
    title: string;
    slug: string;
    excerpt: string | null;
    version: number;
    updatedAt: string;
  } | null;
}

interface TranslationSummary {
  id: string;
  locale: string;
  title: string;
  status: string;
}

interface SiteLanguage {
  code: string;
  nativeName: string;
  isDefault?: boolean;
}

interface ContentTypeField {
  key: string;
  label: string;
  type: "text" | "textarea" | "richtext" | "number" | "boolean" | "media" | "date" | "select";
  required: boolean;
  options?: string[];
}

interface RevisionSummary {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  version: number;
  kind: string;
  createdAt: string;
  authorName: string | null;
}

const VISIBLE_REVISION_HISTORY = 5;

function localePath(locale: string, slug: string, defaultLocale: string): string {
  const path = `/${slug}`;
  if (locale === defaultLocale) return path;
  return `/${locale}${path}`;
}

export default function EditContentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, locale } = useT();
  // Setting the home/blog page is administrator/editor-only on the server;
  // an author or contributor can still edit and publish this content.
  const role = useSessionRole();
  const canSetSitePages = role === "administrator" || role === "editor";

  const [item, setItem] = useState<ContentItem | null>(null);
  const [baseline, setBaseline] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [languages, setLanguages] = useState<SiteLanguage[]>([]);
  const [translations, setTranslations] = useState<TranslationSummary[]>([]);
  const [defaultLocale, setDefaultLocale] = useState("en-US");
  const [typeFields, setTypeFields] = useState<ContentTypeField[]>([]);
  const [typeLabel, setTypeLabel] = useState("");
  const [homePageId, setHomePageId] = useState<string | null>(null);
  const [homeSaving, setHomeSaving] = useState(false);
  const [blogPageId, setBlogPageId] = useState<string | null>(null);
  const [blogSaving, setBlogSaving] = useState(false);
  const [compare, setCompare] = useState<Array<{ field: string; live: unknown; working: unknown }> | null>(null);
  const [autosaving, setAutosaving] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [expandedRevisionId, setExpandedRevisionId] = useState<string | null>(null);
  const [catalogDirty, setCatalogDirty] = useState(false);
  const [catalogDraft, setCatalogDraft] = useState<Parameters<typeof catalogPreviewTags>[0]>(null);
  const catalogSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const onCatalogDirty = useCallback((next: boolean) => setCatalogDirty(next), []);

  useEffect(() => {
    fetch("/api/languages/active")
      .then((r) => r.json())
      .then((data: { languages: SiteLanguage[] }) => {
        const langs = data.languages ?? [];
        setLanguages(langs);
        setDefaultLocale(langs.find((l) => l.isDefault)?.code ?? langs[0]?.code ?? "en-US");
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { home_page_id?: string | null; blog_page_id?: string | null }) => {
        setHomePageId(typeof data.home_page_id === "string" ? data.home_page_id : null);
        setBlogPageId(typeof data.blog_page_id === "string" ? data.blog_page_id : null);
      })
      .catch(() => null);
  }, []);

  const loadTranslations = useCallback(async (groupId: string) => {
    const res = await fetch(`/api/content?translationGroupId=${encodeURIComponent(groupId)}&limit=20`);
    const data = await res.json() as { items?: TranslationSummary[] };
    if (Array.isArray(data.items)) setTranslations(data.items);
  }, []);

  const loadRevisions = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/content/${id}/revisions`);
    if (!res.ok) return;
    const data = await res.json() as { items?: RevisionSummary[] };
    setRevisions((data.items ?? []).slice(0, VISIBLE_REVISION_HISTORY + 1));
  }, [id]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/content/${id}`)
      .then(async (r) => {
        const data = await r.json() as ContentItem & { error?: string };
        if (!r.ok) throw new Error(data.error ?? "Failed to load content");
        if (!data.id) throw new Error("Content not found");
        setItem(data);
        setBaseline(JSON.stringify(data));
        if (shouldSeedProductLayout(data) && isEmptyBlockDocument(data.blocks)) {
          const pattern = await fetchProductPattern();
          if (pattern) {
            setItem((prev) => (prev ? { ...prev, blocks: pattern as ContentItem["blocks"] } : prev));
          }
        }
        const groupId = data.translationGroupId ?? data.id;
        fetch(`/api/content-types/${encodeURIComponent(data.type)}`)
          .then((tr) => tr.json())
          .then((body: { type?: { label?: string; fields?: ContentTypeField[] } }) => {
            setTypeLabel(body.type?.label ?? data.type);
            setTypeFields(body.type?.fields ?? []);
          })
          .catch(() => {
            setTypeLabel(data.type);
            setTypeFields([]);
          });
        return Promise.all([loadTranslations(groupId), loadRevisions()]);
      })
      .catch((err: Error) => setError(err.message ?? "Failed to load content"))
      .finally(() => setLoading(false));
  }, [id, loadTranslations, loadRevisions]);

  const contentDirty = useMemo(
    () => Boolean(item) && JSON.stringify(item) !== baseline,
    [item, baseline],
  );
  const dirty = contentDirty || catalogDirty;

  useEffect(() => {
    if (!dirty || saving || !item) return;
    const timer = window.setTimeout(() => {
      void save(undefined, "autosave");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [dirty, item, saving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!saving && dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  async function save(status?: string, source: "manual" | "autosave" = "manual") {
    if (!item) return;
    if (status === "published") {
      await publish();
      return;
    }
    if (status === "draft" && item.status === "published") {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/content/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "draft", expectedVersion: item.version }),
        });
        const data = await res.json();
        if (!res.ok) { setError(data.error ?? "Failed to unpublish"); return; }
        setItem(data);
        setBaseline(JSON.stringify(data));
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!contentDirty) {
      if (source === "autosave") setAutosaving(true);
      else {
        setSaving(true);
        setSaved(false);
      }
      setError(null);
      try {
        const ok = await saveCatalogData();
        if (ok && source !== "autosave") {
          setSaved(true);
          setTimeout(() => setSaved(false), 2500);
        }
      } finally {
        setSaving(false);
        setAutosaving(false);
      }
      return;
    }

    if (source === "autosave") setAutosaving(true);
    else {
      setSaving(true);
      setSaved(false);
    }
    setError(null);
    try {
      const {
        locale: _locale,
        translationGroupId: _group,
        live: _live,
        workingRevision: _working,
        status: _status,
        hasWorkingRevision: _has,
        liveChangedSinceWorking: _changed,
        version: _version,
        ...payload
      } = item;
      const res = await fetch(`/api/content/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          source,
          expectedVersion: item.version,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to save"); return; }
      setItem(data);
      setBaseline(JSON.stringify(data));
      const catalogOk = await saveCatalogData();
      if (!catalogOk) return;
      if (source !== "autosave") {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
      await loadRevisions();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
      setAutosaving(false);
    }
  }

  async function publish() {
    if (!item) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      let versionToPublish = item.version;
      if (contentDirty) {
        const {
          locale: _locale,
          translationGroupId: _group,
          live: _live,
          workingRevision: _working,
          status: _status,
          hasWorkingRevision: _has,
          liveChangedSinceWorking: _changed,
          version: _version,
          ...payload
        } = item;
        const saveRes = await fetch(`/api/content/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, source: "manual", expectedVersion: item.version }),
        });
        const savedItem = await saveRes.json() as ContentItem & { error?: string };
        if (!saveRes.ok) { setError(savedItem.error ?? "Failed to save"); return; }
        setItem(savedItem);
        setBaseline(JSON.stringify(savedItem));
        versionToPublish = savedItem.version;
      }
      const catalogOk = await saveCatalogData();
      if (!catalogOk) return;
      const res = await fetch(`/api/content/${id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: versionToPublish }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to publish"); return; }
      setItem(data);
      setBaseline(JSON.stringify(data));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await loadRevisions();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function discardDraft() {
    if (!item?.hasWorkingRevision) return;
    if (!confirm(t("content.discardDraftConfirm"))) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/content/${id}/discard-draft`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to discard"); return; }
      setItem(data);
      setBaseline(JSON.stringify(data));
      setCompare(null);
      await loadRevisions();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function loadCompare() {
    const res = await fetch(`/api/content/${id}/revisions/compare`);
    const data = await res.json() as { entries?: Array<{ field: string; live: unknown; working: unknown }> };
    setCompare(data.entries ?? []);
  }

  async function restoreRevision(rev: RevisionSummary) {
    if (!id) return;
    if (dirty && !confirm(t("content.unsavedLeave"))) return;
    const label = rev.title || t("content.revisionVersion", { version: rev.version });
    if (!confirm(t("content.restoreRevisionConfirm", { title: label }))) return;
    setRestoringId(rev.id);
    setError(null);
    try {
      const res = await fetch(`/api/content/${id}/revisions/${rev.id}/restore`, { method: "POST" });
      const data = await res.json() as ContentItem & { error?: string };
      if (!res.ok) { setError(data.error ?? "Failed to restore"); return; }
      setItem(data);
      setBaseline(JSON.stringify(data));
      setCompare(null);
      await loadRevisions();
    } catch (e) {
      setError(String(e));
    } finally {
      setRestoringId(null);
    }
  }

  async function createTranslation(locale: string) {
    if (!item) return;
    if (dirty && !confirm(t("content.unsavedLeave"))) return;

    setTranslating(true);
    setError(null);
    try {
      const res = await fetch(`/api/content/${id}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      const data = await res.json() as ContentItem & { error?: string; contentId?: string };
      if (res.status === 409 && data.contentId) {
        navigate(`/admin/content/${data.contentId}`);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Failed to create translation");
        return;
      }
      navigate(`/admin/content/${data.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setTranslating(false);
    }
  }

  function navigateToTranslation(targetId: string) {
    if (targetId === id) return;
    if (dirty && !confirm(t("content.unsavedLeave"))) return;
    navigate(`/admin/content/${targetId}`);
  }

  async function deleteItem() {
    if (!confirm("Delete this content? This cannot be undone.")) return;
    await fetch(`/api/content/${id}`, { method: "DELETE" });
    navigate(item?.type === "product" ? "/admin/shop/products" : "/admin/content");
  }

  function patch(changes: Partial<ContentItem>) {
    setItem((prev) => (prev ? { ...prev, ...changes } : prev));
  }

  function patchField(key: string, value: unknown) {
    patch({ fields: { ...(item?.fields ?? {}), [key]: value } });
  }

  async function saveCatalogData(): Promise<boolean> {
    if (!catalogSaveRef.current) return true;
    const ok = await catalogSaveRef.current();
    if (!ok) setError(t("shop.saveFailed"));
    return ok;
  }

  async function setAsHomePage(enabled: boolean) {
    if (!item) return;
    setHomeSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/home-page", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: enabled ? item.id : null }),
      });
      const data = await res.json() as { error?: string; homePageId?: string | null };
      if (!res.ok) throw new Error(data.error ?? "Could not update the home page");
      setHomePageId(data.homePageId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHomeSaving(false);
    }
  }

  async function setAsBlogPage(enabled: boolean) {
    if (!item) return;
    setBlogSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/blog-page", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: enabled ? item.id : null }),
      });
      const data = await res.json() as { error?: string; blogPageId?: string | null };
      if (!res.ok) throw new Error(data.error ?? "Could not update the blog page");
      setBlogPageId(data.blogPageId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBlogSaving(false);
    }
  }

  if (loading) return <EditorSkeleton loadingLabel={t("common.loading")} />;

  if (!item) {
    return (
      <>
        <Topbar onBack={() => navigate("/admin/content")} backLabel={t("common.back")} />
        <div className="jf-page">
          <div className="jf-alert jf-alert--error">{error ?? "Not found"}</div>
        </div>
      </>
    );
  }

  const isPage = usesPageBuilderChrome(item.type);
  const mergeTags = item.type === "product" ? catalogPreviewTags(catalogDraft, item) : undefined;
  const isCmsPage = item.type === "page";
  const isHomePage = homePageId === item.id;
  const isBlogPage = blogPageId === item.id;
  const label = typeLabel || (isCmsPage ? t("content.editPage") : t("content.editPost"));
  const itemLocale = item.locale ?? defaultLocale;
  const publicHref = localePath(itemLocale, item.slug ?? "", defaultLocale);
  const currentLang = languages.find((l) => l.code === itemLocale);

  return (
    <>
      <Topbar onBack={() => navigate("/admin/content")} backLabel={t("common.back")}>
        <div className="jf-topbar__title">
          <span className="jf-topbar__eyebrow">{label}</span>
          <h1>{item.title || t("content.title")}</h1>
        </div>

        <div className="jf-topbar__actions">
          <SaveState saving={saving} saved={saved} dirty={dirty} error={error} autosaving={autosaving} t={t} />
          <button className="jf-btn jf-btn--ghost" disabled={saving || !dirty} onClick={() => save()}>
            {saving ? t("common.saving") : t("content.saveDraft")}
          </button>
          {item.status === "published" ? (
            <button className="jf-btn jf-btn--primary" disabled={saving} onClick={() => publish()}>
              {item.hasWorkingRevision || dirty ? t("content.publishDraft") : t("content.publish")}
            </button>
          ) : (
            <button className="jf-btn jf-btn--primary" disabled={saving} onClick={() => publish()}>
              {t("content.publish")}
            </button>
          )}
        </div>
      </Topbar>

      <div className="jf-page">
        {error && <div className="jf-alert jf-alert--error" role="alert">{error}</div>}
        {item.liveChangedSinceWorking && (
          <div className="jf-alert" role="status">{t("content.liveChanged")}</div>
        )}

        {languages.length > 1 && (
          <div className="jf-card" style={{ marginBottom: "1.25rem" }}>
            <div className="jf-card__body">
              <div className="jf-field" style={{ marginBottom: "0.75rem" }}>
                <span className="jf-field__label">{t("content.translations")}</span>
              </div>
              <div className="jf-tabs" role="tablist">
                {languages.map((lang) => {
                  const translation = translations.find((tr) => tr.locale === lang.code);
                  const isCurrent = itemLocale === lang.code;

                  if (translation) {
                    return (
                      <button
                        key={lang.code}
                        type="button"
                        role="tab"
                        aria-selected={isCurrent}
                        className="jf-tab"
                        disabled={translating}
                        onClick={() => navigateToTranslation(translation.id)}
                      >
                        {lang.nativeName}
                        {translation.status !== "published" ? " · draft" : ""}
                      </button>
                    );
                  }

                  return (
                    <button
                      key={lang.code}
                      type="button"
                      className="jf-tab jf-tab--add"
                      disabled={translating}
                      onClick={() => createTranslation(lang.code)}
                      title={t("content.addTranslation")}
                    >
                      + {lang.nativeName}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="jf-split">
          <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <div className="jf-card">
              <div className="jf-card__body" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <div className="jf-field">
                  <label className="jf-sr-only" htmlFor="jf-title">{t("content.title")}</label>
                  <input
                    id="jf-title"
                    className="jf-input jf-input--title"
                    placeholder={t("content.title")}
                    value={item.title}
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                </div>

                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-slug">{t("content.slug")}</label>
                  <div className="jf-inputgroup">
                    <span className="jf-inputgroup__prefix">/</span>
                    <input
                      id="jf-slug"
                      className="jf-input"
                      value={item.slug ?? ""}
                      onChange={(e) => patch({ slug: e.target.value })}
                    />
                  </div>
                </div>

                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-excerpt">{t("content.excerpt")}</label>
                  <textarea
                    id="jf-excerpt"
                    className="jf-input"
                    value={item.excerpt ?? ""}
                    onChange={(e) => patch({ excerpt: e.target.value })}
                    rows={3}
                  />
                  <span className="jf-field__hint">
                    Shown in listings. Used as the meta description if SEO description is empty.
                  </span>
                </div>
              </div>
            </div>

            {item.type === "product" && (
              <ProductCatalogFields
                contentId={item.id}
                translationGroupId={item.translationGroupId ?? item.id}
                saveRef={catalogSaveRef}
                onDirtyChange={onCatalogDirty}
                onDraftChange={setCatalogDraft}
              />
            )}

            {typeFields.length > 0 && (
              <div className="jf-card">
                <div className="jf-card__head">
                  <h2 className="jf-card__title">Fields</h2>
                </div>
                <div className="jf-card__body" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                  {typeFields.map((field) => (
                    <TypeFieldInput
                      key={field.key}
                      field={field}
                      value={item.fields?.[field.key]}
                      onChange={(value) => patchField(field.key, value)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">Content</h2>
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost"
                  onClick={() => navigate(`/admin/content/${id}/builder`)}
                >
                  Open page builder
                </button>
              </div>
              <div className="jf-card__body">
                <BlockEditor
                  value={item.blocks ?? { version: 1, blocks: [] }}
                  onChange={(blocks) => patch({ blocks })}
                  compact
                  isPage={isPage}
                  enableHeader={isPage}
                  mergeTags={mergeTags}
                  enableProductTags={item.type === "product"}
                  header={isPage ? headerFromFields(item.fields) : undefined}
                  onHeaderChange={isPage ? (header) => setItem((prev) => (prev ? {
                    ...prev,
                    fields: fieldsWithHeader(prev.fields, header),
                  } : prev)) : undefined}
                />
              </div>
            </div>
          </div>

          <aside className="jf-rail">
            <div className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">Publish</h2>
                <StatusBadge status={item.status} hasWorkingRevision={item.hasWorkingRevision} />
              </div>
              <div className="jf-card__body" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <div className="jf-field">
                  <span className="jf-field__label">{t("content.locale")}</span>
                  <p className="jf-field__value" style={{ margin: 0 }}>
                    {currentLang ? `${currentLang.nativeName} (${currentLang.code})` : itemLocale}
                  </p>
                  <span className="jf-field__hint">
                    Language is set when content is created. Use the translation tabs above to add other languages.
                  </span>
                </div>

                {item.hasWorkingRevision && (
                  <p className="jf-field__hint" style={{ margin: 0 }}>
                    {item.workingRevision?.updatedByName
                      ? t("content.lastDraftBy", { name: item.workingRevision.updatedByName })
                      : t("content.draftChanges")}
                  </p>
                )}

                <button
                  className="jf-btn jf-btn--primary jf-btn--block"
                  disabled={saving || !dirty}
                  onClick={() => save()}
                >
                  {saving ? t("common.saving") : t("content.saveDraft")}
                </button>

                {item.status === "published" && (item.hasWorkingRevision || dirty) && (
                  <button
                    className="jf-btn jf-btn--ghost jf-btn--block"
                    disabled={saving}
                    onClick={() => publish()}
                  >
                    {t("content.publishDraft")}
                  </button>
                )}

                {item.status !== "published" && (
                  <button
                    className="jf-btn jf-btn--ghost jf-btn--block"
                    disabled={saving}
                    onClick={() => publish()}
                  >
                    {t("content.publish")}
                  </button>
                )}

                {item.status === "published" && !item.hasWorkingRevision && !dirty && (
                  <button
                    className="jf-btn jf-btn--ghost jf-btn--block"
                    disabled={saving}
                    onClick={() => save("draft")}
                  >
                    Unpublish
                  </button>
                )}

                {item.hasWorkingRevision && (
                  <>
                    <button
                      type="button"
                      className="jf-btn jf-btn--ghost jf-btn--block"
                      onClick={() => void loadCompare()}
                    >
                      {t("content.compareDraft")}
                    </button>
                    <button
                      type="button"
                      className="jf-btn jf-btn--ghost jf-btn--block"
                      disabled={saving}
                      onClick={() => void discardDraft()}
                    >
                      {t("content.discardDraft")}
                    </button>
                  </>
                )}

                {compare && (
                  <div className="jf-field">
                    <span className="jf-field__label">{t("content.compareDraft")}</span>
                    {compare.length === 0 ? (
                      <p className="jf-field__hint" style={{ margin: 0 }}>No differences.</p>
                    ) : (
                      <ul style={{ margin: 0, paddingInlineStart: "1.1rem" }}>
                        {compare.map((entry) => (
                          <li key={entry.field}>{entry.field}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {item.status === "published" && (
                  <a
                    className="jf-btn jf-btn--ghost jf-btn--block"
                    href={isHomePage ? "/" : publicHref}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("content.viewLive")} ↗
                  </a>
                )}
                <a
                  className="jf-btn jf-btn--ghost jf-btn--block"
                  href={`${isHomePage ? "/" : publicHref}?preview=1`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("content.previewDraft")} ↗
                </a>

                {isCmsPage && canSetSitePages && (
                  <div className="jf-field">
                    {isHomePage ? (
                      <>
                        <p className="jf-field__hint" style={{ margin: 0 }}>
                          This page is the site home page (/).
                        </p>
                        <button
                          type="button"
                          className="jf-btn jf-btn--ghost jf-btn--block"
                          disabled={homeSaving}
                          onClick={() => setAsHomePage(false)}
                        >
                          {homeSaving ? "Updating…" : "Stop using as home page"}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="jf-btn jf-btn--ghost jf-btn--block"
                        disabled={homeSaving}
                        onClick={() => setAsHomePage(true)}
                      >
                        {homeSaving ? "Updating…" : "Set as home page"}
                      </button>
                    )}
                  </div>
                )}

                {isCmsPage && canSetSitePages && (
                  <div className="jf-field">
                    {isBlogPage ? (
                      <>
                        <p className="jf-field__hint" style={{ margin: 0 }}>
                          This page is the site blog page.
                        </p>
                        <button
                          type="button"
                          className="jf-btn jf-btn--ghost jf-btn--block"
                          disabled={blogSaving}
                          onClick={() => setAsBlogPage(false)}
                        >
                          {blogSaving ? "Updating…" : "Stop using as blog page"}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="jf-btn jf-btn--ghost jf-btn--block"
                        disabled={blogSaving}
                        onClick={() => setAsBlogPage(true)}
                      >
                        {blogSaving ? "Updating…" : "Set as blog page"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("content.revisions")}</h2>
              </div>
              <div className="jf-card__body" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                <p className="jf-field__hint" style={{ margin: 0 }}>{t("content.revisionsHint")}</p>
                {revisions.length === 0 ? (
                  <p className="jf-field__hint" style={{ margin: 0 }}>{t("content.revisionsEmpty")}</p>
                ) : (
                  <ul className="jf-revision-list">
                    {revisions.map((rev) => {
                      const open = expandedRevisionId === rev.id;
                      const busy = restoringId === rev.id || saving;
                      const current = rev.kind === "working" || rev.kind === "autosave";
                      return (
                        <li key={rev.id} className="jf-revision-list__item">
                          <div className="jf-revision-list__main">
                            <button
                              type="button"
                              className="jf-revision-list__title"
                              aria-expanded={open}
                              onClick={() => setExpandedRevisionId(open ? null : rev.id)}
                            >
                              {current
                                ? t("content.revisionCurrentDraft")
                                : (rev.title || t("content.revisionVersion", { version: rev.version }))}
                            </button>
                            <p className="jf-revision-list__meta">
                              {formatRevisionTime(rev.createdAt, locale)}
                              {rev.authorName ? ` · ${rev.authorName}` : ""}
                              {` · ${t("content.revisionVersion", { version: rev.version })}`}
                            </p>
                            {open && (
                              <p className="jf-revision-list__detail">
                                /{rev.slug}
                                {rev.excerpt ? ` — ${rev.excerpt}` : ""}
                              </p>
                            )}
                          </div>
                          {current ? (
                            <span className="jf-badge">{t("content.draftChanges")}</span>
                          ) : (
                            <button
                              type="button"
                              className="jf-btn jf-btn--ghost"
                              disabled={busy}
                              onClick={() => void restoreRevision(rev)}
                            >
                              {busy && restoringId === rev.id ? t("common.saving") : t("content.restoreRevision")}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <div className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">SEO</h2>
              </div>
              <div className="jf-card__body" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-seo-title">SEO title</label>
                  <input
                    id="jf-seo-title"
                    className="jf-input"
                    value={typeof item.fields?.seoTitle === "string" ? item.fields.seoTitle : ""}
                    onChange={(e) => patchField("seoTitle", e.target.value)}
                    placeholder={item.title}
                  />
                  <span className="jf-field__hint">Overrides the page title in search results and social shares.</span>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-seo-description">Meta description</label>
                  <textarea
                    id="jf-seo-description"
                    className="jf-input"
                    rows={4}
                    value={typeof item.fields?.seoDescription === "string" ? item.fields.seoDescription : ""}
                    onChange={(e) => patchField("seoDescription", e.target.value)}
                    placeholder={item.excerpt || "A short summary for search engines"}
                  />
                  <span className="jf-field__hint">
                    If empty, the excerpt or title is used. Shown in Google and Open Graph previews.
                  </span>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-seo-canonical">Canonical URL</label>
                  <input
                    id="jf-seo-canonical"
                    className="jf-input"
                    value={typeof item.fields?.seoCanonical === "string" ? item.fields.seoCanonical : ""}
                    onChange={(e) => patchField("seoCanonical", e.target.value)}
                    placeholder={publicHref}
                  />
                  <span className="jf-field__hint">Leave empty to use this page’s permalink.</span>
                </div>
                <MediaImageField
                  id="jf-seo-image"
                  label="Social image"
                  description="Used for Open Graph and Twitter cards. Falls back to no image if empty."
                  value={typeof item.fields?.seoImage === "string" ? item.fields.seoImage : ""}
                  onChange={(url) => patchField("seoImage", url)}
                />
              </div>
            </div>

            <div className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">Details</h2>
              </div>
              <div className="jf-card__body">
                <dl style={{ margin: 0 }}>
                  <div className="jf-meta__row">
                    <dt>Type</dt>
                    <dd>{item.type}</dd>
                  </div>
                  <div className="jf-meta__row">
                    <dt>Permalink</dt>
                    <dd>{publicHref}</dd>
                  </div>
                  <div className="jf-meta__row">
                    <dt>ID</dt>
                    <dd>{item.id}</dd>
                  </div>
                </dl>
              </div>
            </div>

            <div className="jf-card">
              <div className="jf-card__body">
                <button className="jf-btn jf-btn--danger jf-btn--block" onClick={deleteItem}>
                  {t("common.delete")}
                </button>
                <p className="jf-field__hint" style={{ margin: "0.6rem 0 0", textAlign: "center" }}>
                  This cannot be undone.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- pieces --- */

function Topbar({
  onBack, backLabel, children,
}: {
  onBack: () => void;
  backLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="jf-topbar">
      <button className="jf-btn jf-btn--quiet" onClick={onBack}>← {backLabel}</button>
      {children}
    </header>
  );
}

function formatRevisionTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

function SaveState({
  saving, saved, dirty, error, autosaving, t,
}: {
  saving: boolean;
  saved: boolean;
  dirty: boolean;
  error: string | null;
  autosaving: boolean;
  t: (key: string) => string;
}) {
  if (saving) return <span className="jf-status jf-status--dirty">{t("common.saving")}…</span>;
  if (autosaving) return <span className="jf-status jf-status--dirty">{t("content.autosaving")}</span>;
  if (error) return <span className="jf-status jf-status--error">Save failed</span>;
  if (saved) return <span className="jf-status jf-status--saved">✓ {t("content.draftSaved")}</span>;
  if (dirty) return <span className="jf-status jf-status--dirty">Unsaved changes</span>;
  return null;
}

function StatusBadge({ status, hasWorkingRevision }: { status: string; hasWorkingRevision?: boolean }) {
  if (status === "published" && hasWorkingRevision) {
    return <span className="jf-badge jf-badge--info">Published — draft</span>;
  }
  const variant = status === "published" || status === "archived" ? ` jf-badge--${status}` : "";
  return <span className={`jf-badge${variant}`}>{status}</span>;
}

function fieldValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function TypeFieldInput({
  field,
  value,
  onChange,
}: {
  field: ContentTypeField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `jf-cf-${field.key}`;
  const current = fieldValue(value);

  if (field.type === "boolean") {
    return (
      <label className="jf-row" style={{ gap: "0.5rem" }}>
        <input
          id={id}
          type="checkbox"
          checked={value === true || value === "true" || value === 1}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
        {field.required ? " *" : ""}
      </label>
    );
  }

  if (field.type === "media") {
    return (
      <MediaImageField
        id={id}
        label={`${field.label}${field.required ? " *" : ""}`}
        value={current}
        onChange={onChange}
      />
    );
  }

  if (field.type === "select") {
    return (
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={id}>{field.label}{field.required ? " *" : ""}</label>
        <select id={id} className="jf-input" value={current} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "textarea" || field.type === "richtext") {
    return (
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={id}>{field.label}{field.required ? " *" : ""}</label>
        <textarea
          id={id}
          className="jf-input"
          rows={4}
          value={current}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="jf-field">
      <label className="jf-field__label" htmlFor={id}>{field.label}{field.required ? " *" : ""}</label>
      <input
        id={id}
        className="jf-input"
        type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
        value={current}
        onChange={(e) => onChange(field.type === "number" ? Number(e.target.value) : e.target.value)}
      />
    </div>
  );
}

function EditorSkeleton({ loadingLabel }: { loadingLabel: string }) {
  return (
    <>
      <header className="jf-topbar">
        <div className="jf-skeleton" style={{ width: 180, height: 20 }} />
      </header>
      <div className="jf-page" aria-busy="true" aria-label={loadingLabel}>
        <div className="jf-split">
          <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <div className="jf-skeleton" style={{ height: 190 }} />
            <div className="jf-skeleton" style={{ height: 320 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <div className="jf-skeleton" style={{ height: 210 }} />
            <div className="jf-skeleton" style={{ height: 150 }} />
          </div>
        </div>
      </div>
    </>
  );
}
