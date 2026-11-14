// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Link, useNavigate } from "../../../admin-router";
import PageBuilder, { type BlockDocument } from "@components/builder/PageBuilder";
import GlobalStylesPanel from "@components/builder/GlobalStylesPanel";
import RevisionsDialog from "@components/builder/shell/RevisionsDialog";
import { BuilderShellEmpty, type BuilderSaveState, type BuilderShellBar } from "@components/builder/shell/BuilderShell";
import { usageSummary } from "@components/builder/ReusablePanel";
import { useT } from "../../../i18n/I18nProvider";
import { docBlocks, getDocumentHistoryDoc, listDocumentHistory } from "../../../lib/document-history";
import { fetchReusableUsage, loadReusableBlocks, reusableEditPath, type ReusableItem, type ReusableUsage } from "../../../lib/reusable-blocks";
import { safeBackPath } from "../../../lib/site-context";

/**
 * A reusable block (or synced pattern) as its own builder document
 * (justflows-ce#304). Edits are saved as a draft that only previews show;
 * Publish changes every page that uses the block, after saying how many.
 * Revisions, rename, duplicate and delete live here too. Deleting a block
 * that is still used needs a second, explicit confirmation.
 */
export default function ReusableBuilderPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useT();
  const back = safeBackPath(searchParams.get("back"));
  const [item, setItem] = useState<ReusableItem | null>(null);
  const [doc, setDoc] = useState<BlockDocument>({ version: 1, blocks: [] });
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<BuilderSaveState>("idle");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [usage, setUsage] = useState<ReusableUsage | null>(null);
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/reusable-blocks/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(t("builder.reusable.notFound"));
      const body = (await res.json()) as { item: ReusableItem };
      setItem(body.item);
      setDoc({ version: 1, blocks: body.item.draft?.blocks ?? body.item.blocks ?? [] });
      setDirty(false);
      setConflict(false);
      setError("");
    } catch (err) {
      setItem(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!item) return;
    let alive = true;
    fetchReusableUsage(item.id)
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage(null));
    return () => {
      alive = false;
    };
  }, [item?.id, item?.revision]);

  const exit = () => {
    if (dirty && !window.confirm(t("builder.shell.leaveUnsaved"))) return;
    navigate(back ?? "/admin/content");
  };

  async function request(url: string, init: RequestInit): Promise<ReusableItem | null> {
    const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
    const body = (await res.json().catch(() => ({}))) as { item?: ReusableItem; error?: string; code?: string };
    if (res.status === 409 && body.code === "revision_conflict") {
      setConflict(true);
      throw new Error(body.error ?? t("builder.shell.conflictPart"));
    }
    if (!res.ok) throw new Error(body.error ?? t("ui.reusablePanel.couldNotSave"));
    return body.item ?? null;
  }

  async function saveDraft(): Promise<ReusableItem | null> {
    if (!item) return null;
    setState("saving");
    try {
      const saved = await request("/api/reusable-blocks", {
        method: "PUT",
        body: JSON.stringify({ id: item.id, name: item.name, blocks: doc.blocks, draft: true, expectedRevision: item.revision }),
      });
      if (saved) setItem(saved);
      setDirty(false);
      setState("saved");
      void loadReusableBlocks(true);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState(conflict ? "conflict" : "error");
      return null;
    }
  }

  async function publish() {
    if (!item) return;
    const message = usage && usage.total > 0 ? t("builder.reusable.publishConfirm", { count: usage.total }) : t("builder.reusable.publishConfirmUnused");
    if (!window.confirm(message)) return;
    const drafted = dirty || !item.draft ? await saveDraft() : item;
    if (!drafted) return;
    setState("saving");
    try {
      const published = await request(`/api/reusable-blocks/${encodeURIComponent(item.id)}/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: drafted.revision }),
      });
      if (published) {
        setItem(published);
        setDoc({ version: 1, blocks: published.blocks ?? [] });
      }
      setState("saved");
      void loadReusableBlocks(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  async function discard() {
    if (!item?.draft && !dirty) return;
    if (!window.confirm(t("builder.reusable.discardConfirm"))) return;
    await fetch(`/api/reusable-blocks/${encodeURIComponent(id)}/discard`, { method: "POST" });
    await load();
    void loadReusableBlocks(true);
  }

  async function rename() {
    if (!item) return;
    const name = window.prompt(t("builder.reusable.name"), item.name)?.trim();
    if (!name || name === item.name) return;
    const renamed = await request(`/api/reusable-blocks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (renamed) setItem(renamed);
    void loadReusableBlocks(true);
  }

  async function duplicate() {
    if (!item) return;
    const copy = await request(`/api/reusable-blocks/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: JSON.stringify({}) }).catch(
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      },
    );
    if (!copy) return;
    void loadReusableBlocks(true);
    navigate(reusableEditPath(copy.id, back ?? undefined));
  }

  async function remove() {
    if (!item) return;
    if (!window.confirm(t("builder.reusable.deleteConfirm", { name: item.name }))) return;
    let res = await fetch(`/api/reusable-blocks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { usage?: ReusableUsage };
      if (!window.confirm(t("builder.reusable.deleteUsedConfirm", { name: item.name, count: body.usage?.total ?? 0 }))) return;
      res = await fetch(`/api/reusable-blocks/${encodeURIComponent(id)}?confirm=1`, { method: "DELETE" });
    }
    if (!res.ok) {
      setError(t("builder.reusable.deleteFailed"));
      return;
    }
    void loadReusableBlocks(true);
    navigate(back ?? "/admin/content");
  }

  const historyState = (s: "draft" | "published") => (s === "published" ? t("builder.shell.statePublished") : t("builder.shell.stateDraft"));

  const usagePanel = (
    <nav aria-label={t("builder.reusable.usageTitle")}>
      <p className="jf-site-nav__heading">{t("builder.reusable.usageTitle")}</p>
      <p className="jf-field__hint">{usageSummary(t, usage)}</p>
      {usage && usage.content.length > 0 && (
        <ul className="jf-site-panel">
          {usage.content.map((c) => (
            <li key={c.id} className="jf-site-panel__row">
              <span>
                {c.title || t("pageBuilderPage.untitledPage")} <span className="jf-presets__id">{c.type} · {c.locale}</span>
              </span>
              <Link to={`/admin/content/${encodeURIComponent(c.id)}/builder`}>{t("builder.reusable.open")}</Link>
            </li>
          ))}
        </ul>
      )}
      {usage && (usage.templateParts.length > 0 || usage.templates.length > 0 || usage.menus.length > 0 || usage.reusableBlocks.length > 0 || usage.patterns.length > 0) && (
        <p className="jf-field__hint">
          {[
            ...usage.templateParts.map((part) => t("builder.reusable.inPart", { part })),
            ...usage.templates.map((slug) => t("builder.reusable.inTemplate", { slug })),
            ...usage.menus.map((slug) => t("builder.reusable.inMenu", { slug })),
            ...(usage.reusableBlocks.length ? [t("builder.reusable.inReusable", { count: usage.reusableBlocks.length })] : []),
            ...(usage.patterns.length ? [t("builder.reusable.inPatterns", { count: usage.patterns.length })] : []),
          ].join(" · ")}
        </p>
      )}
      {usage?.truncated && <p className="jf-field__hint">{t("builder.reusable.usageTruncated")}</p>}
    </nav>
  );

  const bar: BuilderShellBar = {
    title: item ? item.name : t("builder.reusable.title"),
    subtitle: item
      ? `${t("builder.shell.context.reusable")} · ${item.draft || dirty ? t("builder.reusable.stateDraft") : t("builder.reusable.statePublished", { revision: item.revision ?? 1 })}`
      : undefined,
    onExit: exit,
    saveState: dirty ? "dirty" : state,
    saveError: error,
    notice: conflict ? (
      <>
        <p>{t("builder.shell.conflictPart")}</p>
        <button type="button" className="jf-btn jf-btn--sm jf-btn--primary" onClick={() => void load()}>
          {t("builder.shell.loadLatest")}
        </button>
      </>
    ) : undefined,
    actions: item ? (
      <>
        <button type="button" className="jf-btn jf-btn--onbar" onClick={() => void rename()}>
          {t("builder.reusable.rename")}
        </button>
        <button type="button" className="jf-btn jf-btn--onbar" onClick={() => void duplicate()}>
          {t("builder.actions.duplicate")}
        </button>
        <button type="button" className="jf-btn jf-btn--onbar" onClick={() => setRevisionsOpen(true)}>
          {t("builder.shell.revisions")}
        </button>
        <button type="button" className="jf-btn jf-btn--onbar" onClick={() => void remove()}>
          {t("builder.actions.delete")}
        </button>
        {(item.draft || dirty) && (
          <button type="button" className="jf-btn jf-btn--onbar" onClick={() => void discard()}>
            {t("builder.reusable.discard")}
          </button>
        )}
        <button type="button" className="jf-btn jf-btn--onbar" disabled={state === "saving" || conflict} onClick={() => void saveDraft()}>
          {t("content.saveDraft")}
        </button>
        <button type="button" className="jf-btn jf-btn--primary" disabled={state === "saving" || conflict || (!item.draft && !dirty)} onClick={() => void publish()}>
          {t("content.publish")}
        </button>
      </>
    ) : undefined,
  };

  if (!item) {
    return (
      <BuilderShellEmpty bar={bar} sitePanel={null}>
        <p>{loading ? t("builder.siteContext.loading") : error || t("builder.reusable.notFound")}</p>
      </BuilderShellEmpty>
    );
  }

  return (
    <>
      <RevisionsDialog
        open={revisionsOpen}
        onClose={() => setRevisionsOpen(false)}
        loadItems={() => listDocumentHistory("reusable_block", item.id, historyState)}
        loadBlocks={async (rev) => docBlocks(await getDocumentHistoryDoc("reusable_block", item.id, rev))}
        currentBlocks={doc.blocks}
        onRestore={async (rev) => {
          setDoc({ version: 1, blocks: docBlocks(await getDocumentHistoryDoc("reusable_block", item.id, rev)) });
          setDirty(true);
        }}
        restoreHint={t("builder.reusable.restoreHint")}
      />
      <PageBuilder
        value={doc}
        onChange={(next) => {
          setDoc(next);
          setDirty(true);
          setState("idle");
        }}
        context="reusable"
        flatCanvas
        shellBar={bar}
        sitePanel={usagePanel}
        stylesPanel={<GlobalStylesPanel />}
      />
    </>
  );
}
