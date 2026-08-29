import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { BlockCatalogEntry, BlockNode } from "./types";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "./block-defaults";
import { useBuilderDrag } from "./DragContext";
import { DND_BLOCK_TYPE } from "./dnd";

interface ThemePatternMeta {
  id: string;
  title: string;
  description?: string;
  category?: string;
  /** Block types this pattern uses that come from a plugin rather than core. */
  requiresBlockTypes?: string[];
}

/** Plugin id to link to under Extensions for a given block type prefix, e.g. "justflows.forms.form" -> "justflows.forms". */
function pluginIdForBlockType(blockType: string): string {
  return blockType.split(".").slice(0, 2).join(".");
}

const PLUGIN_NAMES: Record<string, string> = {
  "justflows.forms": "Forms",
  "justflows.shop": "Shop",
};

interface BlockLibraryProps {
  catalog: BlockCatalogEntry[];
  onAdd: (type: string) => void;
  onImportPattern?: (blocks: BlockNode[]) => void;
  parentType?: string | null;
  allowedChildTypes?: string[];
  /** Full standalone page vs. a post/article body. Hides whole-page patterns and site-chrome widgets that don't apply to a post. */
  isPage?: boolean;
}

export default function BlockLibrary({ catalog, onAdd, onImportPattern, parentType, allowedChildTypes, isPage = false }: BlockLibraryProps) {
  const [query, setQuery] = useState("");
  const [openCat, setOpenCat] = useState<string>("patterns");
  const [patterns, setPatterns] = useState<ThemePatternMeta[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const { onDragStartType, onDragEnd } = useBuilderDrag();
  const catalogTypes = useMemo(() => new Set(catalog.map((b) => b.type)), [catalog]);

  useEffect(() => {
    // Patterns are whole-page compositions (hero + sections) — only relevant when building a full page.
    if (!isPage) {
      setPatterns([]);
      return;
    }
    fetch("/api/themes/patterns")
      .then((r) => r.json())
      .then((data: { patterns?: ThemePatternMeta[] }) => setPatterns(data.patterns ?? []))
      .catch(() => setPatterns([]));
  }, [isPage]);

  async function handleImportPattern(patternId: string) {
    if (!onImportPattern) return;
    setImporting(patternId);
    try {
      const res = await fetch(`/api/themes/patterns/${encodeURIComponent(patternId)}`);
      const data = await res.json() as { pattern?: { blocks?: BlockNode[] } };
      const patternBlocks = data.pattern?.blocks;
      if (patternBlocks?.length) onImportPattern(patternBlocks);
    } finally {
      setImporting(null);
    }
  }

  const filtered = useMemo(() => {
    let list = catalog;
    if (parentType) {
      list = list.filter((b) => {
        if (b.type === "core.column" && parentType !== "core.columns") return false;
        if (allowedChildTypes?.length) return allowedChildTypes.includes(b.type);
        if (parentType === "core.columns") return b.type === "core.column";
        if (parentType === "core.column") return b.type !== "core.column" && b.type !== "core.columns";
        return b.type !== "core.column";
      });
    } else {
      list = list.filter((b) => b.type !== "core.column");
    }

    // Site-chrome widgets (theme toggle, language switcher, login/register links) belong in a
    // page's header/footer, not inside a post body.
    if (!isPage) list = list.filter((b) => b.category !== "site");

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((b) => b.title.toLowerCase().includes(q) || b.type.includes(q));
    }
    return list;
  }, [catalog, parentType, allowedChildTypes, query, isPage]);

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
        <div style={{ fontWeight: 700, fontSize: "0.8rem", color: "var(--jf-text-2)", marginBottom: "0.25rem" }}>Blocks</div>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.65rem", color: "var(--jf-text-3)" }}>Drag into a section or click to add</p>
        <input
          type="search"
          placeholder="Search blocks…"
          aria-label="Search blocks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid var(--jf-border-strong)", borderRadius: 6, fontSize: "0.8rem" }}
        />
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0.5rem" }}>
        {isPage && patterns.length > 0 && onImportPattern && (
          <div style={{ marginBottom: "0.5rem" }}>
            <button
              type="button"
              onClick={() => setOpenCat(openCat === "patterns" && !query ? "" : "patterns")}
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
              Patterns
              <span>{openCat === "patterns" || query ? "−" : "+"}</span>
            </button>
            {(openCat === "patterns" || query.trim()) && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {patterns
                  .filter((p) => !query.trim() || p.title.toLowerCase().includes(query.toLowerCase()))
                  .map((pattern) => {
                    const missingTypes = (pattern.requiresBlockTypes ?? []).filter((t) => !catalogTypes.has(t));
                    return (
                      <div
                        key={pattern.id}
                        style={{
                          border: "1px solid var(--jf-border)",
                          borderRadius: 6,
                          background: "#fff",
                          overflow: "hidden",
                        }}
                      >
                        <button
                          type="button"
                          disabled={importing === pattern.id || missingTypes.length > 0}
                          onClick={() => {
                            if (missingTypes.length > 0) return;
                            handleImportPattern(pattern.id);
                          }}
                          style={{
                            display: "block",
                            width: "100%",
                            padding: "0.55rem 0.65rem",
                            border: "none",
                            background: "none",
                            cursor: missingTypes.length > 0 ? "not-allowed" : importing === pattern.id ? "wait" : "pointer",
                            textAlign: "left",
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: "0.8rem", color: "#334155" }}>{pattern.title}</div>
                          {pattern.description && (
                            <div style={{ fontSize: "0.65rem", color: "var(--jf-text-3)", marginTop: 2, lineHeight: 1.35 }}>{pattern.description}</div>
                          )}
                        </button>
                        {missingTypes.length > 0 && (
                          <div
                            style={{
                              padding: "0.4rem 0.65rem",
                              borderTop: "1px solid var(--jf-border)",
                              background: "var(--jf-warning-bg, #fffbeb)",
                              fontSize: "0.65rem",
                              color: "var(--jf-warning-text, #92400e)",
                              lineHeight: 1.4,
                            }}
                          >
                            {missingTypes.map((type) => {
                              const pluginId = pluginIdForBlockType(type);
                              const pluginName = PLUGIN_NAMES[pluginId] ?? pluginId;
                              return (
                                <div key={type}>
                                  ⓘ Uses the {pluginName} extension, which isn't installed yet.{" "}
                                  <Link to="/admin/plugins" style={{ color: "inherit", fontWeight: 600, textDecoration: "underline" }}>
                                    Install it
                                  </Link>{" "}
                                  to make this block work.
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {CATEGORY_ORDER.map((cat) => {
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
                {CATEGORY_LABELS[cat] ?? cat}
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
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--jf-surface-3)"; e.currentTarget.style.borderColor = "var(--jf-border)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "transparent"; }}
                    >
                      <span style={{ width: 22, textAlign: "center", opacity: 0.85 }}>{block.icon}</span>
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
