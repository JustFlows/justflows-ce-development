import FunctionalBlock, { FUNCTIONAL_TYPES } from "./FunctionalBlock";
import MediaBlock from "../MediaBlock";
import { useT } from "../../i18n/I18nProvider";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactElement } from "react";
import type { BlockNode } from "./types";
import { esc, isBlockLocked, normalizeInlineValue, parseBlockStyle, renderMath, sanitizeHtmlBlock, sanitizePluginPreviewHtml, sanitizeRichText, INLINE_FIELD_ATTRIBUTE } from "@justflows/blocks";
import { isExtendClick, useBuilderSelection } from "./selection-context";
import MotionPreview from "./MotionPreview";
import { applyMergeTags, useMergeTags } from "../../lib/merge-tags";
import { ImagePickerPopover, MediaPickerPopover, readEditableText } from "./InlineEditable";
import { InlineField, InlineFieldsContext, InlineLinkField } from "./inline-field";

/** Class the active theme's stylesheet is scoped to (see `serveThemeCss`). */
export const THEME_PREVIEW_SCOPE = "jf-theme-surface";
const THEME_PREVIEW_LINK_ID = "jf-theme-preview-css";

export type PreviewScheme = "light" | "dark";

/**
 * Which of the site theme's colour schemes the canvas shows. Every theme
 * surface carries it as `data-theme`, the attribute `/js/site-chrome.js`
 * stamps on the live site, so the theme's own dark rules apply instead of a
 * mix of its light tokens and the customizer's `prefers-color-scheme` ones.
 */
export const PreviewSchemeContext = createContext<PreviewScheme>("light");

export function usePreviewScheme(): PreviewScheme {
  return useContext(PreviewSchemeContext);
}
let themePreviewMounts = 0;

/**
 * Link the active theme's `/theme.css` into the admin document, scoped to
 * `.jf-theme-surface` so block previews pick up real theme styling (a themed
 * hero background, custom borders, …) without the sheet repainting the admin
 * chrome. Ref-counted: the builder mounts several canvases.
 */
export function useThemePreviewStylesheet(): void {
  useEffect(() => {
    themePreviewMounts += 1;
    if (!document.getElementById(THEME_PREVIEW_LINK_ID)) {
      const link = document.createElement("link");
      link.id = THEME_PREVIEW_LINK_ID;
      link.rel = "stylesheet";
      link.href = `/theme.css?preview=1&scope=.${THEME_PREVIEW_SCOPE}`;
      document.head.appendChild(link);
    }
    return () => {
      themePreviewMounts -= 1;
      if (themePreviewMounts <= 0) document.getElementById(THEME_PREVIEW_LINK_ID)?.remove();
    };
  }, []);
}

interface BlockPreviewProps {
  block: BlockNode;
  depth?: number;
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  renderChildren?: (children: BlockNode[], depth: number) => React.ReactNode;
  /** Commits an inline edit (paragraph/heading/quote text) made directly in the canvas. */
  onUpdateProps?: (id: string, props: Record<string, unknown>) => void;
}

export function BlockPreview({
  block,
  depth = 0,
  onSelect,
  selectedId,
  renderChildren,
  onUpdateProps,
}: BlockPreviewProps) {
  const { t, locale } = useT();
  const scheme = usePreviewScheme();
  const p = block.props;
  const tags = useMergeTags();
  const text = (value: unknown) => applyMergeTags(String(value ?? ""), tags);
  const isSelected = selectedId === block.id;
  const selection = useBuilderSelection();
  /** Declared inline fields are editable while their block is selected, unless it is edit-locked. */
  const active = Boolean(isSelected && onUpdateProps && !isBlockLocked(block, "edit"));
  const commitProps = (next: Record<string, unknown>) => onUpdateProps?.(block.id, next);
  const [mediaPicker, setMediaPicker] = useState<{
    top: number;
    left: number;
    kind?: "image" | "video" | "audio" | "file";
    prop?: string;
  } | null>(null);
  const blockStyle = parseBlockStyle(p.style);

  // Per-instance colours (Layout panel) and theme-token overrides (Theme
  // styling panel). The server writes these onto the block's *own* root
  // element via `withBlockChrome`, so an inline `background` there beats the
  // theme's `.jf-hero { background: … }`. Do the same here — merge them onto
  // the element each case returns, not an outer wrapper — or the theme's
  // striped hero background (and friends) would still show through.
  const chromeStyle: React.CSSProperties = {
    ...(blockStyle.background ? { background: blockStyle.background } : {}),
    ...(blockStyle.textColor ? { color: blockStyle.textColor } : {}),
    ...(blockStyle.accent ? { ["--jf-block-accent" as string]: blockStyle.accent } : {}),
    ...(blockStyle.opacity ? { opacity: Number(blockStyle.opacity) / 100 } : {}),
    ...(blockStyle.vars as Record<string, string>),
  };
  const hasChrome = Object.keys(chromeStyle).length > 0;

  const wrap = (content: React.ReactNode, label?: string) => {
    const inner = isValidElement(content)
      ? cloneElement(
          content as ReactElement<{
            style?: React.CSSProperties;
            "data-jf-block-preview"?: string;
          }>,
          {
            "data-jf-block-preview": block.id,
            ...(hasChrome ? { style: { ...(content.props.style ?? {}), ...chromeStyle } } : {}),
          },
        )
      : content;
    return (
      <div
        className={depth === 0 ? THEME_PREVIEW_SCOPE : undefined}
        data-theme={depth === 0 ? scheme : undefined}
        onClick={
          onSelect
            ? (e) => {
                e.stopPropagation();
                if (selection && isExtendClick(e) && selection.extend(block.id, e)) return;
                onSelect(block.id);
              }
            : undefined
        }
        style={{
          /**
           * Each block is a containing block, so absolutely positioned content
           * from theme or plugin CSS (a stretched card link) stays inside it
           * instead of covering other blocks and the builder's own controls.
           */
          position: "relative",
          borderRadius: 4,
          cursor: onSelect ? "pointer" : undefined,
          maxWidth: blockStyle.maxWidth > 0 ? `min(100%, ${blockStyle.maxWidth}px)` : undefined,
          maxHeight: blockStyle.maxHeight > 0 ? blockStyle.maxHeight : undefined,
          overflow: blockStyle.maxHeight > 0 ? "auto" : undefined,
          marginLeft: blockStyle.maxWidth > 0 ? "auto" : undefined,
          marginRight: blockStyle.maxWidth > 0 ? "auto" : undefined,
        }}
      >
        {label && depth === 0 ? null : null}
        <MotionPreview blockId={block.id} animation={p.animation}>
          {inner}
        </MotionPreview>
      </div>
    );
  };

  if (block.type === "core.list-item" && active) {
    return wrap(
      <li className="jf-list-item">
        <div className="jf-list-item-content">
          <InlineField block={block} field="text" active={active} as="div" placeholder={t("builder.inline.listItem")} onCommit={commitProps}>
            {null}
          </InlineField>
          {renderChildren?.(block.children ?? [], depth + 1)}
        </div>
      </li>,
    );
  }
  if (FUNCTIONAL_TYPES.has(block.type)) return wrap(<FunctionalBlock type={block.type} props={p}>{renderChildren?.(block.children ?? [], depth + 1)}</FunctionalBlock>);

  switch (block.type) {
    case "core.search": {
      const label = typeof p.label === "string" && p.label && p.label !== "Search" ? p.label : t("search.submit");
      return wrap(<div className="jf-search" aria-label={label}>
        <label>{label}<input type="search" disabled placeholder={label} /></label>
        {p.showFilters === true && <span>{t("search.filters")}: {t("search.type")}, {t("search.taxonomy")}, {t("search.after")}</span>}
        <button type="button" disabled>{label}</button>
      </div>);
    }
    case "core.section": {
      const bg = (p.background as string) || "default";
      const pad = (p.padding as string) || "lg";
      const align = (p.align as string) === "center" ? "center" : "left";
      return wrap(
        <section
          className={`jf-section jf-section--bg-${bg} jf-section--pad-${pad} jf-section--align-${align}`}
        >
          <div className="jf-section__inner">
            {renderChildren?.(block.children ?? [], depth + 1) ?? (
              <div style={{ color: "var(--color-muted, var(--jf-text-3))", fontSize: "0.8rem", padding: "0.5rem" }}>
                {t("builder.preview.emptySectionAddBlocks")}
              </div>
            )}
          </div>
        </section>,
      );
    }

    case "core.container":
      return wrap(
        <div className={`jf-container jf-container--${(p.width as string) || "default"}`}>
          {renderChildren?.(block.children ?? [], depth + 1) ?? (
            <div style={{ color: "var(--color-muted, var(--jf-text-3))", fontSize: "0.8rem", padding: "0.5rem" }}>
              {t("builder.preview.emptyContainer")}
            </div>
          )}
        </div>,
      );

    case "core.group":
      return wrap(
        <div className="jf-group">{renderChildren?.(block.children ?? [], depth + 1)}</div>,
      );

    case "core.columns": {
      const cols = (p.columns as number) ?? 2;
      const gap = (p.gap as string) || "md";
      return wrap(
        <div
          className={`jf-columns jf-columns--${cols} jf-columns--gap-${gap}`}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, alignItems: "start" }}
        >
          {renderChildren?.(block.children ?? [], depth + 1)}
        </div>,
      );
    }

    case "core.column":
      return wrap(
        <div className="jf-column" style={{ minHeight: 72 }}>
          {renderChildren?.(block.children ?? [], depth + 1) ?? (
            <div style={{ color: "var(--color-muted, var(--jf-text-3))", fontSize: "0.75rem" }}>{t("builder.preview.dropContentHere")}</div>
          )}
        </div>,
      );

    case "core.hero": {
      const align = (p.align as string) === "center" ? "center" : "left";
      const bgImage = p.backgroundImage as string;
      return wrap(
        <section
          className={`jf-hero jf-hero--align-${align}`}
          style={bgImage ? { backgroundImage: `url(${bgImage})` } : undefined}
        >
          <div className="jf-hero__inner">
            <InlineField block={block} field="heading" active={active} as="h1" className="jf-hero__heading" placeholder={t("builder.preview.heroHeading")} onCommit={commitProps}>
              <h1 className="jf-hero__heading">{(p.heading as string) || t("builder.preview.heroHeading")}</h1>
            </InlineField>
            {(active || (p.subheading as string)) && (
              <InlineField block={block} field="subheading" active={active} as="p" className="jf-hero__sub" placeholder={t("builder.inline.supportingText")} onCommit={commitProps}>
                <p className="jf-hero__sub">{p.subheading as string}</p>
              </InlineField>
            )}
            {(active || (p.buttonLabel as string)) && (
              <span className="btn btn--primary jf-hero__btn">
                <InlineField block={block} field="buttonLabel" active={active} as="span" placeholder={t("builder.preview.button")} label={t("builder.inline.buttonLabel")} onCommit={commitProps}>
                  {p.buttonLabel as string}
                </InlineField>
              </span>
            )}
          </div>
        </section>,
      );
    }
    case "core.features": {
      const items = (p.items as Array<{ icon: string; title: string; description: string }>) ?? [];
      const cols = (p.columns as number) ?? 3;
      return wrap(
        <section className="jf-features">
          <div className="jf-container jf-container--wide">
            {(p.heading as string) && (
              <h2 className="jf-features__heading">{p.heading as string}</h2>
            )}
            <div
              className={`jf-features__grid jf-features__grid--${cols}`}
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {items.map((item, i) => (
                <div key={i} className="jf-feature">
                  <span className="jf-feature__icon">{item.icon}</span>
                  <h3 className="jf-feature__title">{item.title || t("builder.preview.feature")}</h3>
                  <p className="jf-feature__desc">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>,
      );
    }

    case "core.cta": {
      const variant = (p.variant as string) || "default";
      return wrap(
        <section className={`jf-cta jf-cta--${variant}`}>
          <div className="jf-container jf-container--default">
            <InlineField block={block} field="heading" active={active} as="h2" className="jf-cta__heading" placeholder={t("builder.preview.callToAction")} onCommit={commitProps}>
              <h2 className="jf-cta__heading">{(p.heading as string) || t("builder.preview.callToAction")}</h2>
            </InlineField>
            {(active || (p.text as string)) && (
              <InlineField block={block} field="text" active={active} as="p" className="jf-cta__text" placeholder={t("builder.inline.supportingText")} onCommit={commitProps}>
                <p className="jf-cta__text">{p.text as string}</p>
              </InlineField>
            )}
            {(active || (p.buttonLabel as string)) && (
              <span className="btn btn--primary jf-cta__btn">
                <InlineField block={block} field="buttonLabel" active={active} as="span" placeholder={t("builder.preview.button")} label={t("builder.inline.buttonLabel")} onCommit={commitProps}>
                  {p.buttonLabel as string}
                </InlineField>
              </span>
            )}
          </div>
        </section>,
      );
    }
    case "core.paragraph":
      return wrap(
        <InlineField block={block} field="text" active={active} as="div" className="jf-paragraph" placeholder={t("builder.preview.typeAParagraph")} onCommit={commitProps}>
          <div
            className="jf-paragraph"
            dangerouslySetInnerHTML={{
              __html:
                renderMath(sanitizeRichText(text(p.text))) ||
                `<em style='color:var(--color-muted, var(--jf-text-3))'>${esc(t("builder.preview.emptyParagraph"))}</em>`,
            }}
          />
        </InlineField>,
      );

    case "core.heading": {
      const Tag = `h${Math.min(6, Math.max(1, (p.level as number) ?? 2))}` as
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return wrap(
        <InlineField block={block} field="text" active={active} as={Tag} placeholder={t("builder.preview.heading")} onCommit={commitProps}>
          <Tag>{text(p.text) || t("builder.preview.heading")}</Tag>
        </InlineField>,
      );
    }
    case "core.video":
    case "core.audio":
    case "core.file": {
      if (!active) return wrap(<MediaBlock type={block.type} props={p} preview />);
      const kind = block.type === "core.video" ? "video" : block.type === "core.audio" ? "audio" : "file";
      /** Replace the media (or choose a video poster) from the library, a URL, or an upload. */
      const open = (el: HTMLElement, prop: "src" | "poster") => {
        const rect = el.getBoundingClientRect();
        setMediaPicker({ top: rect.bottom + 4, left: rect.left, kind: prop === "poster" ? "image" : kind, prop });
      };
      return wrap(
        <>
          {mediaPicker?.prop && (
            <MediaPickerPopover
              kind={mediaPicker.kind ?? kind}
              top={mediaPicker.top}
              left={mediaPicker.left}
              onInsert={(url) => {
                const prop = mediaPicker.prop!;
                setMediaPicker(null);
                commitProps({ ...p, [prop]: url });
              }}
              onClose={() => setMediaPicker(null)}
            />
          )}
          {/** Double-click is a mouse shortcut; the Replace button below is the accessible control. */}
          <div title={t("builder.inline.replaceMediaHint")} onDoubleClick={(e) => open(e.currentTarget, "src")}>
            {/** The caption (and file link text) are edited below, so the preview leaves them out. */}
            <MediaBlock type={block.type} props={{ ...p, caption: "" }} preview />
          </div>
          <div className="jf-inline-media-bar" data-builder-chrome="true">
            <button type="button" className="jf-btn jf-btn--sm" onClick={(e) => open(e.currentTarget, "src")}>
              {t(`builder.inline.replace.${kind}`)}
            </button>
            {kind === "video" && (
              <button type="button" className="jf-btn jf-btn--sm" onClick={(e) => open(e.currentTarget, "poster")}>
                {(p.poster as string) ? t("builder.inline.changePoster") : t("builder.inline.choosePoster")}
              </button>
            )}
            {kind === "video" && (p.poster as string) && (
              <button type="button" className="jf-btn jf-btn--sm" onClick={() => commitProps({ ...p, poster: "" })}>
                {t("builder.inline.removePoster")}
              </button>
            )}
          </div>
          {kind === "file" && (
            <div className="jf-inline-alt" data-builder-chrome="true">
              <span aria-hidden="true">{t("builder.inline.linkText")}:</span>
              <InlineField block={block} field="label" active={active} as="span" placeholder={t("builder.inline.linkTextPlaceholder")} label={t("builder.inline.linkText")} onCommit={commitProps}>
                {null}
              </InlineField>
            </div>
          )}
          <InlineField block={block} field="caption" active={active} as="p" className="jf-media-caption" placeholder={t("builder.inline.caption")} onCommit={commitProps}>
            {null}
          </InlineField>
        </>,
      );
    }

    case "core.image": {
      /** Double-click (or Enter on the selected image) opens the media library to replace it. */
      const openPicker = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        setMediaPicker({ top: rect.top + 8, left: rect.left + 8 });
      };
      const picker =
        active && mediaPicker && !mediaPicker.prop ? (
          <ImagePickerPopover
            top={mediaPicker.top}
            left={mediaPicker.left}
            onInsert={(url) => {
              setMediaPicker(null);
              commitProps({ ...p, src: url });
            }}
            onClose={() => setMediaPicker(null)}
          />
        ) : null;
      return wrap(
        <>
          {picker}
          {(p.src as string) ? (
            <figure style={{ margin: 0 }}>
              <img
                src={p.src as string}
                alt={(p.alt as string) ?? ""}
                title={active ? t("builder.inline.replaceImageHint") : undefined}
                tabIndex={active ? 0 : undefined}
                role={active ? "button" : undefined}
                aria-label={active ? t("builder.inline.replaceImage") : undefined}
                onDoubleClick={active ? (e) => openPicker(e.currentTarget) : undefined}
                onKeyDown={
                  active
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openPicker(e.currentTarget);
                        }
                      }
                    : undefined
                }
                style={{
                  display: "block",
                  width: Number(p.width) > 0 ? Number(p.width) : undefined,
                  height: Number(p.height) > 0 ? Number(p.height) : undefined,
                  maxWidth: "100%",
                  objectFit:
                    Number(p.height) > 0
                      ? (p.objectFit as "contain" | "cover" | "fill") || "contain"
                      : undefined,
                  borderRadius: 6,
                  cursor: active ? "zoom-in" : undefined,
                }}
              />
              {(active || (p.caption as string)) && (
                <InlineField block={block} field="caption" active={active} as="figcaption" placeholder={t("builder.inline.caption")} onCommit={commitProps}>
                  <figcaption
                    style={{ fontSize: "0.8rem", color: "var(--color-muted, var(--jf-text-3))", marginTop: "0.25rem" }}
                  >
                    {p.caption as string}
                  </figcaption>
                </InlineField>
              )}
              {active && (
                <div className="jf-inline-alt" data-builder-chrome="true">
                  <span aria-hidden="true">{t("builder.inline.altText")}:</span>
                  <InlineField block={block} field="alt" active={active} as="span" placeholder={t("builder.inline.altPlaceholder")} label={t("builder.inline.altText")} onCommit={commitProps}>
                    {null}
                  </InlineField>
                </div>
              )}
            </figure>
          ) : (
            <div
              role={active ? "button" : undefined}
              tabIndex={active ? 0 : undefined}
              onDoubleClick={active ? (e) => openPicker(e.currentTarget) : undefined}
              onKeyDown={
                active
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openPicker(e.currentTarget);
                      }
                    }
                  : undefined
              }
              style={{
                background: "var(--color-surface, var(--jf-surface-3))",
                padding: "1.5rem",
                borderRadius: 6,
                textAlign: "center",
                color: "var(--color-muted, var(--jf-text-3))",
              }}
            >
              {active ? t("builder.inline.chooseImage") : t("builder.preview.noImage")}
            </div>
          )}
        </>,
      );
    }
    case "core.quote":
      return wrap(
        <blockquote>
          <InlineField block={block} field="text" active={active} as="div" className="jf-quote__text" placeholder={t("builder.preview.quote")} onCommit={commitProps}>
            <div
              className="jf-quote__text"
              dangerouslySetInnerHTML={{
                __html:
                  renderMath(sanitizeRichText((p.text as string) || "")) ||
                  `<em style='color:var(--color-muted, var(--jf-text-3))'>${esc(t("builder.preview.quote"))}</em>`,
              }}
            />
          </InlineField>
          {(active || (p.attribution as string)) && (
            <InlineField block={block} field="attribution" active={active} as="cite" placeholder={t("builder.inline.attribution")} onCommit={commitProps}>
              <cite>— {p.attribution as string}</cite>
            </InlineField>
          )}
        </blockquote>,
      );
    case "core.button":
      return wrap(
        <>
          <span className={`btn btn--${(p.variant as string) || "primary"}`}>
            <InlineField block={block} field="label" active={active} as="span" placeholder={t("builder.preview.button")} label={t("builder.inline.buttonLabel")} onCommit={commitProps}>
              {(p.label as string) || t("builder.preview.button")}
            </InlineField>
          </span>
          {active && (
            <InlineLinkField
              value={typeof p.url === "string" ? p.url : ""}
              label={t("builder.inline.buttonLink")}
              onCommit={(url) => commitProps({ ...p, url })}
            />
          )}
        </>,
      );
    case "core.link-list": {
      const items = (p.items as Array<{ label: string; url: string }>) ?? [];
      return wrap(
        <div className="jf-link-list">
          {(p.heading as string) && (
            <h3 className="jf-link-list__heading">{p.heading as string}</h3>
          )}
          {items.length === 0 ? (
            <div style={{ color: "var(--color-muted, var(--jf-text-3))", fontSize: "0.8rem" }}>{t("builder.preview.noLinksYet")}</div>
          ) : (
            <ul className="jf-link-list__items">
              {items.map((item, i) => (
                <li key={i}>
                  <span className="jf-link-list__link">{item.label || item.url || t("builder.preview.link")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>,
      );
    }

    case "core.divider":
      return wrap(<hr />);

    case "core.spacer":
      return wrap(
        <div
          style={{
            height: `${(p.height as number) ?? 40}px`,
            background:
              "repeating-linear-gradient(45deg, var(--color-bg, var(--jf-surface-2)), var(--color-bg, var(--jf-surface-2)) 5px, var(--color-surface, var(--jf-surface-3)) 5px, var(--color-surface, var(--jf-surface-3)) 10px)",
            borderRadius: 4,
          }}
        />,
      );

    case "core.code":
      return wrap(
        <pre
          style={{
            margin: 0,
            padding: "0.75rem",
            background: "var(--color-text, var(--jf-text))",
            color: "var(--color-bg, var(--jf-surface))",
            borderRadius: 4,
            fontSize: "0.8rem",
            overflow: "auto",
          }}
        >
          <code>{(p.code as string) || "// code"}</code>
        </pre>,
      );

    case "core.embed":
      return wrap(
        <div
          style={{
            background: "var(--color-surface, var(--jf-surface-3))",
            padding: "1rem",
            borderRadius: 6,
            textAlign: "center",
            color: "var(--color-muted, var(--jf-text-3))",
            fontSize: "0.875rem",
          }}
        >
          {t("builder.preview.embed")}{(p.url as string) || t("builder.preview.noURL")}
        </div>,
      );

    case "core.html":
      return wrap(
        <div
          className="jf-html"
          dangerouslySetInnerHTML={{
            __html: sanitizeHtmlBlock(text(p.html)) || `<p>${esc(t("builder.preview.html"))}</p>`,
          }}
        />,
      );

    case "core.grid":
      return wrap(
        renderChildren ? <>{renderChildren(block.children ?? [], depth + 1)}</> : <div />,
      );

    case "core.color-scheme": {
      const schemeStyle = (p.style as string) || "buttons";
      const lightIcon = (p.lightIcon as string) || "☀";
      const darkIcon = (p.darkIcon as string) || "☾";
      const schemeModes: Array<[string, string]> = [
        [lightIcon, (p.lightLabel as string) || t("builder.preview.light")],
        [darkIcon, (p.darkLabel as string) || t("builder.preview.dark")],
      ];
      if (p.showSystem === true)
        schemeModes.push([(p.autoIcon as string) || "◐", (p.autoLabel as string) || t("builder.preview.auto")]);
      const iconOnly = schemeStyle === "icons" || schemeStyle === "tooltip-icons";
      const textOnly = schemeStyle === "labels";
      const pillRadius = p.radius === "square" ? 0 : p.radius === "rounded" ? 8 : 999;
      const chipSize: React.CSSProperties =
        p.size === "sm"
          ? { fontSize: "0.7rem", padding: "0.2rem 0.5rem" }
          : p.size === "lg"
            ? { fontSize: "0.95rem", padding: "0.45rem 0.9rem" }
            : {};
      if (schemeStyle === "select") {
        return wrap(
          <div style={{ display: "inline-flex", ...widgetAlign(p.align as string) }}>
            <span style={{ ...widgetChip, ...chipSize, borderRadius: Math.min(pillRadius, 8) }}>
              {schemeModes.map(([, label]) => label).join(" / ")} ⌄
            </span>
          </div>,
        );
      }
      if (schemeStyle === "switch") {
        return wrap(
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              ...widgetAlign(p.align as string),
            }}
          >
            <span style={{ fontSize: chipSize.fontSize ?? "0.8rem", fontWeight: 600 }}>
              {(p.darkLabel as string) || t("builder.preview.dark")}
            </span>
            <span
              style={{
                position: "relative",
                display: "inline-block",
                width: 34,
                height: 19,
                borderRadius: 999,
                background: "var(--color-border, var(--color-border, var(--jf-border-strong)))",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: 2,
                  width: 15,
                  height: 15,
                  borderRadius: "50%",
                  background: "var(--color-bg, #fff)",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
                }}
              />
            </span>
          </div>,
        );
      }
      if (schemeStyle === "toggle") {
        return wrap(
          <div style={{ display: "inline-flex", ...widgetAlign(p.align as string) }}>
            <span style={{ ...widgetChip, ...chipSize, borderRadius: pillRadius }}>
              {lightIcon} ⇄ {darkIcon}
            </span>
          </div>,
        );
      }
      return wrap(
        <div
          style={{
            display: "inline-flex",
            gap: schemeStyle === "segmented" ? 0 : 6,
            ...widgetAlign(p.align as string),
          }}
        >
          {schemeModes.map(([icon, label], index) => (
            <span
              key={label}
              style={{
                ...widgetChip,
                ...chipSize,
                borderRadius:
                  schemeStyle === "segmented"
                    ? index === 0
                      ? `${pillRadius}px 0 0 ${pillRadius}px`
                      : index === schemeModes.length - 1
                        ? `0 ${pillRadius}px ${pillRadius}px 0`
                        : 0
                    : pillRadius,
              }}
            >
              {textOnly ? label : iconOnly ? icon : `${icon} ${label}`}
            </span>
          ))}
        </div>,
      );
    }

    case "core.language-switcher":
      const languageStyle = (p.style as string) || "locale-short";
      const previewLanguages = [
        { full: "en-US", short: "en", flag: "🇺🇸", country: new Intl.DisplayNames([locale], { type: "region" }).of("US"), name: new Intl.DisplayNames(["en"], { type: "language" }).of("en") },
        { full: "nl-NL", short: "nl", flag: "🇳🇱", country: new Intl.DisplayNames([locale], { type: "region" }).of("NL"), name: new Intl.DisplayNames(["nl"], { type: "language" }).of("nl") },
      ];
      return wrap(
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            maxWidth: "100%",
            ...widgetAlign(p.align as string),
          }}
        >
          {previewLanguages.slice(0, 1).map((language, index) => {
            const label =
              languageStyle === "locale-full"
                ? language.full
                : languageStyle === "flags"
                  ? language.flag
                  : languageStyle === "flag-locale"
                    ? `${language.flag} ${language.short}`
                    : languageStyle === "flag-country"
                      ? `${language.flag} ${language.country}`
                      : languageStyle === "names"
                        ? language.name
                        : language.short;
            return (
              <span
                key={language.full}
                style={{ ...widgetChip, fontWeight: index === 0 ? 700 : 600 }}
              >
                {label} ⌄
              </span>
            );
          })}
        </div>,
      );

    case "core.auth-links":
      return wrap(
        <div
          style={{
            display: "inline-flex",
            gap: 8,
            alignItems: "center",
            ...widgetAlign(p.align as string),
          }}
        >
          {p.showLogin !== false ? (
            <span
              style={{
                ...widgetChip,
                background: "var(--color-bg, var(--jf-surface))",
                border: "1px solid var(--color-border, var(--jf-border-strong))",
              }}
            >
              {(p.loginLabel as string) || t("builder.preview.logIn")}
            </span>
          ) : null}
          {p.showRegister !== false ? (
            <span style={{ ...widgetChip, background: "var(--color-primary, var(--jf-accent))", color: "var(--color-bg, #fff)" }}>
              {(p.registerLabel as string) || t("builder.preview.register")}
            </span>
          ) : null}
        </div>,
      );

    case "justflows.blog.postList": {
      const layout = (p.layout as string) === "list" ? "list" : "grid";
      const cols = layout === "grid" ? Math.min(4, Math.max(1, Number(p.columns) || 3)) : 1;
      return wrap(
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--color-muted, var(--jf-text-3))", marginBottom: "0.5rem" }}>
            {t("builder.preview.blogPostsNewest")}{(Number(p.postsPerPage) || undefined) ?? "N"} {t("builder.preview.shownPaginated")}</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: "0.75rem",
            }}
          >
            {Array.from({ length: layout === "grid" ? cols * 2 : 3 }).map((_, i) => (
              <div
                key={i}
                style={{
                  border: "1px solid var(--color-border, var(--jf-border))",
                  borderRadius: 6,
                  padding: "0.6rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                }}
              >
                {p.showFeaturedImage !== false && (
                  <div style={{ height: 60, background: "var(--color-border, var(--jf-border))", borderRadius: 4 }} />
                )}
                <div
                  style={{
                    height: 10,
                    width: "70%",
                    background: "var(--color-muted, var(--jf-text-3))",
                    opacity: 0.5,
                    borderRadius: 2,
                  }}
                />
                {p.showDate !== false && (
                  <div
                    style={{
                      height: 8,
                      width: "40%",
                      background: "var(--color-border, var(--jf-border))",
                      borderRadius: 2,
                    }}
                  />
                )}
                {p.showExcerpt !== false && (
                  <div
                    style={{
                      height: 8,
                      width: "90%",
                      background: "var(--color-border, var(--jf-border))",
                      borderRadius: 2,
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>,
      );
    }

    case "core.post-title": {
      const level = Math.min(6, Math.max(1, Number(p.level) || 1));
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      return wrap(<Tag className="post-title">{t("builder.preview.postTitle")}</Tag>);
    }

    case "core.post-meta":
      return wrap(<p className="post-meta">{t("builder.preview.publishedDate")}</p>);

    case "core.post-excerpt":
      return wrap(<p className="post-excerpt">{t("builder.preview.thePostExcerptAppearsHere")}</p>);

    case "core.featured-image":
      return wrap(
        <figure
          className="post-featured-image"
          style={{
            aspectRatio: "16 / 9",
            background: "var(--color-surface, var(--jf-surface-3))",
            display: "grid",
            placeItems: "center",
            color: "var(--color-muted, var(--jf-text-3))",
            fontSize: "0.8rem",
            borderRadius: 6,
          }}
        >
          {t("builder.preview.featuredImage")}</figure>,
      );

    case "core.post-content":
      return wrap(
        <div
          style={{
            border: "1px dashed var(--color-border, var(--jf-border))",
            borderRadius: 6,
            padding: "1.25rem",
            color: "var(--color-muted, var(--jf-text-3))",
            fontSize: "0.8rem",
          }}
        >
          {t("builder.preview.postContentThePageOrPostSOwnBlocksRender")}</div>,
      );

    case "core.template-part":
      return wrap(
        <div
          style={{
            border: "1px dashed var(--color-border, var(--jf-border))",
            borderRadius: 6,
            padding: "0.75rem 1rem",
            color: "var(--color-muted, var(--jf-text-3))",
            fontSize: "0.8rem",
          }}
        >
          {t("builder.preview.templatePart")}{String(p.slug || "header")}
        </div>,
      );

    default:
      if (!block.type.startsWith("core.")) {
        return wrap(<PluginBlockPreview type={block.type} props={p} active={active} onCommit={commitProps} />);
      }
      return wrap(
        <div style={{ color: "var(--color-muted, var(--jf-text-3))", fontSize: "0.8rem" }}>{block.type}</div>,
      );
  }
}

/**
 * A plugin block the builder has no preview for: show the block's own server
 * render, sanitized like an HTML block. Re-asked after edits settle; falls back
 * to the block type while loading or when the render fails.
 */
function PluginBlockPreview({
  type,
  props,
  active = false,
  onCommit,
}: {
  type: string;
  props: Record<string, unknown>;
  active?: boolean;
  onCommit?: (props: Record<string, unknown>) => void;
}) {
  const { t } = useT();
  const [html, setHtml] = useState<string | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const fields = useContext(InlineFieldsContext).get(type);
  const key = JSON.stringify(props);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch("/api/blocks/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, props: JSON.parse(key) as unknown }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<{ html?: string }>) : null))
        .then((body) => {
          if (!cancelled) setHtml(body && typeof body.html === "string" ? sanitizePluginPreviewHtml(body.html) : "");
        })
        .catch(() => {
          if (!cancelled) setHtml("");
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [type, key]);

  /**
   * Plugin inline editing (justflows-ce#297): only elements the plugin marked
   * with `data-jf-inline="<prop>"` AND whose prop it declared become editable,
   * as plain text. Nothing else in the plugin's markup is touched.
   */
  useEffect(() => {
    const root = container.current;
    if (!root || !active || !fields || !onCommit) return;
    const cleanups: Array<() => void> = [];
    root.querySelectorAll<HTMLElement>(`[${INLINE_FIELD_ATTRIBUTE}]`).forEach((el) => {
      const field = el.getAttribute(INLINE_FIELD_ATTRIBUTE) ?? "";
      const spec = fields[field];
      if (!spec) return;
      const original = typeof props[field] === "string" ? (props[field] as string) : (el.textContent ?? "");
      let cancelled = false;
      el.setAttribute("contenteditable", "true");
      el.setAttribute("role", "textbox");
      el.setAttribute("dir", "auto");
      el.setAttribute("aria-label", t("builder.inline.pluginField", { field }));
      el.setAttribute("aria-multiline", spec.multiline ? "true" : "false");
      el.dataset.builderChrome = "true";
      el.classList.add("jf-inline-editable");
      const read = () => readEditableText(el, Boolean(spec.multiline));
      const onKey = (e: KeyboardEvent) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") {
          cancelled = true;
          el.blur();
        } else if (e.key === "Enter" && !spec.multiline) {
          e.preventDefault();
          el.blur();
        }
      };
      const onPaste = (e: ClipboardEvent) => {
        e.preventDefault();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        document.execCommand("insertText", false, spec.multiline ? text : text.replace(/\s*\n\s*/g, " "));
      };
      const onBlur = () => {
        if (cancelled) {
          cancelled = false;
          el.textContent = original;
          return;
        }
        const next = normalizeInlineValue({ ...spec, mode: "plain" }, read());
        if (next !== original) onCommit({ ...props, [field]: next });
      };
      el.addEventListener("keydown", onKey);
      el.addEventListener("paste", onPaste);
      el.addEventListener("blur", onBlur);
      cleanups.push(() => {
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("paste", onPaste);
        el.removeEventListener("blur", onBlur);
        el.removeAttribute("contenteditable");
      });
    });
    return () => cleanups.forEach((fn) => fn());
  }, [html, active, fields, onCommit, key]);

  if (!html) {
    return <div style={{ color: "var(--color-muted, var(--jf-text-3))", fontSize: "0.8rem" }}>{type}</div>;
  }
  return <div ref={container} data-jf-plugin-block={type} dangerouslySetInnerHTML={{ __html: html }} />;
}

const widgetChip: React.CSSProperties = {
  display: "inline-block",
  padding: "0.35rem 0.7rem",
  borderRadius: 999,
  background: "var(--color-surface, var(--jf-surface-3))",
  fontSize: "0.8rem",
  fontWeight: 600,
};

function widgetAlign(align: string): React.CSSProperties {
  if (align === "center") return { justifyContent: "center", width: "100%" };
  if (align === "right") return { justifyContent: "flex-end", width: "100%" };
  return { justifyContent: "flex-start" };
}
