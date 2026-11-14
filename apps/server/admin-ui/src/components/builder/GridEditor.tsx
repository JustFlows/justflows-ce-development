import { useCallback, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider";
import { compactBlockPlacement, isPlacementShaped, type BlockPlacement } from "@justflows/blocks";
import { createBlock } from "./block-defaults";
import { DND_BLOCK_TYPE } from "./dnd";
import { useBuilderDrag } from "./DragContext";
import {
  columnAt,
  gridColumns,
  placeAt,
  placementForDrop,
  placementOf,
  readRowSizes,
  resizeEnd,
  resizeStart,
  rowAt,
  type GridCell,
} from "./grid";
import type { BlockNode } from "./types";

const GAP_PX: Record<string, number> = { none: 0, sm: 12, md: 24, lg: 40 };
const ROW_MIN_PX: Record<string, number> = { auto: 0, sm: 64, md: 128, lg: 224 };

/** Write a placement back onto a child, dropping it entirely when it is the default. */
function withPlacement(child: BlockNode, placement: BlockPlacement, columns: number): BlockNode {
  const props = { ...child.props };
  const compact = compactBlockPlacement(placement, columns);
  if (compact) props.gridPlacement = compact;
  else delete props.gridPlacement;
  // Clean up legacy placement data stored under the old shared "layout" key.
  if (isPlacementShaped(props.layout)) delete props.layout;
  return { ...child, props };
}

interface GridEditorProps {
  block: BlockNode;
  children: BlockNode[];
  onChildrenChange: (children: BlockNode[]) => void;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
  renderChild: (child: BlockNode, index: number) => ReactNode;
}

export default function GridEditor({
  block,
  children,
  onChildrenChange,
  onSelect,
  selectedId,
  renderChild,
}: GridEditorProps) {
  const { t } = useT();
  const gridRef = useRef<HTMLDivElement>(null);
  const { dragging, dragPayload } = useBuilderDrag();
  const [ghost, setGhost] = useState<BlockPlacement | null>(null);

  const columns = gridColumns(block);
  const gap = GAP_PX[String(block.props?.gap ?? "md")] ?? 24;
  const rowMin = ROW_MIN_PX[String(block.props?.rowHeight ?? "auto")] ?? 0;

  /** Pointer position → the cell under it, using the grid's own laid-out tracks. */
  const cellFromPointer = useCallback((clientX: number, clientY: number): GridCell | null => {
    const el = gridRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const { sizes, gap: rowGap } = readRowSizes(el);
    return { col: columnAt(rect, columns, clientX), row: rowAt(sizes, rowGap, rect.top, clientY) };
  }, [columns]);

  const commit = useCallback((child: BlockNode, placement: BlockPlacement) => {
    onChildrenChange(children.map((c) => (c.id === child.id ? withPlacement(c, placement, columns) : c)));
  }, [children, columns, onChildrenChange]);

  /** Shared pointer loop for moving a block and for dragging either edge. */
  const startDrag = useCallback(
    (child: BlockNode, mode: "move" | "start" | "end", event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const base = placementOf(child, columns);
      let latest = base;

      const onMove = (ev: PointerEvent) => {
        const cell = cellFromPointer(ev.clientX, ev.clientY);
        if (!cell) return;
        latest =
          mode === "move" ? placeAt(base, cell, columns)
          : mode === "end" ? resizeEnd(base, cell.col, columns)
          : resizeStart(base, cell.col, columns);
        setGhost(latest);
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = "";
        setGhost(null);
        commit(child, latest);
      };

      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      onSelect(child.id);
    },
    [cellFromPointer, columns, commit, onSelect],
  );

  /** A block dragged in from the library lands on the cell it was released over. */
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const type = e.dataTransfer.getData(DND_BLOCK_TYPE) || dragPayload.type;
    setGhost(null);
    if (!type || dragPayload.blockId) return;
    const cell = cellFromPointer(e.clientX, e.clientY);
    if (!cell) return;
    const created = createBlock(type, t);
    onChildrenChange([...children, withPlacement(created, placementForDrop(cell, columns), columns)]);
    onSelect(created.id);
  }

  function onDragOver(e: React.DragEvent) {
    if (!dragPayload.type || dragPayload.blockId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    const cell = cellFromPointer(e.clientX, e.clientY);
    if (cell) setGhost(placementForDrop(cell, columns));
  }

  const showGuides = dragging || ghost !== null || selectedId === block.id;

  return (
    <div style={{ position: "relative" }}>
      {showGuides && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap,
            pointerEvents: "none",
            zIndex: 0,
          }}
        >
          {Array.from({ length: columns }, (_, i) => (
            <div key={i} style={{ background: "var(--jf-accent-soft)", border: "1px solid var(--jf-accent-soft)", borderRadius: 3 }} />
          ))}
        </div>
      )}

      <div
        ref={gridRef}
        onDragOver={onDragOver}
        onDragLeave={() => setGhost(null)}
        onDrop={onDrop}
        style={{
          position: "relative",
          zIndex: 1,
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: rowMin ? `minmax(${rowMin}px, auto)` : undefined,
          gap,
          minHeight: children.length === 0 ? 120 : undefined,
        }}
      >
        {ghost && (
          <div
            aria-hidden="true"
            style={{
              gridColumn: `${ghost.col} / span ${ghost.span}`,
              gridRow: `${Math.max(1, ghost.row)} / span ${ghost.rowSpan}`,
              border: "2px solid var(--jf-accent)",
              background: "rgba(59,130,246,.12)",
              borderRadius: 6,
              pointerEvents: "none",
              zIndex: 5,
            }}
          />
        )}

        {children.map((child, index) => {
          const placement = placementOf(child, columns);
          const isSelected = selectedId === child.id;
          return (
            <div
              key={child.id}
              data-grid-item={child.id}
              data-jf-layout-item={child.id}
              style={{
                position: "relative",
                minWidth: 0,
                gridColumn: `${placement.col} / span ${placement.span}`,
                gridRow: placement.row > 0
                  ? `${placement.row} / span ${placement.rowSpan}`
                  : `auto / span ${placement.rowSpan}`,
              }}
            >
              {renderChild(child, index)}
              <ResizeHandle side="start" onPointerDown={(e) => startDrag(child, "start", e)} active={isSelected} />
              <ResizeHandle side="end" onPointerDown={(e) => startDrag(child, "end", e)} active={isSelected} />
              <MoveHandle
                placement={placement}
                columns={columns}
                onPointerDown={(e) => startDrag(child, "move", e)}
              />
            </div>
          );
        })}
      </div>

      {children.length === 0 && (
        <p style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", margin: 0, color: "var(--jf-text-3)", fontSize: "0.8rem", pointerEvents: "none", zIndex: 2 }}>
          {t("builder.grid.dragBlockOntoGrid")}
        </p>
      )}
    </div>
  );
}

function ResizeHandle({
  side,
  active,
  onPointerDown,
}: {
  side: "start" | "end";
  active: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const { t } = useT();
  const [hover, setHover] = useState(false);
  return (
    <div
      role="presentation"
      title={side === "start" ? t("builder.grid.dragChangeStartColumn") : t("builder.grid.dragChangeWidth")}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side === "start" ? "left" : "right"]: -5,
        width: 10,
        cursor: "col-resize",
        zIndex: 6,
        touchAction: "none",
        background: hover || active ? "var(--jf-accent)" : "transparent",
        opacity: hover ? 1 : active ? 0.45 : 0,
        borderRadius: 4,
        transition: "opacity .12s",
      }}
    />
  );
}

/** The badge doubles as the in-grid drag handle and as a readout of the placement. */
function MoveHandle({
  placement,
  columns,
  onPointerDown,
}: {
  placement: BlockPlacement;
  columns: number;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      title={t("builder.grid.dragMoveOnGrid")}
      style={{
        position: "absolute",
        top: -9,
        right: 4,
        zIndex: 7,
        border: "1px solid var(--jf-border-strong)",
        background: "var(--jf-accent-soft)",
        color: "var(--jf-accent-hover)",
        borderRadius: 999,
        padding: "0 0.4rem",
        fontSize: "0.62rem",
        fontWeight: 700,
        lineHeight: "1.15rem",
        cursor: "grab",
        touchAction: "none",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      ⠿ {placement.col}–{Math.min(columns, placement.col + placement.span - 1)}
    </button>
  );
}
