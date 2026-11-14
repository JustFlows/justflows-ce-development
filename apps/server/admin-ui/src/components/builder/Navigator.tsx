// SPDX-License-Identifier: MIT
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import { moveBlockTo, updateBlockTree } from "./block-tree";
import { useBuilderDrag } from "./DragContext";
import DropZone from "./DropZone";
import {
  ancestorIds,
  endZonesAfter,
  flattenTree,
  moveDestinations,
  planTreeMove,
  treeBadges,
  type TreeMove,
  type TreeRow,
} from "./tree-ops";
import type { BlockCatalogEntry, BlockNode } from "./types";
import { useBlockMoveHandle } from "./useBlockMoveHandle";
import { isBlockLocked } from "@justflows/blocks";
import { anchorFor, isExtendClick, useBuilderSelection } from "./selection-context";

/** Rows rendered above and below the visible window in a long tree. */
const OVERSCAN = 12;
/** Fixed row height in pixels, which lets long trees render only what is visible. */
export const NAVIGATOR_ROW_HEIGHT = 30;
/** Trees with more rows than this render windowed. */
export const NAVIGATOR_WINDOW_THRESHOLD = 150;

interface NavigatorProps {
  blocks: BlockNode[];
  catalog: Map<string, BlockCatalogEntry>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Apply a structural change; one call is one undo step. */
  onChange: (blocks: BlockNode[]) => void;
}

/**
 * Layers panel (justflows-ce#296): the block document as an accessible tree.
 * Selection is shared with the canvas; moves (keyboard, "Move to…", drag)
 * use the same rules as canvas drops and keep block ids.
 */
export default function Navigator({ blocks, catalog, selectedId, onSelect, onChange }: NavigatorProps) {
  const { t } = useT();
  const { dragging, announce, rejectionText, typeLabel } = useBuilderDrag();
  const selection = useBuilderSelection();
  const isSelected = (id: string) => (selection ? selection.selectedIds.has(id) : id === selectedId);
  const treeId = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  /** A focus move waiting for the next frame; replaced or cancelled so it can never steal focus later. */
  const pendingFocus = useRef(0);
  const renamingRef = useRef<string | null>(null);
  useEffect(() => () => cancelAnimationFrame(pendingFocus.current), []);

  const label = (node: BlockNode) => node.editor?.label || typeLabel(node.type);
  const rows = useMemo(() => flattenTree(blocks, expanded, query, label), [blocks, expanded, query, catalog]);
  const indexOf = useMemo(() => new Map(rows.map((row, i) => [row.node.id, i])), [rows]);
  const endZones = useMemo(() => endZonesAfter(rows), [rows]);

  /** Reveal the selection: expand its ancestors and bring its row into view. */
  useEffect(() => {
    if (!selectedId) return;
    const parents = ancestorIds(blocks, selectedId);
    if (parents.some((id) => !expanded.has(id))) {
      setExpanded((prev) => new Set([...prev, ...parents]));
      return;
    }
    setFocusedId(selectedId);
    const i = indexOf.get(selectedId);
    const el = scroller.current;
    if (i === undefined || !el) return;
    const top = i * NAVIGATOR_ROW_HEIGHT;
    if (top < el.scrollTop || top + NAVIGATOR_ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
  }, [selectedId, blocks, expanded, indexOf]);

  useEffect(() => {
    const el = scroller.current;
    if (el) setViewport(el.clientHeight || 400);
  }, []);

  const windowed = rows.length > NAVIGATOR_WINDOW_THRESHOLD;
  const first = windowed ? Math.max(0, Math.floor(scrollTop / NAVIGATOR_ROW_HEIGHT) - OVERSCAN) : 0;
  const last = windowed ? Math.min(rows.length, Math.ceil((scrollTop + viewport) / NAVIGATOR_ROW_HEIGHT) + OVERSCAN) : rows.length;
  const focusIndex = focusedId ? indexOf.get(focusedId) : undefined;
  /** The focused row always renders, so keyboard focus never lands on an unrendered row. */
  const visible = rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => (i >= first && i < last) || i === focusIndex);
  const tabStop = focusedId && indexOf.has(focusedId) ? focusedId : rows[0]?.node.id;

  function focusRow(id: string) {
    setFocusedId(id);
    cancelAnimationFrame(pendingFocus.current);
    pendingFocus.current = requestAnimationFrame(() => document.getElementById(rowDomId(treeId, id))?.focus());
  }

  function startRename(id: string) {
    cancelAnimationFrame(pendingFocus.current);
    renamingRef.current = id;
    setRenamingId(id);
  }

  function toggle(id: string, open?: boolean) {
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? !next.has(id);
      if (shouldOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function applyMove(row: TreeRow, move: TreeMove) {
    const result = planTreeMove(blocks, row.node.id, move, catalog);
    if (!result.ok) {
      announce({
        tone: "error",
        text:
          result.reason === "edge"
            ? t("builder.navigator.cannotMove")
            : rejectionText(result.reason, { parentId: null, parentType: result.parentType ?? null, index: 0 }, row.node.type),
      });
      return;
    }
    onChange(result.blocks);
    if (result.parentId) setExpanded((prev) => new Set([...prev, result.parentId!]));
    onSelect(row.node.id);
    focusRow(row.node.id);
    const parentLabel = result.parentId ? label(findNode(result.blocks, result.parentId)!) : t("builder.navigator.root");
    announce({
      tone: "ok",
      text: t("builder.navigator.moved", { block: label(row.node), parent: parentLabel, position: result.index + 1 }),
    });
  }

  function rename(id: string, value: string) {
    /** Enter and the blur that follows both commit; only the first one counts. */
    if (renamingRef.current !== id) return;
    renamingRef.current = null;
    setRenamingId(null);
    const name = value.trim();
    onChange(
      updateBlockTree(blocks, id, (node) => {
        const { label: _old, ...restEditor } = node.editor ?? {};
        const editor = name ? { ...restEditor, label: name.slice(0, 80) } : restEditor;
        const next: BlockNode = { ...node };
        if (Object.keys(editor).length > 0) next.editor = editor;
        else delete next.editor;
        return next;
      }),
    );
    focusRow(id);
  }

  function onRowKey(e: React.KeyboardEvent, row: TreeRow, i: number) {
    if (renamingId) return;
    const id = row.node.id;
    if (selection && ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")) {
      e.preventDefault();
      selection.openMenu(id, anchorFor(e.currentTarget));
      return;
    }
    /** Shift+arrows extend the selection over siblings; Ctrl/Cmd+Space toggles a row. */
    if (selection && e.shiftKey && !e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const next = rows[e.key === "ArrowDown" ? i + 1 : i - 1];
      if (!next) return;
      if (!selection.selectedIds.has(id)) onSelect(id);
      selection.extend(next.node.id, { shiftKey: true, metaKey: false, ctrlKey: false });
      focusRow(next.node.id);
      return;
    }
    if (selection && (e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      selection.extend(id, { shiftKey: false, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
      return;
    }
    /**
     * Left and right follow the tree's writing direction, so "in" and "out"
     * stay the same way round in a right-to-left interface (justflows-ce#307).
     */
    const rtl = e.currentTarget instanceof Element && getComputedStyle(e.currentTarget).direction === "rtl";
    const key = rtl && e.key === "ArrowLeft" ? "ArrowRight" : rtl && e.key === "ArrowRight" ? "ArrowLeft" : e.key;
    if (e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
      e.preventDefault();
      applyMove(row, key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowRight" ? "indent" : "outdent");
      return;
    }
    switch (key) {
      case "ArrowDown":
        e.preventDefault();
        if (rows[i + 1]) focusRow(rows[i + 1]!.node.id);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (rows[i - 1]) focusRow(rows[i - 1]!.node.id);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row.hasChildren && !row.expanded) toggle(id, true);
        else if (row.expanded && rows[i + 1]) focusRow(rows[i + 1]!.node.id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row.expanded) toggle(id, false);
        else if (row.parentId) focusRow(row.parentId);
        break;
      case "Home":
        e.preventDefault();
        if (rows[0]) focusRow(rows[0].node.id);
        break;
      case "End":
        e.preventDefault();
        if (rows.length) focusRow(rows[rows.length - 1]!.node.id);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(id);
        break;
      case "F2":
        e.preventDefault();
        startRename(id);
        break;
    }
  }

  const selected = selectedId ? findNode(blocks, selectedId) : null;
  const destinations = useMemo(
    () => (selected ? moveDestinations(blocks, selected.id, catalog) : []),
    [blocks, selected, catalog],
  );

  return (
    <div className="jf-navigator">
      <label className="jf-navigator__search">
        <span className="jf-sr-only">{t("builder.navigator.search")}</span>
        <input
          type="search"
          value={query}
          placeholder={t("builder.navigator.search")}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <p className="jf-navigator__hint">{t("builder.navigator.keysHint")}</p>
      <div
        ref={scroller}
        className="jf-navigator__scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {rows.length === 0 ? (
          <p className="jf-navigator__empty">{query ? t("builder.navigator.noMatches") : t("builder.navigator.empty")}</p>
        ) : (
          <ul
            role="tree"
            aria-label={t("builder.navigator.title")}
            aria-multiselectable={selection ? true : undefined}
            className="jf-navigator__tree"
            style={windowed ? { position: "relative", height: rows.length * NAVIGATOR_ROW_HEIGHT } : undefined}
          >
            {visible.map(({ row, i }) => (
              <Fragment key={row.node.id}>
                {dragging && !query && !windowed && (
                  <li role="none" style={{ paddingInlineStart: (row.depth - 1) * 14 }}>
                    <DropZone parentId={row.parentId} parentType={parentTypeOf(blocks, row.parentId)} index={row.position - 1} catalog={catalog} compact />
                  </li>
                )}
                <NavigatorRow
                  row={row}
                  domId={rowDomId(treeId, row.node.id)}
                  label={label(row.node)}
                  badges={treeBadges(row.node, catalog)}
                  selected={isSelected(row.node.id)}
                  tabStop={row.node.id === tabStop}
                  renaming={renamingId === row.node.id}
                  style={windowed ? { position: "absolute", insetInline: 0, top: i * NAVIGATOR_ROW_HEIGHT, height: NAVIGATOR_ROW_HEIGHT } : undefined}
                  onFocus={() => setFocusedId(row.node.id)}
                  onSelect={(e) => {
                    if (selection && isExtendClick(e) && selection.extend(row.node.id, e)) return;
                    onSelect(row.node.id);
                  }}
                  onContextMenu={
                    selection
                      ? (e) => {
                          e.preventDefault();
                          selection.openMenu(row.node.id, { x: e.clientX, y: e.clientY });
                        }
                      : undefined
                  }
                  onToggle={() => toggle(row.node.id)}
                  onKeyDown={(e) => onRowKey(e, row, i)}
                  onRename={(value) => rename(row.node.id, value)}
                  onCancelRename={() => {
                    renamingRef.current = null;
                    setRenamingId(null);
                    focusRow(row.node.id);
                  }}
                  onStartRename={() => startRename(row.node.id)}
                />
                {dragging && !query && !windowed &&
                  (endZones.get(i) ?? []).map((zone) => (
                    <li key={`end-${zone.parentId ?? "root"}`} role="none" style={{ paddingInlineStart: (zone.depth - 1) * 14 }}>
                      <DropZone parentId={zone.parentId} parentType={parentTypeOf(blocks, zone.parentId)} index={zone.index} catalog={catalog} compact />
                    </li>
                  ))}
              </Fragment>
            ))}
          </ul>
        )}
      </div>
      {selected && (
        <label className="jf-navigator__move">
          <span>{t("builder.navigator.moveTo", { block: label(selected) })}</span>
          <select
            value=""
            disabled={destinations.length === 0}
            onChange={(e) => {
              const choice = destinations[Number(e.target.value)];
              if (!choice) return;
              const target = choice.parentId ? findNode(blocks, choice.parentId) : null;
              const index = target ? (target.children ?? []).length : blocks.length;
              onChange(moveBlockTo(blocks, selected.id, choice.parentId, index));
              if (choice.parentId) setExpanded((prev) => new Set([...prev, choice.parentId!]));
              announce({
                tone: "ok",
                text: t("builder.navigator.movedInto", {
                  block: label(selected),
                  parent: target ? label(target) : t("builder.navigator.root"),
                }),
              });
            }}
          >
            <option value="">{destinations.length ? t("builder.navigator.chooseDestination") : t("builder.navigator.noDestinations")}</option>
            {destinations.map((d, i) => {
              const node = d.parentId ? findNode(blocks, d.parentId) : null;
              return (
                <option key={d.parentId ?? "root"} value={i}>
                  {" ".repeat(d.depth)}
                  {node ? label(node) : t("builder.navigator.root")}
                </option>
              );
            })}
          </select>
        </label>
      )}
    </div>
  );
}

interface NavigatorRowProps {
  row: TreeRow;
  domId: string;
  label: string;
  badges: string[];
  selected: boolean;
  tabStop: boolean;
  renaming: boolean;
  style?: React.CSSProperties;
  onFocus: () => void;
  onSelect: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onRename: (value: string) => void;
  onCancelRename: () => void;
  onStartRename: () => void;
}

function NavigatorRow({
  row,
  domId,
  label,
  badges,
  selected,
  tabStop,
  renaming,
  style,
  onFocus,
  onSelect,
  onContextMenu,
  onToggle,
  onKeyDown,
  onRename,
  onCancelRename,
  onStartRename,
}: NavigatorRowProps) {
  const { t } = useT();
  const { onPointerDown } = useBlockMoveHandle(row.node.id, row.node.type, isBlockLocked(row.node, "move"));
  return (
    <li
      id={domId}
      role="treeitem"
      aria-level={row.depth}
      aria-setsize={row.setSize}
      aria-posinset={row.position}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      className={`jf-navigator__row${selected ? " jf-navigator__row--selected" : ""}${row.match ? " jf-navigator__row--match" : ""}`}
      style={{ ...style, paddingInlineStart: (row.depth - 1) * 14 + 4 }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocus();
      }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={onStartRename}
      onKeyDown={onKeyDown}
      onPointerDown={renaming ? undefined : onPointerDown}
    >
      <span
        className="jf-navigator__toggle"
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          if (row.hasChildren) onToggle();
        }}
      >
        {row.hasChildren ? (row.expanded ? "▾" : "▸") : ""}
      </span>
      {renaming ? (
        <input
          className="jf-navigator__rename"
          aria-label={t("builder.navigator.rename")}
          defaultValue={row.node.editor?.label ?? ""}
          placeholder={label}
          autoFocus
          maxLength={80}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRename(e.currentTarget.value);
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={(e) => onRename(e.currentTarget.value)}
        />
      ) : (
        <span className="jf-navigator__label">{label}</span>
      )}
      {badges.map((badge) => (
        <span key={badge} className={`jf-navigator__badge jf-navigator__badge--${badge}`} title={t(`builder.navigator.badge.${badge}`)}>
          <span aria-hidden="true">{BADGE_ICON[badge as keyof typeof BADGE_ICON]}</span>
          <span className="jf-sr-only">{t(`builder.navigator.badge.${badge}`)}</span>
        </span>
      ))}
    </li>
  );
}

const BADGE_ICON = { reusable: "⟳", hidden: "◐", locked: "🔒", unavailable: "⚠", dynamic: "ƒ" } as const;

function rowDomId(treeId: string, id: string): string {
  return `${treeId}-row-${id}`;
}

function findNode(blocks: BlockNode[], id: string): BlockNode | null {
  for (const node of blocks) {
    if (node.id === id) return node;
    const nested = node.children ? findNode(node.children, id) : null;
    if (nested) return nested;
  }
  return null;
}

function parentTypeOf(blocks: BlockNode[], parentId: string | null): string | null {
  return parentId ? (findNode(blocks, parentId)?.type ?? null) : null;
}
