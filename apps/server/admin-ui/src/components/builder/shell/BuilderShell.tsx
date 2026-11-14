// SPDX-License-Identifier: MIT
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { breakpointForWidth } from "@justflows/blocks";
import { useT } from "../../../i18n/I18nProvider";
import {
  BREAKPOINT_WIDTH,
  BUILDER_BREAKPOINTS,
  BUILDER_ZOOM_LEVELS,
  PREVIEW_WIDTH_MAX,
  PREVIEW_WIDTH_MIN,
  clampPreviewWidth,
  type BuilderPrefs,
  type BuilderZoom,
  type LeftPanelTab,
} from "./builder-prefs";
import { inertPreviewHandlers } from "../inert-preview";

/**
 * What the shell is editing. Decides the context badge and whether the
 * author is warned that changes reach beyond this document.
 */
export const BUILDER_CONTEXTS = ["page", "post", "header", "footer", "template", "reusable", "pattern", "fragment"] as const;
export type BuilderContext = (typeof BUILDER_CONTEXTS)[number];

/** Contexts whose changes show on more than one URL, with the warning each one shows. */
const SITE_WIDE_IMPACT: Partial<Record<BuilderContext, string>> = {
  header: "builder.shell.impact.header",
  footer: "builder.shell.impact.footer",
  template: "builder.shell.impact.template",
  reusable: "builder.shell.impact.reusable",
};

export function isSiteWideContext(context: BuilderContext): boolean {
  return context in SITE_WIDE_IMPACT;
}

export type BuilderSaveState = "idle" | "dirty" | "autosaving" | "saving" | "saved" | "error" | "conflict";

export interface BuilderCrumb {
  /** Block id, or `null` for the document root. */
  id: string | null;
  label: string;
}

/** The top bar a stand-alone builder route shows. Embedded builders omit it. */
export interface BuilderShellBar {
  title: string;
  subtitle?: string;
  onExit: () => void;
  saveState?: BuilderSaveState;
  saveError?: string;
  previewUrl?: string | null;
  /** Context-specific controls (header picker, save, publish). */
  actions?: ReactNode;
  /** A message that needs a decision (conflict, recovered changes), shown under the bar. */
  notice?: ReactNode;
}

export interface BuilderShellProps {
  context: BuilderContext;
  bar?: BuilderShellBar;
  prefs: BuilderPrefs;
  onPrefsChange: (patch: Partial<BuilderPrefs>) => void;
  history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
  previewScheme: "light" | "dark";
  onPreviewSchemeChange: (scheme: "light" | "dark") => void;
  blockCount: number;
  breadcrumbs: BuilderCrumb[];
  onSelectCrumb: (id: string | null) => void;
  /** Left panel content (the block library). */
  library: ReactNode;
  /**
   * Site navigation and document controls (theme parts, template slots, the
   * header list). When given, the left panel offers Blocks and Site tabs.
   */
  sitePanel?: ReactNode;
  /** The layers tree for the document (navigator). */
  layers?: ReactNode;
  /** Right panel content (the inspector). */
  inspector: ReactNode;
  /** Canvas content, already wrapped in the theme preview scope. */
  canvas: ReactNode;
  /** Background behind the page, painted in the previewed scheme. */
  canvasBackdrop?: ReactNode;
  /** Clicking empty canvas space clears the selection. */
  onCanvasBackgroundClick: () => void;
  /** The canvas's measured content width in CSS pixels, whenever it changes. */
  onCanvasWidthChange?: (width: number) => void;
}

/**
 * The one editing frame every block document opens in: pages, posts, header,
 * footer, templates, and reusable content.
 *
 * Layout: an optional top bar (identity, save state, actions, exit), a toolbar
 * (context, history, breakpoint, zoom, preview scheme, panel toggles), then a
 * collapsible library, the canvas, and a collapsible inspector. Panel state,
 * breakpoint, and zoom are per-user preferences and never part of a document.
 */
export default function BuilderShell({
  context,
  bar,
  prefs,
  onPrefsChange,
  history,
  previewScheme,
  onPreviewSchemeChange,
  blockCount,
  breadcrumbs,
  onSelectCrumb,
  library,
  sitePanel,
  layers,
  inspector,
  canvas,
  canvasBackdrop,
  onCanvasBackgroundClick,
  onCanvasWidthChange,
}: BuilderShellProps) {
  const { t } = useT();
  const leftId = useId();
  const rightId = useId();
  const contextNoteId = useId();
  /** The canvas content width to preview at; the frame adds its own padding around it. */
  const frameWidth = prefs.previewWidth ?? BREAKPOINT_WIDTH[prefs.breakpoint];
  const frame = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  const [widthDraft, setWidthDraft] = useState("");
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      const width = Math.round(el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
      setMeasured(width);
      onCanvasWidthChange?.(width);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onCanvasWidthChange]);
  const impactKey = SITE_WIDE_IMPACT[context];
  const siteWide = Boolean(impactKey);

  return (
    <div className={`jf-shell${bar ? " jf-shell--page" : ""}`} data-context={context}>
      {bar && <ShellBar bar={bar} />}

      <div className="jf-shell__toolbar" role="toolbar" aria-label={t("builder.shell.toolbar")}>
        <button
          type="button"
          className="jf-builder-toolbar__btn"
          aria-expanded={prefs.leftOpen}
          aria-controls={leftId}
          onClick={() => onPrefsChange({ leftOpen: !prefs.leftOpen })}
        >
          {t("builder.shell.library")}
        </button>

        <span
          className={`jf-shell__context${siteWide ? " jf-shell__context--global" : ""}`}
          aria-describedby={siteWide ? contextNoteId : undefined}
        >
          {t(`builder.shell.context.${context}`)}
        </span>
        {impactKey && (
          <span id={contextNoteId} className="jf-shell__impact">
            {t(impactKey)}
          </span>
        )}

        <span className="jf-shell__spacer" />

        <div className="jf-builder-toolbar__segmented" role="group" aria-label={t("builder.shell.history")}>
          <button type="button" className="jf-builder-toolbar__btn" onClick={history.undo} disabled={!history.canUndo} title={t("ui.pageBuilder.undoZ")}>
            {t("ui.pageBuilder.undo")}
          </button>
          <button type="button" className="jf-builder-toolbar__btn" onClick={history.redo} disabled={!history.canRedo} title={t("ui.pageBuilder.redoZ")}>
            {t("ui.pageBuilder.redo")}
          </button>
        </div>

        <div className="jf-builder-toolbar__segmented" role="group" aria-label={t("builder.shell.breakpoint")}>
          {BUILDER_BREAKPOINTS.map((bp) => (
            <button
              key={bp}
              type="button"
              className="jf-builder-toolbar__btn"
              aria-pressed={prefs.previewWidth === null && prefs.breakpoint === bp}
              onClick={() => onPrefsChange({ breakpoint: bp, previewWidth: null })}
            >
              {t(`builder.shell.breakpointLabel.${bp}`)}
            </button>
          ))}
        </div>

        <label className="jf-shell__width">
          <span className="jf-sr-only">{t("builder.shell.previewWidth")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={PREVIEW_WIDTH_MIN}
            max={PREVIEW_WIDTH_MAX}
            step={10}
            value={widthDraft || String(frameWidth ?? measured ?? "")}
            aria-describedby={`${contextNoteId}-width`}
            onChange={(e) => setWidthDraft(e.target.value)}
            onBlur={() => {
              if (widthDraft) onPrefsChange({ previewWidth: clampPreviewWidth(Number(widthDraft)) });
              setWidthDraft("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setWidthDraft("");
                e.currentTarget.blur();
              }
            }}
          />
        </label>
        <span className="jf-shell__unit" aria-hidden="true">px</span>
        <span id={`${contextNoteId}-width`} className="jf-shell__measure" aria-live="polite">
          {measured > 0 && t("builder.shell.canvasWidth", { width: measured, breakpoint: t(`builder.shell.breakpointLabel.${breakpointForWidth(measured)}`) })}
        </span>

        <label className="jf-shell__zoom">
          <span className="jf-sr-only">{t("builder.shell.zoom")}</span>
          <select
            value={prefs.zoom}
            onChange={(e) => onPrefsChange({ zoom: Number(e.target.value) as BuilderZoom })}
          >
            {BUILDER_ZOOM_LEVELS.map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
          </select>
        </label>

        <div className="jf-builder-toolbar__segmented" role="group" aria-label={t("builder.previewSchemeHint")} title={t("builder.previewSchemeHint")}>
          {(["light", "dark"] as const).map((scheme) => (
            <button
              key={scheme}
              type="button"
              className="jf-builder-toolbar__btn"
              aria-pressed={previewScheme === scheme}
              onClick={() => onPreviewSchemeChange(scheme)}
            >
              {scheme === "light" ? `☀ ${t("builder.previewLight")}` : `☾ ${t("builder.previewDark")}`}
            </button>
          ))}
        </div>

        <span className="jf-builder-toolbar__count">
          {t(blockCount === 1 ? "builder.blockCountOne" : "builder.blockCountMany", { count: blockCount })}
        </span>

        <button
          type="button"
          className="jf-builder-toolbar__btn"
          aria-expanded={prefs.rightOpen}
          aria-controls={rightId}
          onClick={() => onPrefsChange({ rightOpen: !prefs.rightOpen })}
        >
          {t("builder.shell.inspector")}
        </button>
      </div>

      <div
        className={`jf-shell__body${prefs.leftOpen ? "" : " jf-shell__body--no-left"}${prefs.rightOpen ? "" : " jf-shell__body--no-right"}`}
      >
        <aside id={leftId} className="jf-shell__left" aria-label={t("builder.shell.library")} hidden={!prefs.leftOpen}>
          {sitePanel || layers ? (
            <LeftPanelTabs
              active={prefs.leftTab}
              onChange={(leftTab) => onPrefsChange({ leftTab })}
              panels={{ library, ...(sitePanel ? { site: sitePanel } : {}), ...(layers ? { layers } : {}) }}
            />
          ) : (
            library
          )}
        </aside>

        <main className="jf-shell__canvas" aria-label={t("builder.shell.canvas")} onClick={onCanvasBackgroundClick}>
          <nav className="jf-shell__crumbs" aria-label={t("builder.shell.breadcrumbs")} onClick={(e) => e.stopPropagation()}>
            <ol>
              {breadcrumbs.map((crumb, i) => {
                const last = i === breadcrumbs.length - 1;
                return (
                  <li key={crumb.id ?? "root"}>
                    {last ? (
                      <span aria-current="location">{crumb.label}</span>
                    ) : (
                      <button type="button" onClick={() => onSelectCrumb(crumb.id)}>
                        {crumb.label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <div
            ref={frame}
            className="jf-shell__frame"
            data-breakpoint={prefs.previewWidth ? "custom" : prefs.breakpoint}
            style={{
              maxWidth: frameWidth ? `calc(${frameWidth}px + 2rem)` : undefined,
              zoom: prefs.zoom === 100 ? undefined : prefs.zoom / 100,
            }}
            onClick={(e) => e.stopPropagation()}
            {...inertPreviewHandlers}
          >
            {canvasBackdrop}
            {canvas}
          </div>
        </main>

        <aside id={rightId} className="jf-shell__right" aria-label={t("builder.shell.inspector")} hidden={!prefs.rightOpen}>
          {inspector}
        </aside>
      </div>
    </div>
  );
}

/** The top bar of a stand-alone builder: exit, identity, save state, preview, actions. */
export function ShellBar({ bar }: { bar: BuilderShellBar }) {
  const { t } = useT();
  const saveLabel =
    bar.saveState === "saving"
      ? t("common.saving")
      : bar.saveState === "autosaving"
        ? t("builder.shell.autosaving")
        : bar.saveState === "saved"
          ? `✓ ${t("common.saved")}`
          : bar.saveState === "dirty"
            ? t("builder.shell.unsaved")
            : bar.saveState === "conflict"
              ? t("builder.shell.conflict")
              : bar.saveState === "error"
                ? bar.saveError || t("builder.shell.saveFailed")
                : "";
  return (
    <>
    <header className="jf-editor__bar jf-shell__bar">
      <button type="button" className="jf-btn jf-btn--onbar" onClick={bar.onExit}>
        <span aria-hidden="true" className="jf-shell__back">←</span> {t("common.back")}
      </button>
      <div className="jf-editor__title">
        <h1 className="jf-editor__name">{bar.title}</h1>
        {bar.subtitle && <div className="jf-editor__sub">{bar.subtitle}</div>}
      </div>
      <div className="jf-editor__actions">
        <span
          className={`jf-editor__status${bar.saveState === "saved" ? " jf-editor__status--ok" : ""}${bar.saveState === "error" || bar.saveState === "conflict" ? " jf-editor__status--error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {saveLabel}
        </span>
        {bar.previewUrl && (
          <a className="jf-btn jf-btn--onbar" href={bar.previewUrl} target="_blank" rel="noreferrer">
            {t("pageBuilderPage.preview")} <span aria-hidden="true">↗</span>
          </a>
        )}
        {bar.actions}
      </div>
    </header>
    {bar.notice && (
      <div className="jf-shell__notice" role="alert">
        {bar.notice}
      </div>
    )}
    </>
  );
}

/** Blocks | Site switch for the left panel. */
function LeftPanelTabs({
  active,
  onChange,
  panels,
}: {
  active: LeftPanelTab;
  onChange: (tab: LeftPanelTab) => void;
  /** The panels offered, in tab order; a missing panel is not shown. */
  panels: Partial<Record<LeftPanelTab, ReactNode>>;
}) {
  const { t } = useT();
  const baseId = useId();
  const labels: Record<LeftPanelTab, string> = {
    site: t("builder.shell.site"),
    library: t("builder.shell.library"),
    layers: t("builder.shell.layers"),
  };
  const order: LeftPanelTab[] = ["site", "library", "layers"];
  const tabs = order.filter((id) => panels[id] !== undefined);
  const current = tabs.includes(active) ? active : (tabs.includes("library") ? "library" : tabs[0]!);
  /** Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects. */
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.indexOf(current);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    let next: LeftPanelTab | undefined;
    if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = tabs[(i + 1) % tabs.length];
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next);
    document.getElementById(`${baseId}-${next}`)?.focus();
  };
  return (
    <>
      <div className="jf-inspector__tabs jf-shell__left-tabs" role="tablist" aria-label={t("builder.shell.library")}>
        {tabs.map((id) => (
          <button
            key={id}
            id={`${baseId}-${id}`}
            type="button"
            role="tab"
            className="jf-inspector__tab"
            aria-selected={current === id}
            aria-controls={`${baseId}-panel`}
            tabIndex={current === id ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={onKey}
          >
            {labels[id]}
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-${current}`}
        className={current === "library" ? "jf-shell__library" : "jf-shell__site"}
      >
        {panels[current]}
      </div>
    </>
  );
}

/**
 * The shell frame without a canvas: top bar, site panel, and a message. Used
 * when a site part has nothing to edit yet (no template chosen, no header
 * saved), so switching parts never drops out of the builder layout.
 */
export function BuilderShellEmpty({
  bar,
  sitePanel,
  children,
}: {
  bar: BuilderShellBar;
  sitePanel: ReactNode;
  children: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="jf-shell jf-shell--page">
      <ShellBar bar={bar} />
      <div className="jf-shell__body jf-shell__body--no-right">
        <aside className="jf-shell__left" aria-label={t("builder.shell.site")}>
          <div className="jf-shell__site">{sitePanel}</div>
        </aside>
        <main className="jf-shell__canvas" aria-label={t("builder.shell.canvas")}>
          <div className="jf-shell__empty">{children}</div>
        </main>
        <span />
      </div>
    </div>
  );
}
