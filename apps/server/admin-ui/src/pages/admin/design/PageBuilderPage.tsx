import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useNavigate } from "../../../admin-router";
import PageBuilder, { type BlockDocument } from "@components/builder/PageBuilder";
import HeaderRefField from "@components/builder/HeaderRefField";
import { fieldsWithHeaderRef, headerRefFromFields } from "../../../lib/page-header";
import { fetchTypePattern, isEmptyBlockDocument, shouldSeedTypePattern, usesBlockEditor } from "../../../lib/content-layout";
import { useT } from "../../../i18n/I18nProvider";
import type { BuilderSaveState } from "@components/builder/shell/BuilderShell";

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
  const [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const savedTimer = useRef<number | undefined>(undefined);
  const [error, setError] = useState("");
  const [mergeTags, setMergeTags] = useState<Record<string, string> | undefined>(undefined);
  const [blockEditor, setBlockEditor] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError("");
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
  }, [id, attempt]);

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  /** Warn before a reload or tab close would lose unsaved changes. */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const update = useCallback((patch: Partial<ContentItem>) => {
    setItem((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
    setSaved(false);
  }, []);

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
      setDirty(false);
      setSaved(true);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [item, id]);

  if (loading && !item) {
    return (
      <div className="jf-center" role="status" aria-live="polite">
        {t("pageBuilderPage.loading")}
      </div>
    );
  }

  if (!item) {
    return (
      <div className="jf-center">
        <div className="jf-alert jf-alert--error" role="alert">
          <p>{error || t("pageBuilderPage.notFound")}</p>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button type="button" className="jf-btn jf-btn--primary" onClick={() => setAttempt((n) => n + 1)}>
              {t("builder.shell.retry")}
            </button>
            <button type="button" className="jf-btn" onClick={() => navigate(`/admin/content/${id}`)}>
              {t("common.back")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isPage = usesBlockEditor(item.type, blockEditor);
  const previewUrl = item.slug ? `${item.slug.startsWith("/") ? item.slug : `/${item.slug}`}?preview=1` : null;
  const saveState: BuilderSaveState = saving ? "saving" : error ? "error" : saved ? "saved" : dirty ? "dirty" : "idle";

  return (
    <PageBuilder
      value={item.blocks ?? { version: 1, blocks: [] }}
      onChange={(blocks) => update({ blocks })}
      isPage={isPage}
      mergeTags={mergeTags}
      context={isPage ? "page" : "post"}
      shellBar={{
        title: item.title || t("pageBuilderPage.untitledPage"),
        subtitle: `${t("pageBuilderPage.statusLine", { status: item.status })}${item.hasWorkingRevision ? t("pageBuilderPage.draftChangesSuffix") : ""}`,
        onExit: () => {
          if (dirty && !window.confirm(t("builder.shell.leaveUnsaved"))) return;
          navigate(`/admin/content/${id}`);
        },
        saveState,
        saveError: error,
        previewUrl,
        actions: (
          <>
            {isPage && (
              <HeaderRefField
                contentId={item.id}
                value={headerRefFromFields(item.fields)}
                onChange={(ref) => update({ fields: fieldsWithHeaderRef(item.fields, ref) })}
                compact
              />
            )}
            <button type="button" className="jf-btn jf-btn--onbar" disabled={saving} onClick={() => save(false)}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
            {item.status !== "published" || item.hasWorkingRevision || dirty ? (
              <button type="button" className="jf-btn jf-btn--primary" disabled={saving} onClick={() => save(true)}>
                {t("content.publish")}
              </button>
            ) : null}
          </>
        ),
      }}
    />
  );
}
