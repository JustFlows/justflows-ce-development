import type { BlockNode } from "./types";
import { parseBlockStyle, sanitizeHtmlBlock, sanitizeRichText } from "@justflows/blocks";
import MotionPreview from "./MotionPreview";
import { applyMergeTags, useProductTags } from "../../lib/product-tags";

interface BlockPreviewProps {
  block: BlockNode;
  depth?: number;
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  renderChildren?: (children: BlockNode[], depth: number) => React.ReactNode;
}

export function BlockPreview({ block, depth = 0, onSelect, selectedId, renderChildren }: BlockPreviewProps) {
  const p = block.props;
  const tags = useProductTags();
  const text = (value: unknown) => applyMergeTags(String(value ?? ""), tags);
  const isSelected = selectedId === block.id;
  const blockStyle = parseBlockStyle(p.style);
  const wrap = (content: React.ReactNode, label?: string) => (
    <div
      onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(block.id); } : undefined}
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
        {content}
      </MotionPreview>
    </div>
  );

  switch (block.type) {
    case "core.section": {
      const bgMap: Record<string, string> = {
        default: "#fff",
        muted: "var(--jf-surface-2)",
        primary: "var(--jf-accent-soft)",
        dark: "var(--jf-text)",
        gradient: "linear-gradient(135deg, var(--jf-surface-2) 0%, var(--jf-accent-soft) 100%)",
      };
      const bg = bgMap[(p.background as string) ?? "default"] ?? "#fff";
      const padMap: Record<string, string> = { sm: "1rem", md: "2rem", lg: "3rem", xl: "4rem" };
      const padding = padMap[(p.padding as string) ?? "lg"] ?? "3rem";
      return wrap(
        <section style={{ background: bg, padding, color: p.background === "dark" ? "#fff" : undefined, textAlign: (p.align as string) === "center" ? "center" : "left" }}>
          {renderChildren?.(block.children ?? [], depth + 1) ?? (
            <div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", padding: "0.5rem" }}>Empty section — add blocks</div>
          )}
        </section>,
      );
    }

    case "core.container":
      return wrap(
        <div style={{ maxWidth: containerWidth(p.width as string), margin: "0 auto" }}>
          {renderChildren?.(block.children ?? [], depth + 1) ?? (
            <div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", padding: "0.5rem" }}>Empty container</div>
          )}
        </div>,
      );

    case "core.group":
      return wrap(<div>{renderChildren?.(block.children ?? [], depth + 1)}</div>);

    case "core.columns": {
      const cols = (p.columns as number) ?? 2;
      const gap = { sm: "0.75rem", md: "1.25rem", lg: "2rem" }[(p.gap as string) ?? "md"] ?? "1.25rem";
      return wrap(
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap, alignItems: "start" }}>
          {renderChildren?.(block.children ?? [], depth + 1)}
        </div>,
      );
    }

    case "core.column":
      return wrap(
        <div style={{ minHeight: 72, border: depth > 0 ? "1px dashed var(--jf-border-strong)" : undefined, borderRadius: 6, padding: "0.5rem" }}>
          {renderChildren?.(block.children ?? [], depth + 1) ?? (
            <div style={{ color: "var(--jf-text-3)", fontSize: "0.75rem" }}>Drop content here</div>
          )}
        </div>,
      );

    case "core.hero":
      return wrap(
        <section style={{
          background: p.backgroundImage
            ? `linear-gradient(rgba(15,23,42,.55), rgba(15,23,42,.55)), url(${p.backgroundImage as string}) center/cover`
            : "linear-gradient(135deg, var(--jf-surface-2) 0%, var(--jf-accent-soft) 100%)",
          padding: "4rem 2rem",
          textAlign: (p.align as string) === "center" ? "center" : "left",
          borderRadius: 8,
        }}>
          <h1 style={{ margin: "0 0 0.75rem", fontSize: "2rem", fontWeight: 900 }}>
            {(p.heading as string) || "Hero heading"}
          </h1>
          {(p.subheading as string) && <p style={{ margin: "0 0 1.5rem", color: "var(--jf-text-3)", maxWidth: 520 }}>{p.subheading as string}</p>}
          {(p.buttonLabel as string) && (
            <span style={{ display: "inline-block", padding: "0.6rem 1.25rem", background: "var(--jf-accent)", color: "#fff", borderRadius: 6, fontWeight: 600, fontSize: "0.875rem" }}>
              {p.buttonLabel as string}
            </span>
          )}
        </section>,
      );

    case "core.features": {
      const items = (p.items as Array<{ icon: string; title: string; description: string }>) ?? [];
      const cols = (p.columns as number) ?? 3;
      return wrap(
        <section style={{ padding: "2rem 0" }}>
          {(p.heading as string) && <h2 style={{ textAlign: "center", marginBottom: "1.5rem" }}>{p.heading as string}</h2>}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "1.25rem" }}>
            {items.map((item, i) => (
              <div key={i} style={{ padding: "1.25rem", background: "var(--jf-surface-2)", borderRadius: 8, textAlign: "center" }}>
                <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>{item.icon}</div>
                <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>{item.title || "Feature"}</h3>
                <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--jf-text-3)" }}>{item.description}</p>
              </div>
            ))}
          </div>
        </section>,
      );
    }

    case "core.cta": {
      const dark = p.variant === "dark";
      return wrap(
        <section style={{
          padding: "3rem 2rem",
          background: dark ? "var(--jf-text)" : "var(--jf-accent-soft)",
          color: dark ? "#fff" : "var(--jf-text)",
          borderRadius: 8,
          textAlign: "center",
        }}>
          <h2 style={{ margin: "0 0 0.5rem" }}>{(p.heading as string) || "Call to action"}</h2>
          {(p.text as string) && <p style={{ margin: "0 0 1.25rem", opacity: 0.85 }}>{p.text as string}</p>}
          {(p.buttonLabel as string) && (
            <span style={{ display: "inline-block", padding: "0.6rem 1.25rem", background: "var(--jf-accent)", color: "#fff", borderRadius: 6, fontWeight: 600 }}>
              {p.buttonLabel as string}
            </span>
          )}
        </section>,
      );
    }

    case "core.paragraph":
      return wrap(
        <p style={{ margin: 0 }} dangerouslySetInnerHTML={{ __html: sanitizeRichText(text(p.text)) || "<em style='color:var(--jf-text-3)'>Empty paragraph</em>" }} />,
      );

    case "core.heading": {
      const Tag = `h${Math.min(6, Math.max(1, (p.level as number) ?? 2))}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const heading = text(p.text);
      return wrap(<Tag style={{ margin: 0 }}>{heading || <em style={{ color: "var(--jf-text-3)" }}>Heading</em>}</Tag>);
    }

    case "core.image":
      return wrap(
        (p.src as string) ? (
          <figure style={{ margin: 0 }}>
            <img src={p.src as string} alt={(p.alt as string) ?? ""} style={{
              display: "block",
              width: Number(p.width) > 0 ? Number(p.width) : undefined,
              height: Number(p.height) > 0 ? Number(p.height) : undefined,
              maxWidth: "100%",
              objectFit: Number(p.height) > 0 ? ((p.objectFit as "contain" | "cover" | "fill") || "contain") : undefined,
              borderRadius: 6,
            }} />
            {(p.caption as string) ? <figcaption style={{ fontSize: "0.8rem", color: "var(--jf-text-3)", marginTop: "0.25rem" }}>{p.caption as string}</figcaption> : null}
          </figure>
        ) : <div style={{ background: "var(--jf-surface-3)", padding: "1.5rem", borderRadius: 6, textAlign: "center", color: "var(--jf-text-3)" }}>No image</div>,
      );

    case "core.quote":
      return wrap(
        <blockquote style={{ margin: 0, paddingLeft: "1rem", borderLeft: "3px solid var(--jf-accent)" }}>
          <p style={{ margin: 0 }}>{(p.text as string) || <em style={{ color: "var(--jf-text-3)" }}>Quote</em>}</p>
          {(p.attribution as string) ? <cite style={{ fontSize: "0.8rem", color: "var(--jf-text-3)" }}>— {p.attribution as string}</cite> : null}
        </blockquote>,
      );

    case "core.button":
      return wrap(
        <span style={{ display: "inline-block", padding: "0.5rem 1rem", background: "var(--jf-accent)", color: "#fff", borderRadius: 5, fontWeight: 600 }}>
          {(p.label as string) || "Button"}
        </span>,
      );

    case "core.link-list": {
      const items = (p.items as Array<{ label: string; url: string }>) ?? [];
      return wrap(
        <div>
          {(p.heading as string) && <h3 style={{ margin: "0 0 0.6rem", fontSize: "0.95rem" }}>{p.heading as string}</h3>}
          {items.length === 0 ? (
            <div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem" }}>No links yet</div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {items.map((item, i) => (
                <li key={i} style={{ fontSize: "0.85rem", color: "var(--jf-text-3)" }}>{item.label || item.url || "Link"}</li>
              ))}
            </ul>
          )}
        </div>,
      );
    }

    case "core.divider":
      return wrap(<hr style={{ border: "none", borderTop: "2px solid var(--jf-border)", margin: "0.5rem 0" }} />);

    case "core.spacer":
      return wrap(
        <div style={{ height: `${(p.height as number) ?? 40}px`, background: "repeating-linear-gradient(45deg, var(--jf-surface-2), var(--jf-surface-2) 5px, var(--jf-surface-3) 5px, var(--jf-surface-3) 10px)", borderRadius: 4 }} />,
      );

    case "core.code":
      return wrap(
        <pre style={{ margin: 0, padding: "0.75rem", background: "var(--jf-text)", color: "var(--jf-border)", borderRadius: 4, fontSize: "0.8rem", overflow: "auto" }}>
          <code>{(p.code as string) || "// code"}</code>
        </pre>,
      );

    case "core.embed":
      return wrap(
        <div style={{ background: "var(--jf-surface-3)", padding: "1rem", borderRadius: 6, textAlign: "center", color: "var(--jf-text-3)", fontSize: "0.875rem" }}>
          Embed: {(p.url as string) || "no URL"}
        </div>,
      );

    case "core.html":
      return wrap(
        <div
          dangerouslySetInnerHTML={{
            __html: sanitizeHtmlBlock(text(p.html)) || "<p>HTML</p>",
          }}
        />,
      );

    case "justflows.gallery.grid": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ src?: string; alt?: string }>;
      const layout = (p.layout as string) || "grid";
      const cols = layout === "carousel" || layout === "slideshow" || layout === "list" ? 1 : Math.min(6, Math.max(2, Number(p.columns) || 3));
      if (items.length === 0) {
        return wrap(<div style={{ background: "var(--jf-surface-3)", padding: "1.5rem", borderRadius: 6, textAlign: "center", color: "var(--jf-text-3)" }}>Empty gallery</div>);
      }
      const shown = layout === "carousel" || layout === "slideshow" ? items.slice(0, 1) : items.slice(0, 12);
      return wrap(
        <div>
          {layout !== "grid" && (
            <div style={{ fontSize: "0.7rem", color: "var(--jf-text-3)", marginBottom: "0.35rem", textTransform: "capitalize" }}>{layout}</div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: "0.5rem" }}>
            {shown.map((item, i) => (
              item.src
                ? <img key={i} src={item.src} alt={item.alt ?? ""} style={{ width: "100%", height: layout === "list" ? 140 : 72, objectFit: "cover", borderRadius: 4 }} />
                : <div key={i} style={{ height: 72, background: "var(--jf-border)", borderRadius: 4 }} />
            ))}
          </div>
        </div>,
      );
    }

    case "core.grid":
      return wrap(renderChildren ? <>{renderChildren(block.children ?? [], depth + 1)}</> : <div />);

    case "core.color-scheme":
      return wrap(
        <div style={{ display: "inline-flex", gap: 6, ...widgetAlign(p.align as string) }}>
          <span style={widgetChip}>☀ Light</span>
          <span style={widgetChip}>☾ Dark</span>
          {p.showSystem === true ? <span style={widgetChip}>◐ Auto</span> : null}
        </div>,
      );

    case "core.language-switcher":
      return wrap(
        <div style={{ display: "inline-flex", gap: 6, ...widgetAlign(p.align as string) }}>
          <span style={{ ...widgetChip, fontWeight: 700 }}>EN</span>
          <span style={widgetChip}>NL</span>
        </div>,
      );

    case "core.auth-links":
      return wrap(
        <div style={{ display: "inline-flex", gap: 8, alignItems: "center", ...widgetAlign(p.align as string) }}>
          {p.showLogin !== false ? (
            <span style={{ ...widgetChip, background: "#fff", border: "1px solid var(--jf-border-strong)" }}>
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
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: "0.75rem" }}>
            {Array.from({ length: layout === "grid" ? cols * 2 : 3 }).map((_, i) => (
              <div key={i} style={{ border: "1px solid var(--jf-border)", borderRadius: 6, padding: "0.6rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {p.showFeaturedImage !== false && <div style={{ height: 60, background: "var(--jf-border)", borderRadius: 4 }} />}
                <div style={{ height: 10, width: "70%", background: "var(--jf-text-3)", opacity: 0.5, borderRadius: 2 }} />
                {p.showDate !== false && <div style={{ height: 8, width: "40%", background: "var(--jf-border)", borderRadius: 2 }} />}
                {p.showExcerpt !== false && <div style={{ height: 8, width: "90%", background: "var(--jf-border)", borderRadius: 2 }} />}
              </div>
            ))}
          </div>
        </div>,
      );
    }

    case "justflows.shop.gallery": {
      const images = (Array.isArray(p.images) ? p.images : []) as Array<{ src?: string; alt?: string }>;
      const shown = images.filter((item) => item.src).slice(0, 4);
      if (shown.length === 0) {
        return wrap(<div style={{ background: "var(--jf-surface-3)", padding: "1.5rem", borderRadius: 6, textAlign: "center", color: "var(--jf-text-3)" }}>Product gallery</div>);
      }
      return wrap(
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--jf-text-3)", marginBottom: "0.35rem", textTransform: "capitalize" }}>{String(p.layout || "thumbs")}</div>
          <div style={{ display: "grid", gridTemplateColumns: shown.length === 1 ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: "0.5rem" }}>
            {shown.map((item, i) => (
              <img key={i} src={item.src} alt={item.alt ?? ""} style={{ width: "100%", height: shown.length === 1 ? 220 : 110, objectFit: "cover", borderRadius: 8 }} />
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
            {text(p.comparePrice) ? <span style={{ color: "var(--jf-text-3)", textDecoration: "line-through" }}>{text(p.comparePrice)}</span> : null}
          </div>
          <div style={{ color: "var(--jf-text-3)", fontSize: "0.85rem" }}>{text(p.description)}</div>
          <div style={{ background: "var(--jf-accent)", color: "#fff", borderRadius: 6, padding: "0.55rem 0.8rem", textAlign: "center", fontWeight: 700, fontSize: "0.85rem" }}>
            {text(p.cartLabel) || "Add to cart"}
          </div>
        </div>,
      );

    case "justflows.shop.breadcrumbs": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ name?: string }>;
      return wrap(
        <div style={{ fontSize: "0.8rem", color: "var(--jf-text-3)" }}>
          {items.map((item) => item.name).filter(Boolean).join(" / ")}
          {items.length ? " / " : ""}
          {text(p.current) || "Product"}
        </div>,
      );
    }

    case "justflows.shop.highlights": {
      const items = (Array.isArray(p.items) ? p.items : []) as string[];
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>{text(p.heading) || "Highlights"}</div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "var(--jf-text-3)", fontSize: "0.85rem" }}>
            {items.slice(0, 6).map((item, i) => <li key={i}>{text(item)}</li>)}
          </ul>
        </div>,
      );
    }

    case "justflows.shop.accordion": {
      const sections = (Array.isArray(p.sections) ? p.sections : []) as Array<{ name?: string }>;
      return wrap(
        <div style={{ fontSize: "0.85rem" }}>
          {sections.slice(0, 4).map((section, i) => (
            <div key={i} style={{ borderTop: "1px solid var(--jf-border)", padding: "0.45rem 0", fontWeight: 600 }}>{section.name || "Details"}</div>
          ))}
        </div>,
      );
    }

    case "justflows.shop.policies": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ name?: string; imageSrc?: string }>;
      return wrap(
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.75rem" }}>
          {items.slice(0, 4).map((item, i) => (
            <div key={i} style={{ fontSize: "0.8rem" }}>
              {item.imageSrc ? <img src={item.imageSrc} alt="" style={{ height: 36, width: "auto" }} /> : null}
              <div style={{ fontWeight: 600 }}>{item.name}</div>
            </div>
          ))}
        </div>,
      );
    }

    case "justflows.shop.reviews":
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>{text(p.heading) || "Customer Reviews"}</div>
          <div style={{ color: "var(--jf-text-3)", fontSize: "0.85rem" }}>
            {Number(p.average) > 0 ? `${p.average} ★ · ${p.totalCount || 0} reviews` : "No reviews yet"}
          </div>
        </div>,
      );

    case "justflows.shop.related": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ imageSrc?: string; name?: string }>;
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>{text(p.heading) || "You may also like"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: "0.5rem" }}>
            {items.slice(0, 4).map((item, i) => (
              item.imageSrc
                ? <img key={i} src={item.imageSrc} alt={item.name ?? ""} style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 6 }} />
                : <div key={i} style={{ height: 72, background: "var(--jf-border)", borderRadius: 6 }} />
            ))}
          </div>
        </div>,
      );
    }

    case "justflows.shop.product-list": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ imageSrc?: string; name?: string; price?: string }>;
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>{text(p.heading) || "Product list"}</div>
          <div style={{ fontSize: "0.7rem", color: "var(--jf-text-3)", marginBottom: "0.35rem", textTransform: "capitalize" }}>{String(p.layout || "inline").replace(/-/g, " ")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: "0.5rem" }}>
            {items.slice(0, 4).map((item, i) => (
              <div key={i}>
                {item.imageSrc
                  ? <img src={item.imageSrc} alt={item.name ?? ""} style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 6 }} />
                  : <div style={{ height: 72, background: "var(--jf-border)", borderRadius: 6 }} />}
                <div style={{ fontSize: "0.7rem", marginTop: 4 }}>{item.name}</div>
                <div style={{ fontSize: "0.7rem", fontWeight: 700 }}>{item.price}</div>
              </div>
            ))}
          </div>
        </div>,
      );
    }

    case "justflows.shop.detail-shots": {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ src?: string; alt?: string }>;
      return wrap(
        <div>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>{text(p.heading) || "The Fine Details"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.5rem" }}>
            {items.slice(0, 2).map((item, i) => (
              item.src
                ? <img key={i} src={item.src} alt={item.alt ?? ""} style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 6 }} />
                : <div key={i} style={{ height: 100, background: "var(--jf-border)", borderRadius: 6 }} />
            ))}
          </div>
        </div>,
      );
    }

    default:
      return wrap(<div style={{ color: "var(--jf-text-3)", fontSize: "0.8rem" }}>{block.type}</div>);
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

function containerWidth(width: string): string {
  switch (width) {
    case "narrow": return "560px";
    case "wide": return "1100px";
    case "full": return "100%";
    default: return "720px";
  }
}
