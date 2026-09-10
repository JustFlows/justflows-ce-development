import { useT } from "../../i18n/I18nProvider";
import { cloneElement, isValidElement, useEffect, type ReactElement } from "react";
import type { BlockNode } from "./types";
import { parseBlockStyle, sanitizeHtmlBlock, sanitizeRichText } from "@justflows/blocks";
import MotionPreview from "./MotionPreview";
import { applyMergeTags, useProductTags } from "../../lib/product-tags";

/** Class the active theme's stylesheet is scoped to (see `serveThemeCss`). */
export const THEME_PREVIEW_SCOPE = "jf-theme-surface";
const THEME_PREVIEW_LINK_ID = "jf-theme-preview-css";
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
}

export function BlockPreview({
  block,
  depth = 0,
  onSelect,
  selectedId,
  renderChildren,
}: BlockPreviewProps) {
  const { t } = useT();
  const p = block.props;
  const tags = useProductTags();
  const text = (value: unknown) => applyMergeTags(String(value ?? ""), tags);
  const isSelected = selectedId === block.id;
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
        onClick={
          onSelect
            ? (e) => {
                e.stopPropagation();
                onSelect(block.id);
              }
            : undefined
        }
        style={{
          outline: isSelected ? "2px solid var(--jf-accent)" : undefined,
          outlineOffset: 2,
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
              <div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", padding: "0.5rem" }}>
                Empty section — add blocks
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
            <div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", padding: "0.5rem" }}>
              Empty container
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
            <div style={{ color: "var(--jf-text-3)", fontSize: "0.75rem" }}>Drop content here</div>
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
            <h1 className="jf-hero__heading">{(p.heading as string) || "Hero heading"}</h1>
            {(p.subheading as string) && <p className="jf-hero__sub">{p.subheading as string}</p>}
            {(p.buttonLabel as string) && (
              <span className="btn btn--primary jf-hero__btn">{p.buttonLabel as string}</span>
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
                  <h3 className="jf-feature__title">{item.title || "Feature"}</h3>
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
            <h2 className="jf-cta__heading">{(p.heading as string) || "Call to action"}</h2>
            {(p.text as string) && <p className="jf-cta__text">{p.text as string}</p>}
            {(p.buttonLabel as string) && (
              <span className="btn btn--primary jf-cta__btn">{p.buttonLabel as string}</span>
            )}
          </div>
        </section>,
      );
    }

    case "core.paragraph":
      return wrap(
        <div
          className="jf-paragraph"
          dangerouslySetInnerHTML={{
            __html:
              sanitizeRichText(text(p.text)) ||
              "<em style='color:var(--jf-text-3)'>Empty paragraph</em>",
          }}
        />,
      );

    case "core.heading": {
      const Tag = `h${Math.min(6, Math.max(1, (p.level as number) ?? 2))}` as
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const heading = text(p.text);
      return wrap(<Tag>{heading || <em style={{ color: "var(--jf-text-3)" }}>Heading</em>}</Tag>);
    }

    case "core.image":
      return wrap(
        (p.src as string) ? (
          <figure style={{ margin: 0 }}>
            <img
              src={p.src as string}
              alt={(p.alt as string) ?? ""}
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
              }}
            />
            {(p.caption as string) ? (
              <figcaption
                style={{ fontSize: "0.8rem", color: "var(--jf-text-3)", marginTop: "0.25rem" }}
              >
                {p.caption as string}
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <div
            style={{
              background: "var(--jf-surface-3)",
              padding: "1.5rem",
              borderRadius: 6,
              textAlign: "center",
              color: "var(--jf-text-3)",
            }}
          >
            No image
          </div>
        ),
      );

    case "core.quote":
      return wrap(
        <blockquote>
          <div className="jf-quote__text">
            {(p.text as string) || <em style={{ color: "var(--jf-text-3)" }}>Quote</em>}
          </div>
          {(p.attribution as string) ? <cite>— {p.attribution as string}</cite> : null}
        </blockquote>,
      );

    case "core.button":
      return wrap(
        <span className={`btn btn--${(p.variant as string) || "primary"}`}>
          {(p.label as string) || "Button"}
        </span>,
      );

    case "core.link-list": {
      const items = (p.items as Array<{ label: string; url: string }>) ?? [];
      return wrap(
        <div className="jf-link-list">
          {(p.heading as string) && (
            <h3 className="jf-link-list__heading">{p.heading as string}</h3>
          )}
          {items.length === 0 ? (
            <div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem" }}>No links yet</div>
          ) : (
            <ul className="jf-link-list__items">
              {items.map((item, i) => (
                <li key={i}>
                  <span className="jf-link-list__link">{item.label || item.url || "Link"}</span>
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
              "repeating-linear-gradient(45deg, var(--jf-surface-2), var(--jf-surface-2) 5px, var(--jf-surface-3) 5px, var(--jf-surface-3) 10px)",
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
            background: "var(--jf-text)",
            color: "var(--jf-border)",
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
            background: "var(--jf-surface-3)",
            padding: "1rem",
            borderRadius: 6,
            textAlign: "center",
            color: "var(--jf-text-3)",
            fontSize: "0.875rem",
          }}
        >
          Embed: {(p.url as string) || "no URL"}
        </div>,
      );

    case "core.html":
      return wrap(
        <div
          className="jf-html"
          dangerouslySetInnerHTML={{
            __html: sanitizeHtmlBlock(text(p.html)) || "<p>HTML</p>",
          }}
        />,
      );

    case "justflows.gallery.grid": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{
        src?: string;
        alt?: string;
      }>;
      const layout = (p.layout as string) || "grid";
      const cols =
        layout === "carousel" || layout === "slideshow" || layout === "list"
          ? 1
          : Math.min(6, Math.max(2, Number(p.columns) || 3));
      if (items.length === 0) {
        return wrap(
          <div
            style={{
              background: "var(--jf-surface-3)",
              padding: "1.5rem",
              borderRadius: 6,
              textAlign: "center",
              color: "var(--jf-text-3)",
            }}
          >
            Empty gallery
          </div>,
        );
      }
      const shown =
        layout === "carousel" || layout === "slideshow" ? items.slice(0, 1) : items.slice(0, 12);
      return wrap(
        <div>
          {layout !== "grid" && (
            <div
              style={{
                fontSize: "0.7rem",
                color: "var(--jf-text-3)",
                marginBottom: "0.35rem",
                textTransform: "capitalize",
              }}
            >
              {layout}
            </div>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: "0.5rem",
            }}
          >
            {shown.map((item, i) =>
              item.src ? (
                <img
                  key={i}
                  src={item.src}
                  alt={item.alt ?? ""}
                  style={{
                    width: "100%",
                    height: layout === "list" ? 140 : 72,
                    objectFit: "cover",
                    borderRadius: 4,
                  }}
                />
              ) : (
                <div
                  key={i}
                  style={{ height: 72, background: "var(--jf-border)", borderRadius: 4 }}
                />
              ),
            )}
          </div>
        </div>,
      );
    }

    case "core.grid":
      return wrap(
        renderChildren ? <>{renderChildren(block.children ?? [], depth + 1)}</> : <div />,
      );

    case "core.color-scheme": {
      const schemeStyle = (p.style as string) || "buttons";
      const lightIcon = (p.lightIcon as string) || "☀";
      const darkIcon = (p.darkIcon as string) || "☾";
      const schemeModes: Array<[string, string]> = [
        [lightIcon, (p.lightLabel as string) || "Light"],
        [darkIcon, (p.darkLabel as string) || "Dark"],
      ];
      if (p.showSystem === true)
        schemeModes.push([(p.autoIcon as string) || "◐", (p.autoLabel as string) || "Auto"]);
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
              {(p.darkLabel as string) || "Dark"}
            </span>
            <span
              style={{
                position: "relative",
                display: "inline-block",
                width: 34,
                height: 19,
                borderRadius: 999,
                background: "var(--jf-surface-4, #cbd5e1)",
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
                  background: "#fff",
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
        { full: "en-US", short: "en", flag: "🇺🇸", country: "United States" },
        { full: "nl-NL", short: "nl", flag: "🇳🇱", country: "Netherlands" },
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
                        ? index === 0
                          ? "English"
                          : "Nederlands"
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
                background: "#fff",
                border: "1px solid var(--jf-border-strong)",
              }}
            >
              {(p.loginLabel as string) || "Log in"}
            </span>
          ) : null}
          {p.showRegister !== false ? (
            <span style={{ ...widgetChip, background: "var(--jf-accent)", color: "#fff" }}>
              {(p.registerLabel as string) || "Register"}
            </span>
          ) : null}
        </div>,
      );

    case "justflows.blog.postList": {
      const layout = (p.layout as string) === "list" ? "list" : "grid";
      const cols = layout === "grid" ? Math.min(4, Math.max(1, Number(p.columns) || 3)) : 1;
      return wrap(
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--jf-text-3)", marginBottom: "0.5rem" }}>
            📰 Blog posts — newest {(Number(p.postsPerPage) || undefined) ?? "N"} shown, paginated
          </div>
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
                  border: "1px solid var(--jf-border)",
                  borderRadius: 6,
                  padding: "0.6rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                }}
              >
                {p.showFeaturedImage !== false && (
                  <div style={{ height: 60, background: "var(--jf-border)", borderRadius: 4 }} />
                )}
                <div
                  style={{
                    height: 10,
                    width: "70%",
                    background: "var(--jf-text-3)",
                    opacity: 0.5,
                    borderRadius: 2,
                  }}
                />
                {p.showDate !== false && (
                  <div
                    style={{
                      height: 8,
                      width: "40%",
                      background: "var(--jf-border)",
                      borderRadius: 2,
                    }}
                  />
                )}
                {p.showExcerpt !== false && (
                  <div
                    style={{
                      height: 8,
                      width: "90%",
                      background: "var(--jf-border)",
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

    case "justflows.shop.gallery": {
      const images = (Array.isArray(p.images) ? p.images : []) as Array<{
        src?: string;
        alt?: string;
      }>;
      const shown = images.filter((item) => item.src).slice(0, 4);
      if (shown.length === 0) {
        return wrap(
          <div
            style={{
              background: "var(--jf-surface-3)",
              padding: "1.5rem",
              borderRadius: 6,
              textAlign: "center",
              color: "var(--jf-text-3)",
            }}
          >
            Product gallery
          </div>,
        );
      }
      return wrap(
        <div>
          <div
            style={{
              fontSize: "0.7rem",
              color: "var(--jf-text-3)",
              marginBottom: "0.35rem",
              textTransform: "capitalize",
            }}
          >
            {String(p.layout || "thumbs")}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: shown.length === 1 ? "1fr" : "repeat(2, minmax(0, 1fr))",
              gap: "0.5rem",
            }}
          >
            {shown.map((item, i) => (
              <img
                key={i}
                src={item.src}
                alt={item.alt ?? ""}
                style={{
                  width: "100%",
                  height: shown.length === 1 ? 220 : 110,
                  objectFit: "cover",
                  borderRadius: 8,
                }}
              />
            ))}
          </div>
        </div>,
      );
    }

    case "justflows.shop.buy-box":
      return wrap(
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ fontSize: "1.35rem", fontWeight: 800 }}>{text(p.title) || "Product"}</div>
          <div style={{ display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
            <strong>{text(p.price) || "Price"}</strong>
            {text(p.comparePrice) ? (
              <span style={{ color: "var(--jf-text-3)", textDecoration: "line-through" }}>
                {text(p.comparePrice)}
              </span>
            ) : null}
          </div>
          <div style={{ color: "var(--jf-text-3)", fontSize: "0.85rem" }}>
            {text(p.description)}
          </div>
          <div
            style={{
              background: "var(--jf-accent)",
              color: "#fff",
              borderRadius: 6,
              padding: "0.55rem 0.8rem",
              textAlign: "center",
              fontWeight: 700,
              fontSize: "0.85rem",
            }}
          >
            {text(p.cartLabel) || "Add to cart"}
          </div>
        </div>,
      );

    case "justflows.shop.breadcrumbs": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ name?: string }>;
      return wrap(
        <div style={{ fontSize: "0.8rem", color: "var(--jf-text-3)" }}>
          {items
            .map((item) => item.name)
            .filter(Boolean)
            .join(" / ")}
          {items.length ? " / " : ""}
          {text(p.current) || "Product"}
        </div>,
      );
    }

    case "justflows.shop.highlights": {
      const items = (Array.isArray(p.items) ? p.items : []) as string[];
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>
            {text(p.heading) || "Highlights"}
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.1rem",
              color: "var(--jf-text-3)",
              fontSize: "0.85rem",
            }}
          >
            {items.slice(0, 6).map((item, i) => (
              <li key={i}>{text(item)}</li>
            ))}
          </ul>
        </div>,
      );
    }

    case "justflows.shop.accordion": {
      const sections = (Array.isArray(p.sections) ? p.sections : []) as Array<{ name?: string }>;
      return wrap(
        <div style={{ fontSize: "0.85rem" }}>
          {sections.slice(0, 4).map((section, i) => (
            <div
              key={i}
              style={{
                borderTop: "1px solid var(--jf-border)",
                padding: "0.45rem 0",
                fontWeight: 600,
              }}
            >
              {section.name || "Details"}
            </div>
          ))}
        </div>,
      );
    }

    case "justflows.shop.policies": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{
        name?: string;
        imageSrc?: string;
      }>;
      return wrap(
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "0.75rem",
          }}
        >
          {items.slice(0, 4).map((item, i) => (
            <div key={i} style={{ fontSize: "0.8rem" }}>
              {item.imageSrc ? (
                <img src={item.imageSrc} alt="" style={{ height: 36, width: "auto" }} />
              ) : null}
              <div style={{ fontWeight: 600 }}>{item.name}</div>
            </div>
          ))}
        </div>,
      );
    }

    case "justflows.shop.reviews":
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>
            {text(p.heading) || "Customer Reviews"}
          </div>
          <div style={{ color: "var(--jf-text-3)", fontSize: "0.85rem" }}>
            {Number(p.average) > 0
              ? `${p.average} ★ · ${p.totalCount || 0} reviews`
              : "No reviews yet"}
          </div>
        </div>,
      );

    case "justflows.shop.related": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{
        imageSrc?: string;
        name?: string;
      }>;
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>
            {text(p.heading) || "You may also like"}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))",
              gap: "0.5rem",
            }}
          >
            {items
              .slice(0, 4)
              .map((item, i) =>
                item.imageSrc ? (
                  <img
                    key={i}
                    src={item.imageSrc}
                    alt={item.name ?? ""}
                    style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 6 }}
                  />
                ) : (
                  <div
                    key={i}
                    style={{ height: 72, background: "var(--jf-border)", borderRadius: 6 }}
                  />
                ),
              )}
          </div>
        </div>,
      );
    }

    case "justflows.shop.product-list": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{
        imageSrc?: string;
        name?: string;
        price?: string;
      }>;
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>
            {text(p.heading) || "Product list"}
          </div>
          <div
            style={{
              fontSize: "0.7rem",
              color: "var(--jf-text-3)",
              marginBottom: "0.35rem",
              textTransform: "capitalize",
            }}
          >
            {String(p.layout || "inline").replace(/-/g, " ")}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))",
              gap: "0.5rem",
            }}
          >
            {items.slice(0, 4).map((item, i) => (
              <div key={i}>
                {item.imageSrc ? (
                  <img
                    src={item.imageSrc}
                    alt={item.name ?? ""}
                    style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 6 }}
                  />
                ) : (
                  <div style={{ height: 72, background: "var(--jf-border)", borderRadius: 6 }} />
                )}
                <div style={{ fontSize: "0.7rem", marginTop: 4 }}>{item.name}</div>
                <div style={{ fontSize: "0.7rem", fontWeight: 700 }}>{item.price}</div>
              </div>
            ))}
          </div>
        </div>,
      );
    }

    case "justflows.shop.detail-shots": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{
        src?: string;
        alt?: string;
      }>;
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>
            {text(p.heading) || "The Fine Details"}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "0.5rem",
            }}
          >
            {items
              .slice(0, 2)
              .map((item, i) =>
                item.src ? (
                  <img
                    key={i}
                    src={item.src}
                    alt={item.alt ?? ""}
                    style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 6 }}
                  />
                ) : (
                  <div
                    key={i}
                    style={{ height: 100, background: "var(--jf-border)", borderRadius: 6 }}
                  />
                ),
              )}
          </div>
        </div>,
      );
    }

    case "core.post-title": {
      const level = Math.min(6, Math.max(1, Number(p.level) || 1));
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      return wrap(<Tag className="post-title">Post title</Tag>);
    }

    case "core.post-meta":
      return wrap(<p className="post-meta">Published date</p>);

    case "core.post-excerpt":
      return wrap(<p className="post-excerpt">The post excerpt appears here.</p>);

    case "core.featured-image":
      return wrap(
        <figure
          className="post-featured-image"
          style={{
            aspectRatio: "16 / 9",
            background: "var(--jf-surface-3)",
            display: "grid",
            placeItems: "center",
            color: "var(--jf-text-3)",
            fontSize: "0.8rem",
            borderRadius: 6,
          }}
        >
          Featured image
        </figure>,
      );

    case "core.post-content":
      return wrap(
        <div
          style={{
            border: "1px dashed var(--jf-border)",
            borderRadius: 6,
            padding: "1.25rem",
            color: "var(--jf-text-3)",
            fontSize: "0.8rem",
          }}
        >
          ¶ Post content — the page or post's own blocks render here
        </div>,
      );

    case "core.template-part":
      return wrap(
        <div
          style={{
            border: "1px dashed var(--jf-border)",
            borderRadius: 6,
            padding: "0.75rem 1rem",
            color: "var(--jf-text-3)",
            fontSize: "0.8rem",
          }}
        >
          ▤ Template part: {String(p.slug || "header")}
        </div>,
      );

    default:
      return wrap(
        <div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem" }}>{block.type}</div>,
      );
  }
}

const widgetChip: React.CSSProperties = {
  display: "inline-block",
  padding: "0.35rem 0.7rem",
  borderRadius: 999,
  background: "var(--jf-surface-3)",
  fontSize: "0.8rem",
  fontWeight: 600,
};

function widgetAlign(align: string): React.CSSProperties {
  if (align === "center") return { justifyContent: "center", width: "100%" };
  if (align === "right") return { justifyContent: "flex-end", width: "100%" };
  return { justifyContent: "flex-start" };
}
