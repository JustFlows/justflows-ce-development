// SPDX-License-Identifier: MIT
import type { DropTarget } from "./DragContext";

/** Pixels a pointer must travel before a press becomes a drag, so clicks still select. */
export const DRAG_THRESHOLD = 6;
/** Distance from a scroll container's edge where dragging scrolls it. */
export const AUTO_SCROLL_EDGE = 48;
/** Largest scroll step per frame, reached at the very edge. */
export const AUTO_SCROLL_MAX_STEP = 18;

/** The element under a point; null where the environment cannot hit-test. */
function hitTest(x: number, y: number): Element | null {
  return typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
}

/** Read the drop target a canvas drop zone advertises through its data attributes. */
export function parseDropTarget(el: Element | null): DropTarget | null {
  const zone = el?.closest("[data-drop-zone]");
  if (!(zone instanceof HTMLElement)) return null;
  const parentId = zone.dataset.parentId === "root" ? null : zone.dataset.parentId ?? null;
  const parentType = zone.dataset.parentType === "root" ? null : zone.dataset.parentType ?? null;
  const index = Number(zone.dataset.index);
  if (!Number.isFinite(index)) return null;
  return { parentId, parentType, index };
}

/**
 * Scroll step for a pointer at `y` inside a container spanning `top`..`bottom`:
 * negative near the top edge, positive near the bottom, zero elsewhere, and
 * faster the closer the pointer is to the edge.
 */
export function autoScrollStep(y: number, top: number, bottom: number): number {
  if (y < top + AUTO_SCROLL_EDGE) {
    return -Math.ceil(((top + AUTO_SCROLL_EDGE - y) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_STEP);
  }
  if (y > bottom - AUTO_SCROLL_EDGE) {
    return Math.ceil(((y - (bottom - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_STEP);
  }
  return 0;
}

export interface PointerDragHandlers {
  /** The press became a drag. */
  onStart: () => void;
  /** The pointer is over this target (or none). */
  onTarget: (target: DropTarget | null) => void;
  /** Released over the last reported target. */
  onCommit: () => void;
  /** Escape, a cancelled pointer, or a lost capture: nothing may change. */
  onCancel: () => void;
}

/**
 * Track one pointer from press to release for a canvas drag. Works the same
 * for mouse, pen, and touch. The container under the pointer (or the builder
 * canvas) scrolls while the pointer is near its edge. Escape and
 * `pointercancel` cancel the drag instead of dropping it.
 */
export function startPointerDrag(e: React.PointerEvent, handlers: PointerDragHandlers): void {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;
  let moving = false;
  let lastY = startY;
  let frame = 0;
  const scroller = (e.currentTarget as HTMLElement).closest(".jf-shell__canvas") as HTMLElement | null;

  const scrollTick = () => {
    frame = 0;
    if (!moving || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    const step = autoScrollStep(lastY, rect.top, rect.bottom);
    if (step !== 0) {
      scroller.scrollTop += step;
      frame = requestAnimationFrame(scrollTick);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onKey, true);
    if (frame) cancelAnimationFrame(frame);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!moving) {
      if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      moving = true;
      handlers.onStart();
    }
    ev.preventDefault();
    lastY = ev.clientY;
    handlers.onTarget(parseDropTarget(hitTest(ev.clientX, ev.clientY)));
    if (!frame) frame = requestAnimationFrame(scrollTick);
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    if (!moving) return;
    handlers.onTarget(parseDropTarget(hitTest(ev.clientX, ev.clientY)));
    handlers.onCommit();
  };

  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    if (moving) handlers.onCancel();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    cleanup();
    if (moving) handlers.onCancel();
  };

  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
  document.addEventListener("keydown", onKey, true);
}
