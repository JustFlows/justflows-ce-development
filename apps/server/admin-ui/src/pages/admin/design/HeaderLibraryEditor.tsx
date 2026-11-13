import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import PageBuilder from "@components/builder/PageBuilder";
import { BuilderShellEmpty, type BuilderSaveState, type BuilderShellBar } from "@components/builder/shell/BuilderShell";
import RevisionsDialog from "@components/builder/shell/RevisionsDialog";
import type { BlockNode } from "@components/builder/types";
import { getDocumentHistoryDoc, listDocumentHistory } from "../../../lib/document-history";
import {
  DEFAULT_PAGE_HEADER,
  diffPageHeader,
  mergePageHeaderClient,
  type PageHeaderConfig,
  type SiteHeaderEntryDTO,
  type SiteHeaderLibraryDTO,
} from "../../../lib/page-header";
import { uid } from "../../../lib/uid";
import { useT } from "../../../i18n/I18nProvider";

interface ActiveLanguage {
  code: string;
  nativeName?: string;
  isDefault?: boolean;
}

const BASE_LOCALE = "";

/** Every block in a header library, base and per-locale, for comparing versions. */
function libraryBlocks(lib: SiteHeaderLibraryDTO | null): BlockNode[] {
  if (!lib || !Array.isArray(lib.entries)) return [];
  return lib.entries.flatMap((entry) => [
    ...((entry.base?.blocks ?? []) as BlockNode[]),
    ...Object.values(entry.overrides ?? {}).flatMap((patch) => ((patch as { blocks?: unknown })?.blocks ?? []) as BlockNode[]),
  ]);
}

function emptyLib(): SiteHeaderLibraryDTO {
  return { version: 1, defaultId: null, entries: [] };
}

function newEntry(name: string): SiteHeaderEntryDTO {
  return {
    id: uid(),
    name,
    base: { ...DEFAULT_PAGE_HEADER, blocks: [] },
    overrides: {},
  };
}

interface HeaderLibraryEditorProps {
  /** Identity and exit for the shell's top bar; this editor adds its own save state and buttons. */
  bar: Omit<BuilderShellBar, "saveState" | "saveError" | "actions">;
  /** Theme builder navigation, shown above the header controls in the Site panel. */
  siteNav: ReactNode;
  /** Extra top-bar buttons shared by every theme builder part (e.g. Save as theme). */
  extraActions?: ReactNode;
}

/**
 * The theme customizer's "Header" tab: manage the site header library — named
 * headers, one marked the site default, each with optional per-locale
 * overrides — and edit the selected one with the shared header builder.
 */
export default function HeaderLibraryEditor({ bar, siteNav, extraActions }: HeaderLibraryEditorProps) {
  const { t } = useT();
  const [lib, setLib] = useState<SiteHeaderLibraryDTO>(emptyLib);
  const [entryId, setEntryId] = useState<string>("");
  const [locale, setLocale] = useState<string>(BASE_LOCALE);
  const [languages, setLanguages] = useState<ActiveLanguage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "error">("");
  const [dirty, setDirty] = useState(false);
  /** Revision the editor loaded, sent back so a save never overwrites someone else's newer library. */
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/headers")
      .then((r) => r.json())
      .then((body: { library?: SiteHeaderLibraryDTO; draft?: SiteHeaderLibraryDTO | null; revision?: number }) => {
        const next = body.draft ?? body.library ?? emptyLib();
        setLib(next);
        setEntryId((prev) => (next.entries.some((e) => e.id === prev) ? prev : (next.defaultId ?? next.entries[0]?.id ?? "")));
        setRevision(body.revision ?? 0);
        setDirty(false);
      })
      .catch(() => setLib(emptyLib()))
      .finally(() => setLoading(false));
  }, [reloadTick]);

  useEffect(() => {
    fetch("/api/languages/active")
      .then((r) => r.json())
      .then((data: { languages?: ActiveLanguage[] }) => setLanguages(data.languages ?? []))
      .catch(() => setLanguages([]));
  }, []);

  const entry = useMemo(
    () => lib.entries.find((e) => e.id === entryId) ?? null,
    [lib, entryId],
  );

  const effectiveConfig: PageHeaderConfig = useMemo(() => {
    if (!entry) return { ...DEFAULT_PAGE_HEADER, blocks: [] };
    return locale === BASE_LOCALE
      ? entry.base
      : mergePageHeaderClient(entry.base, entry.overrides[locale]);
  }, [entry, locale]);

  const updateEntry = useCallback(
    (id: string, updater: (e: SiteHeaderEntryDTO) => SiteHeaderEntryDTO) => {
      setLib((prev) => ({
        ...prev,
        entries: prev.entries.map((e) => (e.id === id ? updater(e) : e)),
      }));
      setStatus("");
      setDirty(true);
    },
    [],
  );

  const onConfigChange = useCallback(
    (next: PageHeaderConfig) => {
      if (!entry) return;
      if (locale === BASE_LOCALE) {
        updateEntry(entry.id, (e) => ({ ...e, base: next }));
        return;
      }
      const patch = diffPageHeader(entry.base, next);
      updateEntry(entry.id, (e) => {
        const overrides = { ...e.overrides };
        if (Object.keys(patch).length === 0) delete overrides[locale];
        else overrides[locale] = patch;
        return { ...e, overrides };
      });
    },
    [entry, locale, updateEntry],
  );

  function addHeader() {
    const entryEl = newEntry(`Header ${lib.entries.length + 1}`);
    setLib((prev) => ({
      ...prev,
      defaultId: prev.defaultId ?? entryEl.id,
      entries: [...prev.entries, entryEl],
    }));
    setEntryId(entryEl.id);
    setLocale(BASE_LOCALE);
    setStatus("");
    setDirty(true);
  }

  function renameHeader() {
    if (!entry) return;
    const name = window.prompt(t("headerLibrary.renamePrompt"), entry.name)?.trim();
    if (!name) return;
    updateEntry(entry.id, (e) => ({ ...e, name: name.slice(0, 120) }));
  }

  function deleteHeader() {
    if (!entry) return;
    if (!window.confirm(t("headerLibrary.deleteConfirm", { name: entry.name }))) return;
    setLib((prev) => {
      const entries = prev.entries.filter((e) => e.id !== entry.id);
      return {
        ...prev,
        defaultId: prev.defaultId === entry.id ? (entries[0]?.id ?? null) : prev.defaultId,
        entries,
      };
    });
    setEntryId((prev) => (prev === entry.id ? "" : prev));
    setStatus("");
    setDirty(true);
  }

  function makeDefault() {
    if (!entry) return;
    setLib((prev) => ({ ...prev, defaultId: entry.id }));
    setStatus("");
    setDirty(true);
  }

  function clearLocaleOverride() {
    if (!entry || locale === BASE_LOCALE) return;
    updateEntry(entry.id, (e) => {
      const overrides = { ...e.overrides };
      delete overrides[locale];
      return { ...e, overrides };
    });
  }

  async function save(publish: boolean, expectedRevision = revision) {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/headers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ library: lib, draft: !publish, expectedRevision }),
      });
      const body = (await res.json()) as { error?: string; library?: SiteHeaderLibraryDTO; revision?: number };
      if (res.status === 409) {
        setConflict(true);
        return;
      }
      if (!res.ok) throw new Error(body.error ?? t("headerLibrary.saveError"));
      if (typeof body.revision === "number") setRevision(body.revision);
      setConflict(false);
      if (publish && body.library) {
        setLib(body.library);
        if (!body.library.entries.some((e) => e.id === entryId)) {
          setEntryId(body.library.defaultId ?? body.library.entries[0]?.id ?? "");
        }
      }
      setStatus("saved");
      setDirty(false);
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      setSaving(false);
    }
  }

  const overridden = Boolean(entry && locale !== BASE_LOCALE && entry.overrides[locale]);
  /** Replace local edits with the stored library. */
  const loadLatest = () => {
    setConflict(false);
    setReloadTick((n) => n + 1);
  };
  /** Explicitly save this editor's library over the newer one, as a draft. */
  const overwrite = async () => {
    if (!window.confirm(t("builder.shell.overwritePartConfirm"))) return;
    const latest = (await (await fetch("/api/headers")).json().catch(() => ({}))) as { revision?: number };
    setConflict(false);
    await save(false, latest.revision ?? 0);
  };
  const saveState: BuilderSaveState = conflict ? "conflict" : saving ? "saving" : status === "error" ? "error" : status === "saved" ? "saved" : dirty ? "dirty" : "idle";
  const shellBar: BuilderShellBar = {
    ...bar,
    saveState,
    saveError: error,
    notice: conflict ? (
      <>
        <p>{t("builder.shell.conflictPart")}</p>
        <button type="button" className="jf-btn jf-btn--sm jf-btn--primary" onClick={loadLatest}>
          {t("builder.shell.loadLatest")}
        </button>
        <button type="button" className="jf-btn jf-btn--sm" onClick={() => void overwrite()}>
          {t("builder.shell.overwrite")}
        </button>
      </>
    ) : undefined,
    actions: (
      <>
        {extraActions}
        <button type="button" className="jf-btn jf-btn--onbar" disabled={loading} onClick={() => setRevisionsOpen(true)}>
          {t("builder.shell.revisions")}
        </button>
        <button type="button" className="jf-btn jf-btn--onbar" disabled={saving || loading} onClick={() => void save(false)}>
          {saving ? t("common.saving") : t("content.saveDraft")}
        </button>
        <button type="button" className="jf-btn jf-btn--primary" disabled={saving || loading} onClick={() => void save(true)}>
          {t("content.publish")}
        </button>
      </>
    ),
  };

  const sitePanel = (
    <>
      {siteNav}
      {loading ? (
        <p className="jf-field__hint" role="status">{t("headerLibrary.loading")}</p>
      ) : (
        <>
        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-header-entry">{t("headerLibrary.headerLabel")}</label>
          <select
            id="jf-header-entry"
            className="jf-input"
            value={entryId}
            onChange={(e) => { setEntryId(e.target.value); setLocale(BASE_LOCALE); }}
          >
            {lib.entries.length === 0 && <option value="">{t("headerLibrary.noHeadersYet")}</option>}
            {lib.entries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}{e.id === lib.defaultId ? t("ui.headerLibraryEditor.default") : ""}
              </option>
            ))}
          </select>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button type="button" className="jf-btn jf-btn--sm jf-btn--ghost" onClick={addHeader}>{t("headerLibrary.new")}</button>
            {entry && (
              <button type="button" className="jf-btn jf-btn--sm jf-btn--ghost" onClick={renameHeader}>{t("headerLibrary.rename")}</button>
            )}
            {entry && (
              <button type="button" className="jf-btn jf-btn--sm jf-btn--ghost" onClick={deleteHeader}>{t("common.delete")}</button>
            )}
          </div>
          {entry && entry.id !== lib.defaultId && (
            <button
              type="button"
              className="jf-btn jf-btn--sm jf-btn--block"
              style={{ marginTop: "0.1rem" }}
              onClick={makeDefault}
            >
              {t("headerLibrary.setAsDefault")}
            </button>
          )}
          <p className="jf-field__hint">
            {entry?.id === lib.defaultId
              ? t("headerLibrary.hintIsDefault")
              : t("headerLibrary.hintChoosePerPage")}
          </p>
        </div>

        {entry && languages.length > 1 && (
          <div className="jf-field">
            <span className="jf-field__label">{t("headerLibrary.language")}</span>
            <div
              role="tablist"
              aria-label={t("headerLibrary.languageAriaLabel")}
              style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={locale === BASE_LOCALE}
                className={`jf-btn jf-btn--sm ${locale === BASE_LOCALE ? "jf-btn--primary" : "jf-btn--ghost"}`}
                onClick={() => setLocale(BASE_LOCALE)}
              >
                {t("headerLibrary.base")}
              </button>
              {languages.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  role="tab"
                  aria-selected={locale === l.code}
                  className={`jf-btn jf-btn--sm ${locale === l.code ? "jf-btn--primary" : "jf-btn--ghost"}`}
                  onClick={() => setLocale(l.code)}
                  title={entry.overrides[l.code] ? t("headerLibrary.overridesBase") : t("headerLibrary.inheritsBase")}
                >
                  {l.nativeName || l.code}{entry.overrides[l.code] ? " •" : ""}
                </button>
              ))}
            </div>
            {locale !== BASE_LOCALE && (
              <div className="jf-field__hint" style={{ display: "flex", flexDirection: "column", gap: "0.4rem", alignItems: "flex-start" }}>
                <span>
                  {overridden
                    ? t("headerLibrary.overriddenHint")
                    : t("headerLibrary.inheritedHint")}
                </span>
                {overridden && (
                  <button type="button" className="jf-btn jf-btn--sm jf-btn--ghost" onClick={clearLocaleOverride}>
                    {t("headerLibrary.resetToBase")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        </>
      )}
    </>
  );

  const revisionsDialog = (
    <RevisionsDialog
      open={revisionsOpen}
      onClose={() => setRevisionsOpen(false)}
      loadItems={() =>
        listDocumentHistory("template_part", "header", (state) =>
          state === "published" ? t("builder.shell.statePublished") : t("builder.shell.stateDraft"),
        )
      }
      loadBlocks={async (id) => libraryBlocks((await getDocumentHistoryDoc("template_part", "header", id)) as SiteHeaderLibraryDTO)}
      currentBlocks={libraryBlocks(lib)}
      onRestore={async (id) => {
        const restored = (await getDocumentHistoryDoc("template_part", "header", id)) as SiteHeaderLibraryDTO | null;
        if (!restored || !Array.isArray(restored.entries)) return;
        setLib(restored);
        setEntryId((prev) =>
          restored.entries.some((e) => e.id === prev) ? prev : (restored.defaultId ?? restored.entries[0]?.id ?? ""),
        );
        setLocale(BASE_LOCALE);
        setStatus("");
        setDirty(true);
      }}
      restoreHint={t("builder.shell.restoreHintPart")}
    />
  );

  if (loading || !entry) {
    return (
      <>
        {revisionsDialog}
        <BuilderShellEmpty bar={shellBar} sitePanel={sitePanel}>
          {loading ? <span role="status">{t("headerLibrary.loading")}</span> : <p>{t("headerLibrary.emptyState")}</p>}
        </BuilderShellEmpty>
      </>
    );
  }

  return (
    <>
    {revisionsDialog}
    <PageBuilder
      key={`${entry.id}:${locale}`}
      value={{ version: 1, blocks: effectiveConfig.blocks }}
      onChange={() => {}}
      enableHeader
      headerOnly
      isPage
      header={effectiveConfig}
      onHeaderChange={onConfigChange}
      shellBar={shellBar}
      sitePanel={sitePanel}
    />
    </>
  );
}
