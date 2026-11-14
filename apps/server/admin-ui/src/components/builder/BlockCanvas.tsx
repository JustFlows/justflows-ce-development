import { useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import type { BlockNode, BlockCatalogEntry } from "./types";
import { BlockPreview, useThemePreviewStylesheet } from "./BlockPreview";
import { createBlock } from "./block-defaults";
import { insertBlock, moveBlock, removeBlock, updateBlockProps } from "./block-tree";
import DropZone from "./DropZone";
import { useBuilderDrag } from "./DragContext";
import { useBlockMoveHandle } from "./useBlockMoveHandle";
import GridEditor from "./GridEditor";
import { GRID_BLOCK_TYPE, gridColumns, nextRow } from "./grid";
import { compactBlockPlacement, isBlockLocked, parseBlockPlacement } from "@justflows/blocks";
import { anchorFor, isExtendClick, useBuilderSelection } from "./selection-context";
import { inertPreviewHandlers } from "./inert-preview";

const iconBtn: React.CSSProperties = {
  background: "var(--jf-surface-3)",
  border: "none",
  borderRadius: 4,
  padding: "0.15rem 0.4rem",
  cursor: "pointer",
  fontSize: "0.75rem",
  color: "var(--jf-text-3)",
};

interface PageCanvasProps {
  blocks: BlockNode[];
  catalog: Map<string, BlockCatalogEntry>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (blocks: BlockNode[]) => void;
  rootParentId?: string | null;
  rootParentType?: string | null;
  compact?: boolean;
  showEmptyState?: boolean;
  showAddSlot?: boolean;
  addLabel?: string;
  emptyLabel?: string;
  /** A content fragment (mega-menu region, reusable snippet) isn't a page — its root should offer
   * every allowed block directly, not force a Section wrapper first the way a real page's top level does. */
  rootQuickAll?: boolean;
}

export function PageCanvas({
  blocks,
  catalog,
  selectedId,
  onSelect,
  onChange,
  rootParentId = null,
  rootParentType = null,
  compact = false,
  showEmptyState = true,
  showAddSlot = true,
  addLabel,
  emptyLabel,
  rootQuickAll = false,
}: PageCanvasProps) {
  const { t } = useT();
  const { dragging } = useBuilderDrag();
  const inline = compact;
  useThemePreviewStylesheet();

  return (
    <div
      {...inertPreviewHandlers}
      style={{
        minHeight: !compact && blocks.length === 0 ? 320 : undefined,
        width: compact ? "100%" : undefined,
      }}
    >
      {blocks.length === 0 && showEmptyState && !dragging && !rootQuickAll && (
        <div
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            border: "2px dashed var(--jf-border-strong)",
            borderRadius: 10,
            color: "var(--jf-text-3)",
            marginBottom: "0.75rem",
          }}
        >
          <div style={{ fontSize: "2rem", marginBottom: "0.5rem", opacity: 0.5 }}>▭</div>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>{t("builder.canvas.dragSectionHere")}</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
            {t("builder.canvas.orPickFromLibrary")}
          </p>
        </div>
      )}

      {blocks.length === 0 && (dragging || compact) && (
        <DropZone
          parentId={rootParentId}
          parentType={rootParentType}
          index={0}
          catalog={catalog}
          label={emptyLabel ?? t("builder.canvas.dropSectionHere")}
          alwaysShow={compact}
          compact={compact}
          inline={inline}
        />
      )}

      {blocks.map((block, i) => (
        <div key={block.id}>
          <DropZone
            parentId={rootParentId}
            parentType={rootParentType}
            index={i}
            catalog={catalog}
            compact
            inline={inline}
          />
          <BlockRow
            block={block}
            blocks={blocks}
            catalog={catalog}
            selectedId={selectedId}
            onSelect={onSelect}
            onRootChange={onChange}
            index={i}
            total={blocks.length}
            depth={0}
          />
        </div>
      ))}

      {blocks.length > 0 && (
        <DropZone
          parentId={rootParentId}
          parentType={rootParentType}
          index={blocks.length}
          catalog={catalog}
          compact
          inline={inline}
          label={t("builder.canvas.dropAtEnd")}
        />
      )}

      {showAddSlot && (
        <AddBlockSlot
          label={addLabel ?? (rootQuickAll ? t("builder.canvas.addBlock") : t("builder.canvas.addSection"))}
          onPick={(type) => {
            const block = createBlock(type, t);
            onChange([...blocks, block]);
            onSelect(block.id);
          }}
          catalog={catalog}
          parentType={rootParentType}
          quickAll={rootQuickAll}
        />
      )}
    </div>
  );
}

function BlockRow({
  block,
  blocks,
  catalog,
  selectedId,
  onSelect,
  onRootChange,
  index,
  total,
  depth,
  parentBlocks,
  onParentChange,
  parentType = null,
}: {
  block: BlockNode;
  blocks: BlockNode[];
  catalog: Map<string, BlockCatalogEntry>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRootChange: (blocks: BlockNode[]) => void;
  index: number;
  total: number;
  depth: number;
  parentBlocks?: BlockNode[];
  onParentChange?: (blocks: BlockNode[]) => void;
  parentType?: string | null;
}) {
  const { t } = useT();
  const meta = catalog.get(block.type);
  const selection = useBuilderSelection();
  const inMultiSelection = Boolean(selection && selection.selectedIds.size > 1 && selection.selectedIds.has(block.id));
  const isSelected = selectedId === block.id || inMultiSelection;
  const hasChildren = meta?.supportsChildren ?? false;
  const { dragPayload } = useBuilderDrag();
  const moveLocked = isBlockLocked(block, "move");
  const removeLocked = subtreeHasLock(block, "remove");
  const locked = moveLocked || removeLocked || isBlockLocked(block, "edit");
  const { onPointerDown } = useBlockMoveHandle(block.id, block.type, moveLocked);
  const isBeingMoved = dragPayload.blockId === block.id;
  const children = block.children ?? [];

  const move = (dir: -1 | 1) => {
    const list = parentBlocks ?? blocks;
    const change = parentBlocks ? onParentChange! : onRootChange;
    change(moveBlock(list, block.id, dir));
  };

  const remove = () => {
    const list = parentBlocks ?? blocks;
    const change = parentBlocks ? onParentChange! : onRootChange;
    change(removeBlock(list, block.id));
    if (selectedId === block.id) onSelect(null);
  };

  const updateChildren = (nextChildren: BlockNode[]) => {
    const list = parentBlocks ?? blocks;
    const change = parentBlocks ? onParentChange! : onRootChange;
    change(list.map((b) => (b.id === block.id ? { ...b, children: nextChildren } : b)));
  };

  const updateProps = (id: string, props: Record<string, unknown>) => {
    const list = parentBlocks ?? blocks;
    const change = parentBlocks ? onParentChange! : onRootChange;
    change(updateBlockProps(list, id, props));
  };

  return (
    <div
      className="jf-canvas-block"
      data-block-id={block.id}
      data-selected={isSelected ? "true" : undefined}
      style={{
        marginBottom: depth === 0 ? "0.75rem" : "0.4rem",
        border: `2px solid ${isSelected ? "var(--jf-accent)" : "transparent"}`,
        borderRadius: depth === 0 ? 10 : 6,
        background: isSelected ? "var(--jf-accent-soft)" : "transparent",
        opacity: isBeingMoved ? 0.45 : 1,
        transition: "border-color .12s, opacity .12s",
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (selection && isExtendClick(e) && selection.extend(block.id, e)) return;
        onSelect(isSelected && !inMultiSelection ? null : block.id);
      }}
      onContextMenu={
        selection
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              selection.openMenu(block.id, { x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      <div
        data-builder-chrome="true"
        onPointerDown={onPointerDown}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: depth === 0 ? "0.4rem 0.6rem 0" : "0.25rem 0.35rem 0",
          cursor: moveLocked ? "default" : "grab",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        <span
          title={t("builder.canvas.dragToMove")}
          aria-hidden="true"
          style={{
            color: "var(--jf-text-3)",
            fontSize: "0.85rem",
            padding: "0 0.15rem",
            userSelect: "none",
            flexShrink: 0,
          }}
        >
          ⠿
        </span>
        <span
          style={{
            fontSize: "0.65rem",
            fontWeight: 700,
            color: "var(--jf-text-3)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {meta?.icon} {block.editor?.label || meta?.title || block.type}
        </span>
        {locked && (
          <span className="jf-canvas-block__lock" title={t("builder.navigator.badge.locked")}>
            <span aria-hidden="true">🔒</span>
            <span className="jf-sr-only">{t("builder.navigator.badge.locked")}</span>
          </span>
        )}
        <div
          style={{ marginLeft: "auto", display: "flex", gap: "0.2rem" }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label={t("builder.canvas.moveBlockUp")}
            onClick={() => move(-1)}
            disabled={index === 0 || moveLocked}
            style={iconBtn}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={t("builder.canvas.moveBlockDown")}
            onClick={() => move(1)}
            disabled={index === total - 1 || moveLocked}
            style={iconBtn}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label={t("builder.canvas.removeBlock")}
            title={removeLocked ? t("builder.actions.blocked.lockedRemove") : undefined}
            onClick={remove}
            disabled={removeLocked}
            style={{ ...iconBtn, color: "var(--jf-danger)" }}
          >
            ✕
          </button>
          {selection && (
            <button
              type="button"
              aria-label={t("builder.actions.more", { block: block.editor?.label || meta?.title || block.type })}
              aria-haspopup="menu"
              onClick={(e) => selection.openMenu(block.id, anchorFor(e.currentTarget))}
              style={iconBtn}
            >
              ⋯
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: depth === 0 ? "0.5rem 0.6rem 0.6rem" : "0.25rem 0.35rem 0.35rem" }}>
        <BlockPreview
          block={block}
          depth={depth}
          selectedId={selectedId}
          onSelect={onSelect}
          onUpdateProps={updateProps}
          renderChildren={
            hasChildren
              ? (_childList, childDepth) => {
                  const isColumns = block.type === "core.columns";
                  const isGrid = block.type === GRID_BLOCK_TYPE;

                  const childRow = (child: BlockNode, ci: number) => (
                    <BlockRow
                      block={child}
                      blocks={blocks}
                      catalog={catalog}
                      selectedId={selectedId}
                      onSelect={onSelect}
                      onRootChange={onRootChange}
                      index={ci}
                      total={children.length}
                      depth={childDepth}
                      parentBlocks={children}
                      onParentChange={updateChildren}
                      parentType={block.type}
                    />
                  );

                  if (isGrid) {
                    const columns = gridColumns(block);
                    return (
                      <div>
                        <GridEditor
                          block={block}
                          children={children}
                          onChildrenChange={updateChildren}
                          onSelect={onSelect}
                          selectedId={selectedId}
                          renderChild={childRow}
                        />
                        <AddBlockSlot
                          label={t("builder.canvas.addBlock")}
                          onPick={(type) => {
                            const created = createBlock(type, t);
                            const placement = parseBlockPlacement(
                              { col: 1, span: columns, row: nextRow(children, columns) },
                              columns,
                            );
                            const layout = compactBlockPlacement(placement, columns);
                            updateChildren([
                              ...children,
                              layout
                                ? { ...created, props: { ...created.props, layout } }
                                : created,
                            ]);
                            onSelect(created.id);
                          }}
                          catalog={catalog}
                          parentType={block.type}
                        />
                      </div>
                    );
                  }

                  const items = children.map((child, ci) => (
                    <div key={child.id} style={isColumns ? { minWidth: 0 } : undefined}>
                      {!isColumns && (
                        <DropZone
                          parentId={block.id}
                          parentType={block.type}
                          index={ci}
                          catalog={catalog}
                          compact
                        />
                      )}
                      {childRow(child, ci)}
                    </div>
                  ));

                  if (isColumns) return <>{items}</>;

                  return (
                    <div style={{ minHeight: children.length === 0 ? 56 : undefined }}>
                      {children.length === 0 && (
                        <DropZone
                          parentId={block.id}
                          parentType={block.type}
                          index={0}
                          catalog={catalog}
                          label={t("builder.canvas.dropContentHere")}
                          alwaysShow
                        />
                      )}
                      {items}
                      {children.length > 0 && (
                        <DropZone
                          parentId={block.id}
                          parentType={block.type}
                          index={children.length}
                          catalog={catalog}
                          compact
                        />
                      )}
                      <AddBlockSlot
                        label={t("builder.canvas.addBlock")}
                        onPick={(type) => {
                          const created = createBlock(type, t);
                          onRootChange(insertBlock(blocks, block.id, children.length, created));
                          onSelect(created.id);
                        }}
                        catalog={catalog}
                        parentType={block.type}
                        allowedChildTypes={meta?.allowedChildTypes}
                      />
                    </div>
                  );
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}

function AddBlockSlot({
  label,
  onPick,
  catalog,
  parentType,
  allowedChildTypes,
  quickAll = false,
}: {
  label: string;
  onPick: (type: string) => void;
  catalog: Map<string, BlockCatalogEntry>;
  parentType: string | null;
  allowedChildTypes?: string[];
  /** Offer the full (filtered) list even at the canvas root, instead of only section-shaped
   * blocks. A whole page should be built from sections; a content fragment (a mega-menu region,
   * a reusable snippet) is not a page and should not force one on the way to a first block. */
  quickAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const entries = [...catalog.values()].filter((b) => {
    if (b.type === "core.column") return parentType === "core.columns";
    if (allowedChildTypes?.length) return allowedChildTypes.includes(b.type);
    if (parentType === "core.columns") return false;
    if (parentType === "core.column") return b.type !== "core.column" && b.type !== "core.columns";
    if (!parentType) return b.type !== "core.column";
    return b.type !== "core.column";
  });

  const quick =
    parentType || quickAll
      ? entries.slice(0, 12)
      : entries.filter((b) => b.category === "sections" || b.type === "core.section").slice(0, 6);

  return (
    <div style={{ position: "relative", marginTop: "0.35rem" }}>
      <button
        type="button"
        onClick={(e) => {
          // This slot sits inside its parent block's own clickable row (so the row can be
          // selected by clicking its content) — without this, opening the picker also toggles
          // the *parent* block's selection via bubbling, fighting whatever gets picked next.
          e.stopPropagation();
          setOpen(!open);
        }}
        style={{
          width: "100%",
          padding: "0.45rem",
          border: "1px dashed var(--jf-border-strong)",
          borderRadius: 6,
          background: "var(--jf-surface-2)",
          color: "var(--jf-text-3)",
          fontSize: "0.75rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            right: 0,
            zIndex: 40,
            background: "var(--jf-surface)",
            color: "var(--jf-text)",
            border: "1px solid var(--jf-border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.18)",
            padding: "0.4rem",
            marginBottom: "0.25rem",
            maxHeight: 280,
            overflow: "auto",
          }}
        >
          {quick.map((b) => (
            <button
              key={b.type}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPick(b.type);
                setOpen(false);
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--jf-surface-2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
              }}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                gap: "0.5rem",
                padding: "0.4rem 0.5rem",
                border: "none",
                background: "none",
                color: "var(--jf-text)",
                cursor: "pointer",
                borderRadius: 4,
                fontSize: "0.78rem",
                textAlign: "left",
              }}
            >
              <span aria-hidden="true">{b.icon}</span> {b.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Whether the block or anything inside it carries a lock flag. */
function subtreeHasLock(block: BlockNode, flag: "move" | "remove" | "edit"): boolean {
  if (isBlockLocked(block, flag)) return true;
  return (block.children ?? []).some((child) => subtreeHasLock(child, flag));
}
