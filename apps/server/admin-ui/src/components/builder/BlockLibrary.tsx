import { useMemo, useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import type { BlockCatalogEntry, BlockNode } from "./types";
import { CATEGORY_LABEL_KEYS, CATEGORY_ORDER } from "./block-defaults";
import { useBuilderDrag } from "./DragContext";
import { DND_BLOCK_TYPE } from "./dnd";
import PatternLibrary from "./PatternLibrary";

/**
 * Blocks that make sense dropped into a site header, beyond anything in the
 * "site" category (which is always allowed). Sections, columns/grid, and other
 * whole-page machinery are filtered out.
 */
const HEADER_BLOCK_TYPES = new Set([
  "core.paragraph",
  "core.heading",
  "core.button",
  "core.link-list",
  "core.image",
  "core.html",
  "core.spacer",
  "core.divider",
]);

interface BlockLibraryProps {
  catalog: BlockCatalogEntry[];
  onAdd: (type: string) => void;
  onImportPattern?: (blocks: BlockNode[], syncedRef?: string, replaceCanvas?: boolean) => void;
  currentBlocks?: BlockNode[];
  parentType?: string | null;
  allowedChildTypes?: string[];
  /** Full standalone page vs. a post/article body. Hides whole-page patterns and site-chrome widgets that don't apply to a post. */
  isPage?: boolean;
  /** Editing a site header — restrict to header-appropriate blocks, no patterns. */
  headerOnly?: boolean;
}

export default function BlockLibrary({
  catalog,
  onAdd,
  onImportPattern,
  currentBlocks = [],
  parentType,
  allowedChildTypes,
  isPage = false,
  headerOnly = false,
}: BlockLibraryProps) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [openCat, setOpenCat] = useState<string>("patterns");
  const { onDragStartType, onDragEnd } = useBuilderDrag();

  const filtered = useMemo(() => {
    let list = catalog;
    if (parentType) {
      list = list.filter((b) => {
        if (b.type === "core.column" && parentType !== "core.columns") return false;
        if (allowedChildTypes?.length) return allowedChildTypes.includes(b.type);
        if (parentType === "core.columns") return b.type === "core.column";
        if (parentType === "core.column")
          return b.type !== "core.column" && b.type !== "core.columns";
        return b.type !== "core.column";
      });
    } else {
      list = list.filter((b) => b.type !== "core.column");
    }

    // Site-chrome widgets (theme toggle, language switcher, login/register links) belong in a
    // page's header/footer, not inside a post body.
    if (!isPage) list = list.filter((b) => b.category !== "site");

    // A site header only takes site widgets plus a handful of inline blocks.
    if (headerOnly)
      list = list.filter((b) => b.category === "site" || HEADER_BLOCK_TYPES.has(b.type));

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((b) => b.title.toLowerCase().includes(q) || b.type.includes(q));
    }
    return list;
  }, [catalog, parentType, allowedChildTypes, query, isPage, headerOnly]);

  const grouped = useMemo(() => {
    const map = new Map<string, BlockCatalogEntry[]>();
    for (const cat of CATEGORY_ORDER) map.set(cat, []);
    for (const block of filtered) {
      const cat = block.category ?? "content";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(block);
    }
    return map;
  }, [filtered]);

  function startDrag(e: React.DragEvent, type: string) {
    e.dataTransfer.setData(DND_BLOCK_TYPE, type);
    e.dataTransfer.setData("text/plain", type);
    e.dataTransfer.effectAllowed = "copy";
    onDragStartType(type);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "0.75rem", borderBottom: "1px solid var(--jf-border)" }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: "0.8rem",
            color: "var(--jf-text-2)",
            marginBottom: "0.25rem",
          }}
        >
          {t("builder.blockLibrary.blocks")}
        </div>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.65rem", color: "var(--jf-text-3)" }}>
          {t("builder.blockLibrary.dragOrClickHint")}
        </p>
        <input
          type="search"
          placeholder={t("builder.blockLibrary.searchBlocksPlaceholder")}
          aria-label={t("builder.blockLibrary.searchBlocks")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "0.45rem 0.6rem",
            border: "1px solid var(--jf-border-strong)",
            borderRadius: 6,
            fontSize: "0.8rem",
          }}
        />
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0.5rem" }}>
        {isPage && !headerOnly && onImportPattern && (
          <div style={{ marginBottom: "0.75rem" }}>
            <PatternLibrary
              catalog={catalog}
              currentBlocks={currentBlocks}
              onInsert={onImportPattern}
            />
          </div>
        )}

        {[...grouped.keys()].map((cat) => {
          const items = grouped.get(cat) ?? [];
          if (!items.length) return null;
          const isOpen = openCat === cat || query.trim().length > 0;
          return (
            <div key={cat} style={{ marginBottom: "0.35rem" }}>
              <button
                type="button"
                onClick={() => setOpenCat(isOpen && !query ? "" : cat)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.45rem 0.5rem",
                  background: "none",
                  border: "none",
                  fontWeight: 700,
                  fontSize: "0.7rem",
                  color: "var(--jf-text-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  cursor: "pointer",
                }}
              >
                {CATEGORY_LABEL_KEYS[cat] ? t(CATEGORY_LABEL_KEYS[cat]) : cat}
                <span>{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                  {items.map((block) => (
                    <div
                      key={block.type}
                      draggable
                      onDragStart={(e) => startDrag(e, block.type)}
                      onDragEnd={onDragEnd}
                      onClick={() => onAdd(block.type)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.6rem",
                        padding: "0.5rem 0.6rem",
                        border: "1px solid transparent",
                        borderRadius: 6,
                        background: "#fff",
                        cursor: "grab",
                        textAlign: "left",
                        fontSize: "0.8rem",
                        fontWeight: 500,
                        color: "#334155",
                        userSelect: "none",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--jf-surface-3)";
                        e.currentTarget.style.borderColor = "var(--jf-border)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "#fff";
                        e.currentTarget.style.borderColor = "transparent";
                      }}
                    >
                      <span style={{ width: 22, textAlign: "center", opacity: 0.85 }}>
                        {block.icon}
                      </span>
                      {block.title}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
