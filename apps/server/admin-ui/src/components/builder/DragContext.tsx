import { useT } from "../../i18n/I18nProvider";
import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { BlockCatalogEntry, BlockNode } from "./types";
import { createBlock } from "./block-defaults";
import { extractBlock, findBlockPath, insertBlock, moveBlockTo } from "./block-tree";
import { DND_BLOCK_TYPE, HEADER_SLOT_PARENT_TYPE } from "./dnd";
import { evaluateDrop, type DropPlacement, type DropRegion, type DropRejection, type DropVerdict } from "./drop-rules";
import { HEADER_SELECTED_ID } from "../../lib/page-header";

export interface DragPayload {
  type: string | null;
  blockId: string | null;
}

export interface DropTarget {
  parentId: string | null;
  parentType: string | null;
  index: number;
}

/** The last drop result, shown on the canvas and announced to screen readers. */
export interface DropStatus {
  tone: "ok" | "error";
  text: string;
}

interface BuilderDragContextValue {
  dragging: boolean;
  dragPayload: DragPayload;
  activeDropTarget: DropTarget | null;
  status: DropStatus | null;
  onDragStartType: (type: string) => void;
  onDragEnd: () => void;
  startPointerMove: (blockId: string, type: string) => void;
  /** Start dragging a new block from the library with a pointer (touch, pen). */
  startLibraryPointerDrag: (type: string) => void;
  commitPointerMove: () => void;
  /** Abandon the current drag without changing the document. */
  cancelDrag: () => void;
  setDropTarget: (target: DropTarget | null) => void;
  handleLibraryDrop: (parentId: string | null, parentType: string | null, index: number, e: React.DragEvent) => boolean;
  /** Whether the current payload may land at a target, and why not. */
  verdictFor: (target: DropTarget) => DropVerdict | null;
  /** Human-readable reason for a refused drop of `type` (defaults to the current payload). */
  rejectionText: (reason: DropRejection, target: DropTarget, type?: string) => string;
  /** Display name of a block type. */
  typeLabel: (type: string) => string;
  /** Show and announce a short result message (drops, keyboard moves). */
  announce: (status: DropStatus) => void;
}

const BuilderDragContext = createContext<BuilderDragContextValue | null>(null);

export function useBuilderDrag() {
  const ctx = useContext(BuilderDragContext);
  if (!ctx) throw new Error("useBuilderDrag must be used within BuilderDragProvider");
  return ctx;
}

/**
 * What a canvas row needs from dragging (justflows-ce#308): the current
 * payload and the actions that start, aim, commit or cancel a move. The
 * actions never change identity and the value only changes when a drag
 * starts or ends, so editing one block or hovering drop zones does not
 * redraw every row.
 */
export interface BuilderRowDrag {
  dragPayload: DragPayload;
  startPointerMove: (blockId: string, type: string) => void;
  commitPointerMove: () => void;
  cancelDrag: () => void;
  setDropTarget: (target: DropTarget | null) => void;
}

const BuilderRowDragContext = createContext<BuilderRowDrag | null>(null);

export function useBuilderRowDrag(): BuilderRowDrag {
  const ctx = useContext(BuilderRowDragContext);
  if (!ctx) throw new Error("useBuilderRowDrag must be used within BuilderDragProvider");
  return ctx;
}

interface BuilderDragProviderProps {
  blocks: BlockNode[];
  headerBlocks?: BlockNode[];
  catalog: Map<string, BlockCatalogEntry>;
  onChange: (blocks: BlockNode[]) => void;
  onHeaderBlocksChange?: (blocks: BlockNode[]) => void;
  onSelect: (id: string | null) => void;
  children: ReactNode;
}

const STATUS_MS = 4000;

export function BuilderDragProvider({
  blocks,
  headerBlocks = [],
  catalog,
  onChange,
  onHeaderBlocksChange,
  onSelect,
  children,
}: BuilderDragProviderProps) {
  const { t } = useT();
  const payloadRef = useRef<DragPayload>({ type: null, blockId: null });
  const dropTargetRef = useRef<DropTarget | null>(null);
  const statusTimer = useRef<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [dragPayload, setDragPayload] = useState<DragPayload>({ type: null, blockId: null });
  const [activeDropTarget, setActiveDropTarget] = useState<DropTarget | null>(null);
  const [status, setStatus] = useState<DropStatus | null>(null);

  useEffect(() => () => window.clearTimeout(statusTimer.current), []);

  const announce = useCallback((next: DropStatus) => {
    setStatus(next);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), STATUS_MS);
  }, []);

  const typeLabel = useCallback((type: string) => catalog.get(type)?.title ?? type, [catalog]);

  const reset = useCallback(() => {
    payloadRef.current = { type: null, blockId: null };
    dropTargetRef.current = null;
    setDragPayload({ type: null, blockId: null });
    setActiveDropTarget(null);
    setDragging(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  const syncPayload = useCallback((next: DragPayload) => {
    payloadRef.current = next;
    setDragPayload(next);
    setDragging(next.type !== null);
  }, []);

  const onDragStartType = useCallback((type: string) => {
    syncPayload({ type, blockId: null });
  }, [syncPayload]);

  const onDragEnd = useCallback(() => {
    reset();
  }, [reset]);

  const startPointerMove = useCallback((blockId: string, type: string) => {
    syncPayload({ type, blockId });
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
  }, [syncPayload]);

  const startLibraryPointerDrag = useCallback((type: string) => {
    syncPayload({ type, blockId: null });
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
  }, [syncPayload]);

  const setDropTarget = useCallback((target: DropTarget | null) => {
    dropTargetRef.current = target;
    setActiveDropTarget(target);
  }, []);

  /** The canvas marks the header slot with its own id and type; to the rules it is the header region's root. */
  const placementOf = useCallback(
    (target: DropTarget): DropPlacement => {
      const inHeader =
        target.parentId === HEADER_SELECTED_ID || Boolean(target.parentId && findBlockPath(headerBlocks, target.parentId));
      return {
        region: inHeader ? "header" : "body",
        parentId: target.parentId === HEADER_SELECTED_ID ? null : target.parentId,
        parentType: target.parentType === HEADER_SLOT_PARENT_TYPE ? null : target.parentType,
        index: target.index,
      };
    },
    [headerBlocks],
  );

  const regions: ReadonlySet<DropRegion> = new Set<DropRegion>(onHeaderBlocksChange ? ["body", "header"] : ["body"]);

  const evaluate = useCallback(
    (payload: DragPayload, target: DropTarget): DropVerdict | null => {
      if (!payload.type) return null;
      return evaluateDrop({
        source: { type: payload.type, blockId: payload.blockId },
        target: placementOf(target),
        blocks,
        headerBlocks,
        catalog,
        regions,
      });
    },
    /** `regions` only depends on whether a header handler exists. */
    [blocks, headerBlocks, catalog, placementOf, Boolean(onHeaderBlocksChange)],
  );

  const verdictFor = useCallback((target: DropTarget) => evaluate(payloadRef.current, target), [evaluate, dragPayload]);

  const rejectionText = useCallback(
    (reason: DropRejection, target: DropTarget, type?: string) => {
      const child = typeLabel(type ?? payloadRef.current.type ?? "");
      if (reason === "nesting") {
        const placement = placementOf(target);
        return placement.parentType
          ? t("builder.drop.rejectNesting", { child, parent: typeLabel(placement.parentType) })
          : t("builder.drop.rejectNestingRoot", { child });
      }
      return t(`builder.drop.reject.${reason}`);
    },
    [placementOf, t, typeLabel],
  );

  /** Apply a validated move. Body moves are one change, so one undo step. */
  const applyMove = useCallback(
    (blockId: string, placement: DropPlacement) => {
      const fromHeader = Boolean(findBlockPath(headerBlocks, blockId));
      const toHeader = placement.region === "header";
      if (fromHeader && toHeader && onHeaderBlocksChange) {
        onHeaderBlocksChange(moveBlockTo(headerBlocks, blockId, placement.parentId, placement.index));
      } else if (!fromHeader && !toHeader) {
        onChange(moveBlockTo(blocks, blockId, placement.parentId, placement.index));
      } else if (fromHeader && !toHeader && onHeaderBlocksChange) {
        const extracted = extractBlock(headerBlocks, blockId);
        if (!extracted) return false;
        onHeaderBlocksChange(extracted.blocks);
        onChange(insertBlock(blocks, placement.parentId, placement.index, extracted.node));
      } else if (!fromHeader && toHeader && onHeaderBlocksChange) {
        const extracted = extractBlock(blocks, blockId);
        if (!extracted) return false;
        onChange(extracted.blocks);
        onHeaderBlocksChange(insertBlock(headerBlocks, placement.parentId, placement.index, extracted.node));
      } else {
        return false;
      }
      return true;
    },
    [blocks, headerBlocks, onChange, onHeaderBlocksChange],
  );

  const applyInsert = useCallback(
    (type: string, placement: DropPlacement) => {
      const block = createBlock(type, t);
      if (placement.region === "header") {
        if (!onHeaderBlocksChange) return null;
        onHeaderBlocksChange(insertBlock(headerBlocks, placement.parentId, placement.index, block));
      } else {
        onChange(insertBlock(blocks, placement.parentId, placement.index, block));
      }
      return block;
    },
    [blocks, headerBlocks, onChange, onHeaderBlocksChange, t],
  );

  const commitPointerMove = useCallback(() => {
    const payload = payloadRef.current;
    const target = dropTargetRef.current;
    reset();
    if (!payload.type) return;
    if (!target) {
      announce({ tone: "error", text: t("builder.drop.noTarget") });
      return;
    }
    const verdict = evaluate(payload, target);
    if (!verdict || !verdict.ok) {
      announce({ tone: "error", text: rejectionText(verdict && !verdict.ok ? verdict.reason : "nesting", target, payload.type) });
      return;
    }
    const placement = placementOf(target);
    if (payload.blockId) {
      if (!applyMove(payload.blockId, placement)) return;
      onSelect(payload.blockId);
      announce({ tone: "ok", text: t("builder.drop.moved", { block: typeLabel(payload.type) }) });
      return;
    }
    const block = applyInsert(payload.type, placement);
    if (!block) return;
    onSelect(block.id);
    announce({ tone: "ok", text: t("builder.drop.inserted", { block: typeLabel(payload.type) }) });
  }, [announce, applyInsert, applyMove, evaluate, onSelect, placementOf, rejectionText, reset, t, typeLabel]);

  const cancelDrag = useCallback(() => {
    const wasDragging = payloadRef.current.type !== null;
    reset();
    if (wasDragging) announce({ tone: "ok", text: t("builder.drop.cancelled") });
  }, [announce, reset, t]);

  const handleLibraryDrop = useCallback(
    (parentId: string | null, parentType: string | null, index: number, e: React.DragEvent): boolean => {
      e.preventDefault();
      e.stopPropagation();

      const type = e.dataTransfer.getData(DND_BLOCK_TYPE) || payloadRef.current.type;
      if (!type || payloadRef.current.blockId) return false;
      const target = { parentId, parentType, index };
      const verdict = evaluate({ type, blockId: null }, target);
      if (!verdict?.ok) {
        reset();
        announce({ tone: "error", text: rejectionText(verdict && !verdict.ok ? verdict.reason : "nesting", target, type) });
        return false;
      }
      const block = applyInsert(type, placementOf(target));
      reset();
      if (!block) return false;
      onSelect(block.id);
      announce({ tone: "ok", text: t("builder.drop.inserted", { block: typeLabel(type) }) });
      return true;
    },
    [announce, applyInsert, evaluate, onSelect, placementOf, rejectionText, reset, t, typeLabel],
  );

  const rowActionsRef = useRef({ startPointerMove, commitPointerMove, cancelDrag, setDropTarget });
  rowActionsRef.current = { startPointerMove, commitPointerMove, cancelDrag, setDropTarget };
  const rowActions = useMemo(
    () => ({
      startPointerMove: (blockId: string, type: string) => rowActionsRef.current.startPointerMove(blockId, type),
      commitPointerMove: () => rowActionsRef.current.commitPointerMove(),
      cancelDrag: () => rowActionsRef.current.cancelDrag(),
      setDropTarget: (target: DropTarget | null) => rowActionsRef.current.setDropTarget(target),
    }),
    [],
  );
  const rowDrag = useMemo<BuilderRowDrag>(() => ({ dragPayload, ...rowActions }), [dragPayload, rowActions]);

  return (
    <BuilderRowDragContext.Provider value={rowDrag}>
    <BuilderDragContext.Provider
      value={{
        dragging,
        dragPayload,
        activeDropTarget,
        status,
        onDragStartType,
        onDragEnd,
        startPointerMove,
        startLibraryPointerDrag,
        commitPointerMove,
        cancelDrag,
        setDropTarget,
        handleLibraryDrop,
        verdictFor,
        rejectionText,
        typeLabel,
        announce,
      }}
    >
      {children}
      <div
        className={`jf-drop-status${status ? ` jf-drop-status--${status.tone}` : ""}`}
        aria-live="polite"
        aria-atomic="true"
        data-builder-chrome="true"
      >
        {status?.text ?? ""}
      </div>
    </BuilderDragContext.Provider>
    </BuilderRowDragContext.Provider>
  );
}

export function dropTargetMatches(a: DropTarget | null, b: DropTarget): boolean {
  if (!a) return false;
  return a.parentId === b.parentId && a.index === b.index;
}

