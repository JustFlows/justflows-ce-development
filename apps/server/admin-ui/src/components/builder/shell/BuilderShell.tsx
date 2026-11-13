// SPDX-License-Identifier: MIT
import { useId, type ReactNode } from "react";
import { useT } from "../../../i18n/I18nProvider";
import {
  BREAKPOINT_WIDTH,
  BUILDER_BREAKPOINTS,
  BUILDER_ZOOM_LEVELS,
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
  /** Right panel content (the inspector). */
  inspector: ReactNode;
  /** Canvas content, already wrapped in the theme preview scope. */
  canvas: ReactNode;
  /** Background behind the page, painted in the previewed scheme. */
  canvasBackdrop?: ReactNode;
  /** Clicking empty canvas space clears the selection. */
  onCanvasBackgroundClick: () => void;
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
  inspector,
  canvas,
  canvasBackdrop,
  onCanvasBackgroundClick,
}: BuilderShellProps) {
  const { t } = useT();
  const leftId = useId();
  const rightId = useId();
  const contextNoteId = useId();
  const frameWidth = BREAKPOINT_WIDTH[prefs.breakpoint];
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
              aria-pressed={prefs.breakpoint === bp}
              onClick={() => onPrefsChange({ breakpoint: bp })}
            >
              {t(`builder.shell.breakpointLabel.${bp}`)}
            </button>
          ))}
        </div>

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
          {sitePanel ? (
            <LeftPanelTabs
              active={prefs.leftTab}
              onChange={(leftTab) => onPrefsChange({ leftTab })}
              library={library}
              site={sitePanel}
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
            className="jf-shell__frame"
            data-breakpoint={prefs.breakpoint}
            style={{
              maxWidth: frameWidth ? `${frameWidth}px` : undefined,
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
  library,
  site,
}: {
  active: LeftPanelTab;
  onChange: (tab: LeftPanelTab) => void;
  library: ReactNode;
  site: ReactNode;
}) {
  const { t } = useT();
  const baseId = useId();
  const tabs: Array<{ id: LeftPanelTab; label: string }> = [
    { id: "site", label: t("builder.shell.site") },
    { id: "library", label: t("builder.shell.library") },
  ];
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next: LeftPanelTab = active === "site" ? "library" : "site";
    onChange(next);
    document.getElementById(`${baseId}-${next}`)?.focus();
  };
  return (
    <>
      <div className="jf-inspector__tabs jf-shell__left-tabs" role="tablist" aria-label={t("builder.shell.library")}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`${baseId}-${tab.id}`}
            type="button"
            role="tab"
            className="jf-inspector__tab"
            aria-selected={active === tab.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={onKey}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-${active}`}
        className={active === "site" ? "jf-shell__site" : "jf-shell__library"}
      >
        {active === "site" ? site : library}
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
