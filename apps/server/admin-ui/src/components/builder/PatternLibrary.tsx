import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../../admin-router";
import { useT } from "../../i18n/I18nProvider";
import type { BlockCatalogEntry, BlockNode } from "./types";
import { BlockPreview, THEME_PREVIEW_SCOPE, usePreviewScheme, useThemePreviewStylesheet } from "./BlockPreview";
import { patternReplacesCanvas } from "./pattern-insert";

interface PatternMeta {
  id: string;
  title: string;
  description?: string;
  category?: string;
  version: string;
  source: "site" | "theme" | "plugin" | "directory";
  synced?: boolean;
  requiresBlockTypes?: string[];
}

function PreviewTree({ blocks }: { blocks: BlockNode[] }) {
  const render = (items: BlockNode[], depth: number): React.ReactNode =>
    items.map((block) => (
      <BlockPreview key={block.id} block={block} depth={depth} renderChildren={render} />
    ));
  useThemePreviewStylesheet();
  const scheme = usePreviewScheme();
  return <div className={THEME_PREVIEW_SCOPE} data-theme={scheme}>{render(blocks, 0)}</div>;
}

export default function PatternLibrary({
  catalog,
  currentBlocks,
  onInsert,
}: {
  catalog: BlockCatalogEntry[];
  currentBlocks: BlockNode[];
  onInsert: (blocks: BlockNode[], syncedRef?: string, replaceCanvas?: boolean) => void;
}) {
  const { locale, t } = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [patterns, setPatterns] = useState<PatternMeta[]>([]);
  const [selected, setSelected] = useState<PatternMeta | null>(null);
  const [preview, setPreview] = useState<BlockNode[]>([]);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const catalogTypes = useMemo(() => new Set(catalog.map((entry) => entry.type)), [catalog]);

  async function reload(includeDirectory = false) {
    setError("");
    try {
      const res = await fetch(
        `/api/patterns?locale=${encodeURIComponent(locale)}${includeDirectory ? "&directory=1" : ""}`,
      );
      if (!res.ok) throw new Error(t("builder.patterns.loadError"));
      const data = (await res.json()) as { patterns?: PatternMeta[] };
      setPatterns(data.patterns ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("builder.patterns.loadError"));
    }
  }

  async function choose(pattern: PatternMeta) {
    setSelected(pattern);
    setPreview([]);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/patterns/${pattern.source}/${encodeURIComponent(pattern.id)}?locale=${encodeURIComponent(locale)}`,
      );
      if (!res.ok) throw new Error(t("builder.patterns.patternLoadError"));
      const data = (await res.json()) as { pattern?: { blocks?: BlockNode[] } };
      setPreview(data.pattern?.blocks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("builder.patterns.patternLoadError"));
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent() {
    if (!currentBlocks.length) return;
    const title = window.prompt(t("builder.patterns.name"));
    if (!title?.trim()) return;
    setBusy(true);
    try {
      const usedTypes = new Set<string>();
      const visit = (items: BlockNode[]) =>
        items.forEach((block) => {
          if (!block.type.startsWith("core.")) usedTypes.add(block.type);
          if (block.children) visit(block.children);
        });
      visit(currentBlocks);
      const res = await fetch("/api/patterns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: t("builder.patterns.saveDescription"),
          category: "site",
          requiresBlockTypes: [...usedTypes],
          blocks: currentBlocks,
          synced: window.confirm(t("builder.patterns.syncConfirm")),
        }),
      });
      if (!res.ok)
        throw new Error(
          ((await res.json()) as { error?: string }).error ?? t("ui.patternLibrary.couldNotSavePattern"),
        );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("builder.patterns.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const res = await fetch("/api/patterns/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!res.ok)
        throw new Error(((await res.json()) as { error?: string }).error ?? t("ui.patternLibrary.invalidPatternSet"));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("builder.patterns.importError"));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeSelected() {
    if (!selected || selected.source !== "site" || !window.confirm(t("common.deleteNamed", { name: selected.title })))
      return;
    const res = await fetch(`/api/patterns/${encodeURIComponent(selected.id)}`, {
      method: "DELETE",
    });
    if (!res.ok) return setError(t("builder.patterns.deleteError"));
    setSelected(null);
    setPreview([]);
    await reload();
  }

  async function updateSelected() {
    if (!selected || selected.source !== "site" || !currentBlocks.length) return;
    setBusy(true);
    try {
      const usedTypes = new Set<string>();
      const visit = (items: BlockNode[]) =>
        items.forEach((block) => {
          if (!block.type.startsWith("core.")) usedTypes.add(block.type);
          if (block.children) visit(block.children);
        });
      visit(currentBlocks);
      const res = await fetch("/api/patterns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selected.id,
          title: selected.title,
          description: selected.description,
          category: selected.category ?? "site",
          version: selected.version,
          synced: selected.synced === true,
          blocks: currentBlocks,
          requiresBlockTypes: [...usedTypes],
        }),
      });
      if (!res.ok) throw new Error(t("builder.patterns.saveError"));
      await reload();
      await choose(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("builder.patterns.saveError"));
    } finally {
      setBusy(false);
    }
  }

  const categories = useMemo(
    () => ["all", ...new Set(patterns.map((p) => p.category ?? "sections"))],
    [patterns],
  );
  const visible = patterns.filter(
    (p) =>
      (category === "all" || (p.category ?? "sections") === category) &&
      (!query.trim() ||
        `${p.title} ${p.description ?? ""}`.toLowerCase().includes(query.toLowerCase())),
  );
  const missing = (selected?.requiresBlockTypes ?? []).filter((type) => !catalogTypes.has(type));

  return (
    <>
      <button
        type="button"
        className="jf-pattern-browser-button"
        onClick={() => {
          void reload();
          dialog.current?.showModal();
        }}
      >
        <span className="jf-pattern-browser-button__icon" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className="jf-pattern-browser-button__copy">
          <strong>{t("builder.patterns.browse")}</strong>
          <small>{t("builder.patterns.browseHint")}</small>
        </span>
        <span className="jf-pattern-browser-button__arrow" aria-hidden="true">
          ›
        </span>
      </button>
      <dialog
        ref={dialog}
        className="jf-pattern-library"
        dir={/^(ar|fa|he|ur)(-|$)/i.test(locale) ? "rtl" : "ltr"}
        aria-labelledby="jf-pattern-title"
      >
        <div className="jf-pattern-library__shell">
          <header className="jf-pattern-library__header">
            <div className="jf-pattern-library__heading">
              <h2 id="jf-pattern-title">{t("builder.patterns.title")}</h2>
              <span>{t("builder.patterns.results", { count: visible.length })}</span>
            </div>
            <button
              type="button"
              className="jf-btn jf-btn--primary"
              disabled={!currentBlocks.length || busy}
              onClick={saveCurrent}
            >
              {t("builder.patterns.save")}
            </button>
            <details className="jf-pattern-library__manage">
              <summary className="jf-btn jf-btn--secondary">{t("builder.patterns.manage")}</summary>
              <div className="jf-pattern-library__menu">
                <button type="button" onClick={() => fileInput.current?.click()}>
                  <span aria-hidden="true">↑</span>
                  <span>{t("builder.patterns.import")}</span>
                </button>
                <a href="/api/patterns/export" download>
                  <span aria-hidden="true">↓</span>
                  <span>{t("builder.patterns.export")}</span>
                </a>
                <button type="button" onClick={() => void reload(true)}>
                  <span aria-hidden="true">◎</span>
                  <span>{t("builder.patterns.loadDirectory")}</span>
                </button>
              </div>
            </details>
            <input
              ref={fileInput}
              hidden
              type="file"
              accept="application/json,.json"
              onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
            />
            <button
              type="button"
              className="jf-pattern-library__close"
              onClick={() => dialog.current?.close()}
              aria-label={t("builder.patterns.close")}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div className="jf-pattern-library__body">
            <aside className="jf-pattern-library__sidebar">
              <div className="jf-pattern-library__filters">
                <input
                  type="search"
                  aria-label={t("builder.patterns.search")}
                  placeholder={t("builder.patterns.search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <label>
                  <span>{t("builder.patterns.category")}</span>
                  <select value={category} onChange={(event) => setCategory(event.target.value)}>
                    {categories.map((item) => (
                      <option key={item} value={item}>
                        {item === "all" ? t("builder.patterns.all") : item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {error && (
                <p role="alert" className="jf-block-panel__error">
                  {error}
                </p>
              )}
              <div className="jf-pattern-library__list">
                {visible.map((pattern) => (
                  <button
                    type="button"
                    key={`${pattern.source}:${pattern.id}`}
                    onClick={() => void choose(pattern)}
                    aria-pressed={selected?.id === pattern.id && selected.source === pattern.source}
                    className="jf-pattern-library__item"
                  >
                    <strong>{pattern.title}</strong>
                    <br />
                    <small>
                      {pattern.category} · {pattern.source}
                      {pattern.synced ? ` · ${t("builder.patterns.synced")}` : ""}
                    </small>
                  </button>
                ))}
                {visible.length === 0 && (
                  <p className="jf-pattern-library__no-results">
                    {t("builder.patterns.noResults")}
                  </p>
                )}
              </div>
            </aside>
            <main className="jf-pattern-library__preview">
              {!selected && (
                <div className="jf-empty">
                  <p>{t("builder.patterns.choose")}</p>
                </div>
              )}
              {selected && (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "start",
                      gap: 12,
                      maxWidth: 900,
                      margin: "0 auto 12px",
                    }}
                  >
                    <div style={{ marginInlineEnd: "auto" }}>
                      <h3 style={{ margin: 0 }}>{selected.title}</h3>
                      <p style={{ margin: "4px 0" }}>{selected.description}</p>
                    </div>
                    {selected.source === "site" && (
                      <button
                        type="button"
                        className="jf-btn jf-btn--secondary"
                        disabled={!currentBlocks.length || busy}
                        onClick={updateSelected}
                      >
                        {t("builder.patterns.update")}
                      </button>
                    )}
                    {selected.source === "site" && (
                      <button
                        type="button"
                        className="jf-btn jf-btn--danger"
                        onClick={removeSelected}
                      >
                        {t("builder.patterns.delete")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="jf-btn jf-btn--primary"
                      disabled={busy || !preview.length || missing.length > 0}
                      onClick={() => {
                        onInsert(
                          preview,
                          selected.synced ? selected.id : undefined,
                          patternReplacesCanvas(selected.category),
                        );
                        dialog.current?.close();
                      }}
                    >
                      {selected.synced ? t("builder.patterns.insertLinked") : t("builder.patterns.insert")}
                    </button>
                  </div>
                  {/** Linked or copied is a real difference for the author; say which before inserting (justflows-ce#304). */}
                  <p className="jf-field__hint" style={{ maxWidth: 900, margin: "0 auto 8px" }}>
                    {selected.synced ? t("builder.patterns.insertLinkedHint") : t("builder.patterns.insertCopyHint")}
                  </p>
                  {missing.length > 0 && (
                    <p role="alert" style={{ maxWidth: 900, margin: "0 auto 12px" }}>
                      {t("builder.patterns.requires", { types: missing.join(", ") })}{" "}
                      <Link to="/admin/plugins">{t("builder.patterns.manageExtensions")}</Link>.
                    </p>
                  )}
                  {/**
                   * The preview is a picture of the pattern, not a page: `inert`
                   * keeps its links and buttons from being clicked or focused, and
                   * paint/layout containment keeps positioned content (a stretched
                   * card link, a fixed bar) inside this box instead of covering the
                   * dialog and its Insert button.
                   */}
                  <div
                    className="jf-pattern-library__frame"
                    inert
                    style={{
                      width: 900,
                      maxWidth: "100%",
                      margin: "0 auto",
                      background: "var(--jf-surface)",
                      boxShadow: "0 1px 4px rgb(0 0 0 / .12)",
                      position: "relative",
                      overflow: "hidden",
                      contain: "layout paint",
                    }}
                    aria-busy={busy}
                  >
                    {busy ? (
                      <p style={{ padding: 24 }}>{t("builder.patterns.loading")}</p>
                    ) : (
                      <PreviewTree blocks={preview} />
                    )}
                  </div>
                </>
              )}
            </main>
          </div>
        </div>
      </dialog>
    </>
  );
}
