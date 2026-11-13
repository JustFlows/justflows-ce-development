import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useNavigate } from "../../../admin-router";
import PageBuilder, { type BlockDocument } from "@components/builder/PageBuilder";
import HeaderRefField from "@components/builder/HeaderRefField";
import { useOptionalSessionUserId } from "@components/SessionProvider";
import { fieldsWithHeaderRef, headerRefFromFields } from "../../../lib/page-header";
import { fetchTypePattern, isEmptyBlockDocument, shouldSeedTypePattern, usesBlockEditor } from "../../../lib/content-layout";
import {
  clearRecovery,
  readRecovery,
  recoveryDiffers,
  recoveryKey,
  writeRecovery,
  type RecoveryEntry,
} from "../../../lib/builder-recovery";
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
  workingRevision?: { version?: number; updatedByName?: string | null } | null;
  translationGroupId?: string | null;
  excerpt?: string | null;
  blocks?: BlockDocument;
  fields?: Record<string, unknown>;
}

/** A 409 from the server: someone else changed the page or its draft. */
interface SaveConflict {
  code?: string;
  updatedByName?: string;
}

/** Quiet time after the last edit before the draft saves itself. */
const AUTOSAVE_MS = 4000;
/** Wait before an autosave that failed (offline, server error) tries again. */
const RETRY_MS = 15000;
/** Debounce for the browser-local recovery copy. */
const RECOVERY_MS = 400;

/**
 * The versions the server must still have for this save to apply. A published
 * page's edits live in its draft revision, so that draft's version is checked
 * too; `0` means "there was no draft when I loaded".
 */
function expectedVersions(item: ContentItem): { expectedVersion?: number; expectedWorkingVersion?: number } {
  return {
    expectedVersion: item.version,
    ...(item.status === "published" ? { expectedWorkingVersion: item.workingRevision?.version ?? 0 } : {}),
  };
}

export default function PageBuilderPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useT();
  const storageKey = recoveryKey(useOptionalSessionUserId(), id);

  const [item, setItem] = useState<ContentItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"idle" | "manual" | "autosave">("idle");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [recovery, setRecovery] = useState<RecoveryEntry | null>(null);
  const [mergeTags, setMergeTags] = useState<Record<string, string> | undefined>(undefined);
  const [blockEditor, setBlockEditor] = useState(false);

  /** The latest item, for saves that start from a timer. */
  const itemRef = useRef<ContentItem | null>(null);
  /** Bumped on every local edit, so a save can tell whether edits arrived while it was in flight. */
  const editSeq = useRef(0);
  const conflictRef = useRef<SaveConflict | null>(null);
  const savingRef = useRef(false);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const recoveryTimer = useRef<number | undefined>(undefined);
  const savedTimer = useRef<number | undefined>(undefined);
  const persistRef = useRef<(source: "manual" | "autosave", publish?: boolean) => Promise<void>>(async () => {});

  const setCurrent = useCallback((next: ContentItem | null) => {
    itemRef.current = next;
    setItem(next);
  }, []);

  const raiseConflict = useCallback((next: SaveConflict | null) => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

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
        setCurrent(data);
        setDirty(false);
        editSeq.current = 0;
        /** Offer back edits this browser kept but the server never received. */
        const kept = readRecovery(storageKey);
        if (kept && recoveryDiffers(kept, { title: data.title, blocks: data.blocks, fields: data.fields })) {
          setRecovery(kept);
        } else {
          clearRecovery(storageKey);
          setRecovery(null);
        }
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
  }, [id, attempt, storageKey, setCurrent]);

  useEffect(
    () => () => {
      window.clearTimeout(savedTimer.current);
      window.clearTimeout(autosaveTimer.current);
      window.clearTimeout(recoveryTimer.current);
    },
    [],
  );

  /** Warn before a reload or tab close would lose unsaved changes. */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const scheduleAutosave = useCallback((delay: number) => {
    window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => void persistRef.current("autosave"), delay);
  }, []);

  const keepRecoveryCopy = useCallback(() => {
    const current = itemRef.current;
    if (!current) return;
    writeRecovery(storageKey, { title: current.title, blocks: current.blocks, fields: current.fields }, current.version);
  }, [storageKey]);

  const update = useCallback(
    (patch: Partial<ContentItem>) => {
      const current = itemRef.current;
      if (!current) return;
      setCurrent({ ...current, ...patch });
      editSeq.current += 1;
      setDirty(true);
      setSaved(false);
      window.clearTimeout(recoveryTimer.current);
      recoveryTimer.current = window.setTimeout(keepRecoveryCopy, RECOVERY_MS);
      if (!conflictRef.current) scheduleAutosave(AUTOSAVE_MS);
    },
    [setCurrent, keepRecoveryCopy, scheduleAutosave],
  );

  /** Read a failed response: a conflict stops saving until the author decides; anything else is an error. */
  const failure = useCallback(
    async (res: Response, fallback: string): Promise<"conflict" | Error> => {
      const body = (await res.json().catch(() => ({}))) as SaveConflict & { error?: string };
      if (res.status === 409) {
        window.clearTimeout(autosaveTimer.current);
        keepRecoveryCopy();
        raiseConflict({ code: body.code, updatedByName: body.updatedByName });
        return "conflict";
      }
      if (res.status === 401) return new Error(t("builder.shell.sessionExpired"));
      return new Error(body.error ?? fallback);
    },
    [keepRecoveryCopy, raiseConflict, t],
  );

  const persist = useCallback(
    async (source: "manual" | "autosave", publish = false) => {
      const current = itemRef.current;
      if (!current || conflictRef.current || savingRef.current) return;
      if (source === "autosave" && editSeq.current === 0) return;
      window.clearTimeout(autosaveTimer.current);
      const seq = editSeq.current;
      savingRef.current = true;
      setSaving(source);
      setError("");
      try {
        const res = await fetch(`/api/content/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: current.title,
            slug: current.slug,
            blocks: current.blocks,
            fields: current.fields,
            ...expectedVersions(current),
            source,
          }),
        });
        if (!res.ok) {
          const failed = await failure(res, t("pageBuilderPage.saveFailed"));
          if (failed === "conflict") return;
          throw failed;
        }
        let data = (await res.json()) as ContentItem;
        if (publish) {
          const published = await fetch(`/api/content/${id}/publish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(expectedVersions(data)),
          });
          if (!published.ok) {
            const failed = await failure(published, t("pageBuilderPage.publishFailed"));
            if (failed === "conflict") return;
            throw failed;
          }
          data = (await published.json()) as ContentItem;
        }
        if (editSeq.current === seq) {
          setCurrent(data);
          editSeq.current = 0;
          setDirty(false);
          clearRecovery(storageKey);
          setSaved(true);
          window.clearTimeout(savedTimer.current);
          savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
        } else {
          /** Edits arrived mid-save: keep them, adopt the new versions, and save again soon. */
          const latest = itemRef.current ?? current;
          setCurrent({
            ...latest,
            version: data.version,
            status: data.status,
            hasWorkingRevision: data.hasWorkingRevision,
            workingRevision: data.workingRevision,
          });
          scheduleAutosave(AUTOSAVE_MS);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (editSeq.current > 0) scheduleAutosave(RETRY_MS);
      } finally {
        savingRef.current = false;
        setSaving("idle");
      }
    },
    [id, failure, setCurrent, storageKey, scheduleAutosave, t],
  );
  persistRef.current = persist;

  /** Drop local edits for the server's current version; they stay in the recovery copy and are offered back. */
  const loadLatest = useCallback(() => {
    keepRecoveryCopy();
    raiseConflict(null);
    setAttempt((n) => n + 1);
  }, [keepRecoveryCopy, raiseConflict]);

  /** Explicitly save this editor's version over the newer one. */
  const overwrite = useCallback(async () => {
    if (!window.confirm(t("builder.shell.overwriteConfirm"))) return;
    try {
      const res = await fetch(`/api/content/${id}`);
      if (!res.ok) throw new Error(t("pageBuilderPage.loadError"));
      const latest = (await res.json()) as ContentItem;
      const current = itemRef.current;
      if (!current) return;
      setCurrent({
        ...current,
        version: latest.version,
        status: latest.status,
        hasWorkingRevision: latest.hasWorkingRevision,
        workingRevision: latest.workingRevision,
      });
      raiseConflict(null);
      editSeq.current = Math.max(editSeq.current, 1);
      await persistRef.current("manual");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, raiseConflict, setCurrent, t]);

  const restoreRecovery = useCallback(() => {
    if (!recovery) return;
    update({ title: recovery.title, blocks: recovery.blocks as BlockDocument, fields: recovery.fields });
    setRecovery(null);
  }, [recovery, update]);

  const discardRecovery = useCallback(() => {
    clearRecovery(storageKey);
    setRecovery(null);
  }, [storageKey]);

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
  const saveState: BuilderSaveState = conflict
    ? "conflict"
    : saving === "manual"
      ? "saving"
      : saving === "autosave"
        ? "autosaving"
        : error
          ? "error"
          : saved
            ? "saved"
            : dirty
              ? "dirty"
              : "idle";
  const busy = saving !== "idle";

  const notice = conflict ? (
    <>
      <p>
        {conflict.code === "draft_conflict"
          ? conflict.updatedByName
            ? t("builder.shell.conflictDraftBy", { name: conflict.updatedByName })
            : t("builder.shell.conflictDraft")
          : t("builder.shell.conflictLive")}
      </p>
      <button type="button" className="jf-btn jf-btn--sm jf-btn--primary" onClick={loadLatest}>
        {t("builder.shell.loadLatest")}
      </button>
      <button type="button" className="jf-btn jf-btn--sm" onClick={() => void overwrite()}>
        {t("builder.shell.overwrite")}
      </button>
    </>
  ) : recovery ? (
    <>
      <p>{t("builder.shell.recoveryFound", { time: new Date(recovery.savedAt).toLocaleString() })}</p>
      <button type="button" className="jf-btn jf-btn--sm jf-btn--primary" onClick={restoreRecovery}>
        {t("builder.shell.restore")}
      </button>
      <button type="button" className="jf-btn jf-btn--sm" onClick={discardRecovery}>
        {t("builder.shell.discard")}
      </button>
    </>
  ) : undefined;

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
        notice,
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
            <button type="button" className="jf-btn jf-btn--onbar" disabled={busy || Boolean(conflict)} onClick={() => void persist("manual")}>
              {saving === "manual" ? t("common.saving") : t("common.save")}
            </button>
            {item.status !== "published" || item.hasWorkingRevision || dirty ? (
              <button type="button" className="jf-btn jf-btn--primary" disabled={busy || Boolean(conflict)} onClick={() => void persist("manual", true)}>
                {t("content.publish")}
              </button>
            ) : null}
          </>
        ),
      }}
    />
  );
}
