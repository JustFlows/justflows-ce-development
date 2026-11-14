import { GRID_MAX_COLUMNS, isPlacementShaped, parseBlockPlacement, type BlockPlacement } from "@justflows/blocks";
import type { BlockNode } from "./types";

export const GRID_BLOCK_TYPE = "core.grid";

export interface GridCell {
  col: number;
  row: number;
}

export function gridColumns(block: BlockNode): number {
  const raw = Number(block.props?.columns);
  if (!Number.isFinite(raw)) return GRID_MAX_COLUMNS;
  return Math.min(GRID_MAX_COLUMNS, Math.max(2, Math.round(raw)));
}

export function placementOf(block: BlockNode, columns: number): BlockPlacement {
  const props = block.props ?? {};
  const source = props.gridPlacement ?? (isPlacementShaped(props.layout) ? props.layout : undefined);
  return parseBlockPlacement(source, columns);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Which column a horizontal position falls in.
 *
 * Track widths come from the element's own box so the maths matches whatever
 * the browser laid out, gaps included — a gap makes each track slightly
 * narrower, and rounding the ratio absorbs that without needing to know it.
 */
export function columnAt(rect: { left: number; width: number }, columns: number, clientX: number): number {
  if (rect.width <= 0) return 1;
  const ratio = (clientX - rect.left) / rect.width;
  return clamp(Math.floor(ratio * columns) + 1, 1, columns);
}

/**
 * Which row a vertical position falls in, given the resolved track sizes.
 *
 * `gridTemplateRows` resolves to pixel sizes once laid out, so content-sized
 * rows can be located exactly rather than guessed from child rectangles.
 * Below the last track means a new row at the end.
 */
export function rowAt(rowSizes: number[], gap: number, top: number, clientY: number): number {
  const offset = clientY - top;
  if (offset <= 0 || rowSizes.length === 0) return 1;
  let edge = 0;
  for (let i = 0; i < rowSizes.length; i++) {
    edge += (rowSizes[i] ?? 0) + (i > 0 ? gap : 0);
    if (offset < edge) return i + 1;
  }
  return rowSizes.length + 1;
}

/** Read the resolved row track sizes off a laid-out grid element. */
export function readRowSizes(el: Element): { sizes: number[]; gap: number } {
  const style = getComputedStyle(el);
  const sizes = style.gridTemplateRows
    .split(" ")
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value));
  const gap = Number.parseFloat(style.rowGap);
  return { sizes, gap: Number.isFinite(gap) ? gap : 0 };
}

/** Move a block to a cell, keeping its width and pulling it back inside the grid. */
export function placeAt(placement: BlockPlacement, cell: GridCell, columns: number): BlockPlacement {
  const span = clamp(placement.span, 1, columns);
  return {
    ...placement,
    col: clamp(cell.col, 1, columns - span + 1),
    span,
    row: Math.max(1, cell.row),
  };
}

/** Drag the right edge: the start column stays, the width follows the pointer. */
export function resizeEnd(placement: BlockPlacement, column: number, columns: number): BlockPlacement {
  return { ...placement, span: clamp(column - placement.col + 1, 1, columns - placement.col + 1) };
}

/** Drag the left edge: the right edge stays put, the start column follows the pointer. */
export function resizeStart(placement: BlockPlacement, column: number, columns: number): BlockPlacement {
  const end = placement.col + placement.span;
  const col = clamp(column, 1, Math.min(end - 1, columns));
  return { ...placement, col, span: end - col };
}

/**
 * A width for a block arriving in a grid: half the tracks, or whatever is left
 * of the row it was dropped on, so two drops sit side by side without resizing.
 */
export function placementForDrop(cell: GridCell, columns: number): BlockPlacement {
  const half = Math.max(1, Math.round(columns / 2));
  const col = clamp(cell.col, 1, columns);
  return { col, span: Math.min(half, columns - col + 1), row: Math.max(1, cell.row), rowSpan: 1 };
}

/** The next free row, so "+ Add block" appends instead of landing on top of something. */
export function nextRow(children: BlockNode[], columns: number): number {
  let max = 0;
  for (const child of children) {
    const p = placementOf(child, columns);
    if (p.row > 0) max = Math.max(max, p.row + p.rowSpan - 1);
  }
  return max + 1;
}

/**
 * Child ids in the order the grid shows them: placed blocks by row, then
 * column; blocks without a row keep their source position after them, the
 * way CSS auto-placement fills the remaining cells. Ties keep source order.
 */
export function visualOrder(children: BlockNode[], columns: number): string[] {
  return children
    .map((child, index) => ({ child, index, p: placementOf(child, columns) }))
    .sort((a, b) => {
      const ar = a.p.row > 0 ? a.p.row : Number.POSITIVE_INFINITY;
      const br = b.p.row > 0 ? b.p.row : Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      if (a.p.row > 0 && a.p.col !== b.p.col) return a.p.col - b.p.col;
      return a.index - b.index;
    })
    .map((entry) => entry.child.id);
}

/**
 * Whether explicit grid placement shows blocks in a different order than
 * keyboard and screen-reader users meet them (justflows-ce#299).
 */
export function readingOrderDiffers(children: BlockNode[], columns: number): boolean {
  const shown = visualOrder(children, columns);
  return shown.some((id, i) => id !== children[i]?.id);
}

/** Reorder children to match what the grid shows, so reading order and visual order agree. */
export function matchReadingOrder(children: BlockNode[], columns: number): BlockNode[] {
  const byId = new Map(children.map((child) => [child.id, child]));
  return visualOrder(children, columns).map((id) => byId.get(id)!);
}
