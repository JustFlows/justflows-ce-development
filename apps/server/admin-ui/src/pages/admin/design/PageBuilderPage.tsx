import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useNavigate } from "../../../admin-router";
import PageBuilder, { type BlockDocument } from "@components/builder/PageBuilder";
import HeaderRefField from "@components/builder/HeaderRefField";
import { fieldsWithHeaderRef, headerRefFromFields } from "../../../lib/page-header";
import { fetchTypePattern, isEmptyBlockDocument, shouldSeedTypePattern, usesBlockEditor } from "../../../lib/content-layout";
import { useT } from "../../../i18n/I18nProvider";

interface ContentItem {
  id: string;
  type: string;
  title: string;
  slug: string;
  status: string;
  version?: number;
  hasWorkingRevision?: boolean;
  translationGroupId?: string | null;
  excerpt?: string | null;
  blocks?: BlockDocument;
  fields?: Record<string, unknown>;
}

export default function PageBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useT();

  const [item, setItem] = useState<ContentItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [mergeTags, setMergeTags] = useState<Record<string, string> | undefined>(undefined);
  const [blockEditor, setBlockEditor] = useState(false);

  useEffect(() => {
    fetch(`/api/content/${id}`)
      .then(async (r) => {
        const data = await r.json() as ContentItem & { error?: string };
        if (!r.ok) throw new Error(data.error ?? t("pageBuilderPage.loadError"));
        if (shouldSeedTypePattern(data) && isEmptyBlockDocument(data.blocks)) {
          const pattern = await fetchTypePattern(data.type);
          if (pattern) data.blocks = pattern as ContentItem["blocks"];
        }
        setItem(data);
        fetch(`/api/content-types/${encodeURIComponent(data.type)}`)
          .then((res) => res.json())
          .then((body: { type?: { editor?: string } }) => {
            setBlockEditor(body.type?.editor === "blocks");
          })
          .catch(() => undefined);
        fetch(`/api/content/${encodeURIComponent(data.id)}/merge-tags`)
          .then((res) => (res.ok ? res.json() : null))
          .then((body: { tags?: Record<string, string> } | null) => {
            if (body?.tags && Object.keys(body.tags).length > 0) setMergeTags(body.tags);
          })
          .catch(() => undefined);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const save = useCallback(async (publish = false) => {
    if (!item) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/content/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: item.title,
          slug: item.slug,
          blocks: item.blocks,
          fields: item.fields,
          expectedVersion: item.version,
          source: "manual",
        }),
      });
      const data = await res.json() as ContentItem & { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("pageBuilderPage.saveFailed"));
      setItem(data);
      if (publish) {
        const published = await fetch(`/api/content/${id}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedVersion: data.version }),
        });
        const body = await published.json() as ContentItem & { error?: string };
        if (!published.ok) throw new Error(body.error ?? t("pageBuilderPage.publishFailed"));
        setItem(body);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [item, id]);

  if (loading) return <div className="jf-center">{t("pageBuilderPage.loading")}</div>;

  if (!item) {
    return (
      <div className="jf-center">
        <div className="jf-alert jf-alert--error">{error || t("pageBuilderPage.notFound")}</div>
      </div>
    );
  }

  const isPage = usesBlockEditor(item.type, blockEditor);
  const previewUrl = item.slug ? `${item.slug.startsWith("/") ? item.slug : `/${item.slug}`}?preview=1` : null;

  return (
    <div className="jf-editor">
      <header className="jf-editor__bar">
        <button
          type="button"
          className="jf-btn jf-btn--onbar"
          onClick={() => navigate(`/admin/content/${id}`)}
        >
          ← {t("common.back")}
        </button>

        <div className="jf-editor__title">
          <div className="jf-editor__name">{item.title || t("pageBuilderPage.untitledPage")}</div>
          <div className="jf-editor__sub">
            {t("pageBuilderPage.statusLine", { status: item.status })}{item.hasWorkingRevision ? t("pageBuilderPage.draftChangesSuffix") : ""}
          </div>
        </div>

        <div className="jf-editor__actions">
          {isPage && (
            <HeaderRefField
              contentId={item.id}
              value={headerRefFromFields(item.fields)}
              onChange={(ref) =>
                setItem((prev) => (prev ? { ...prev, fields: fieldsWithHeaderRef(prev.fields, ref) } : prev))
              }
              compact
            />
          )}
          {saved && <span className="jf-editor__status jf-editor__status--ok">✓ {t("common.saved")}</span>}
          {error && <span className="jf-editor__status jf-editor__status--error">{error}</span>}
          {previewUrl && (
            <a className="jf-btn jf-btn--onbar" href={previewUrl} target="_blank" rel="noreferrer">
              {t("pageBuilderPage.preview")} ↗
            </a>
          )}
          <button type="button" className="jf-btn jf-btn--onbar" disabled={saving} onClick={() => save(false)}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
          {item.status !== "published" || item.hasWorkingRevision ? (
            <button type="button" className="jf-btn jf-btn--primary" disabled={saving} onClick={() => save(true)}>
              {t("content.publish")}
            </button>
          ) : null}
        </div>
      </header>

      <div className="jf-editor__body">
        <PageBuilder
          value={item.blocks ?? { version: 1, blocks: [] }}
          onChange={(blocks) => setItem((prev) => (prev ? { ...prev, blocks } : prev))}
          isPage={isPage}
          mergeTags={mergeTags}
        />
      </div>
    </div>
  );
}
