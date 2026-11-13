import { useT } from "../../i18n/I18nProvider";
import { useState } from "react";
import { useBuilderDrag, dropTargetMatches, type DropTarget } from "./DragContext";
import type { BlockCatalogEntry } from "./types";

interface DropZoneProps {
  parentId: string | null;
  parentType: string | null;
  index: number;
  catalog: Map<string, BlockCatalogEntry>;
  label?: string;
  compact?: boolean;
  /** Keep the target visible when nothing is being dragged (empty columns). */
  alwaysShow?: boolean;
  inline?: boolean;
}

export default function DropZone({
  parentId,
  parentType,
  index,
  catalog,
  label,
  compact = false,
  alwaysShow = false,
  inline = false,
}: DropZoneProps) {
  const { t } = useT();
  const { dragging, dragPayload, activeDropTarget, handleLibraryDrop, verdictFor, rejectionText, typeLabel } = useBuilderDrag();
  const [dragOver, setDragOver] = useState(false);

  const target: DropTarget = { parentId, parentType, index };
  const verdict = dragging ? verdictFor(target) : null;
  const canDrop = Boolean(verdict?.ok);
  /** Pointer drags (moves, touch inserts) report their target; native drags report hover. */
  const isActive = dropTargetMatches(activeDropTarget, target) || dragOver;
  const highlighted = isActive && canDrop;
  const refused = isActive && dragging && verdict !== null && !verdict.ok;
  const isMoving = dragPayload.blockId !== null;

  function onDragOver(e: React.DragEvent) {
    if (isMoving || !dragPayload.type) return;
    e.stopPropagation();
    setDragOver(true);
    if (!canDrop) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragEnter(e: React.DragEvent) {
    if (isMoving || !dragPayload.type) return;
    e.stopPropagation();
    if (canDrop) e.preventDefault();
  }

  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }

  function onDrop(e: React.DragEvent) {
    setDragOver(false);
    handleLibraryDrop(parentId, parentType, index, e);
  }

  const blockName = dragPayload.type ? typeLabel(dragPayload.type) : "";
  const text = refused && verdict && !verdict.ok
    ? rejectionText(verdict.reason, target)
    : highlighted
      ? t(isMoving ? "builder.drop.releaseToMove" : "builder.drop.releaseToInsert", { block: blockName })
      : compact
        ? t("ui.dropZone.dropHere")
        : (label ?? t("ui.dropZone.dropBlockHere"));

  if (!dragging && !alwaysShow) return null;

  return (
    <div
      data-drop-zone="true"
      data-builder-chrome="true"
      data-drop-state={refused ? "refused" : highlighted ? "active" : dragging && !canDrop ? "unavailable" : "available"}
      data-parent-id={parentId ?? "root"}
      data-parent-type={parentType ?? "root"}
      data-index={index}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        padding: inline ? "0.15rem 0.4rem" : compact ? "0.2rem 0" : "0.75rem",
        margin: inline ? "0 0.15rem" : compact ? "0.15rem 0" : "0.35rem 0",
        minHeight: compact ? 24 : alwaysShow ? 56 : 40,
        minWidth: inline ? (compact ? 72 : 120) : undefined,
        flex: inline ? "1 1 auto" : undefined,
        border: `2px dashed ${refused ? "var(--jf-danger)" : highlighted ? "var(--jf-accent)" : "var(--jf-border-strong)"}`,
        borderRadius: 6,
        background: refused ? "var(--jf-danger-soft)" : highlighted ? "var(--jf-accent-soft)" : "var(--jf-surface-2)",
        color: refused ? "var(--jf-danger)" : highlighted ? "var(--jf-accent-hover)" : "var(--jf-text-3)",
        opacity: dragging && !canDrop && !refused ? 0.45 : 1,
        cursor: dragging && !canDrop ? "not-allowed" : undefined,
        fontSize: "0.7rem",
        fontWeight: 600,
        textAlign: "center",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background .12s, border-color .12s",
        touchAction: "none",
      }}
    >
      {text}
    </div>
  );
}
