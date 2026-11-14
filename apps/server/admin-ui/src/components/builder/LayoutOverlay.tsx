// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SPACE_STEPS, compactBlockStyle, parseBlockStyle, type BlockStyle, type SpaceStep } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import type { BlockNode } from "./types";
import { SPACE_LABELS } from "./LayoutControls";

/**
 * Canvas overlays and resize handles for the selected block (justflows-ce#299).
 *
 * - Bands show the block's padding; dashed lines show a layout container's
 *   content box and grid tracks.
 * - Handles change padding and minimum height by dragging. They snap to the
 *   theme's spacing steps (minimum height to 5vh steps), so a drag can only
 *   store a value the style contract already allows. Each handle is a slider:
 *   arrow keys step it, Home clears it.
 */

const STEPS = SPACE_STEPS.filter((s) => s !== "") as Exclude<SpaceStep, "">[];
export const MIN_HEIGHT_STEP = 5;
const MIN_HEIGHT_MAX = 100;

/** The step whose rendered size is closest to `px`; `""` (theme default) when nothing is close to zero. */
export function snapSpace(px: number, sizes: Partial<Record<string, number>>): SpaceStep {
  let best: SpaceStep = "0";
  let bestDistance = Math.abs(px);
  for (const step of STEPS) {
    const size = sizes[step];
    if (size === undefined) continue;
    const distance = Math.abs(size - px);
    if (distance < bestDistance) {
      best = step;
      bestDistance = distance;
    }
  }
  return best;
}

/** Next or previous spacing step; `""` counts as before `0`. */
export function stepSpace(current: SpaceStep, delta: 1 | -1): SpaceStep {
  const order: SpaceStep[] = ["", ...STEPS];
  const at = Math.max(0, order.indexOf(current));
  return order[Math.min(order.length - 1, Math.max(0, at + delta))]!;
}

/** Minimum height in vh, snapped to `MIN_HEIGHT_STEP`. */
export function snapMinHeight(px: number, viewportHeight: number): number {
  if (viewportHeight <= 0) return 0;
  const vh = (px / viewportHeight) * 100;
  return Math.min(MIN_HEIGHT_MAX, Math.max(0, Math.round(vh / MIN_HEIGHT_STEP) * MIN_HEIGHT_STEP));
}

/** Rendered pixel size of each spacing token where `scope` sits. */
function measureSteps(scope: Element): Record<string, number> {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0";
  scope.appendChild(probe);
  const out: Record<string, number> = {};
  for (const step of STEPS) {
    probe.style.height = step === "0" ? "0" : `var(--space-${step})`;
    out[step] = probe.getBoundingClientRect().height;
  }
  probe.remove();
  return out;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

interface Tracks {
  box: { top: number; left: number; width: number; height: number };
  columns: { left: number; width: number }[];
}

type HandleKind = "padTop" | "padBottom" | "minHeight";

interface LayoutOverlayProps {
  block: BlockNode;
  /** Which handles the block offers (its inspector sections), and whether it may be edited at all. */
  allow: { padding: boolean; minHeight: boolean };
  onChange: (props: Record<string, unknown>) => void;
}

/**
 * Positioned over the selected block inside its canvas row, which must be
 * `position: relative`. Measurements are relative to that row.
 */
export default function LayoutOverlay({ block, allow, onChange }: LayoutOverlayProps) {
  const { t } = useT();
  const layer = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [tracks, setTracks] = useState<Tracks | null>(null);
  const [dragging, setDragging] = useState<HandleKind | null>(null);
  const style = parseBlockStyle(block.props.style);

  const target = useCallback(
    () => document.querySelector(`[data-jf-block-preview="${CSS.escape(block.id)}"]`) as HTMLElement | null,
    [block.id],
  );

  const measure = useCallback(() => {
    const host = layer.current?.parentElement;
    const el = target();
    if (!host || !el) {
      setBox(null);
      return;
    }
    const origin = host.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    setBox({
      top: rect.top - origin.top,
      left: rect.left - origin.left,
      width: rect.width,
      height: rect.height,
      padding: {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      },
    });
    const container = host.querySelector(`[data-jf-layout-container="${CSS.escape(block.id)}"]`) as HTMLElement | null;
    if (!container) {
      setTracks(null);
      return;
    }
    const crect = container.getBoundingClientRect();
    const ccs = getComputedStyle(container);
    const widths = ccs.display === "grid" ? ccs.gridTemplateColumns.split(" ").map(parseFloat).filter((n) => n > 0) : [];
    const gap = parseFloat(ccs.columnGap) || 0;
    let x = 0;
    const columns = widths.map((width) => {
      const col = { left: x, width };
      x += width + gap;
      return col;
    });
    setTracks({
      box: { top: crect.top - origin.top, left: crect.left - origin.left, width: crect.width, height: crect.height },
      columns,
    });
  }, [block.id, target]);

  useLayoutEffect(measure, [measure, block.props]);
  useEffect(() => {
    const el = target();
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, target]);

  const write = (patch: Partial<BlockStyle>) => {
    const props = { ...block.props };
    const next = compactBlockStyle(parseBlockStyle({ ...style, ...patch }));
    if (next) props.style = next;
    else delete props.style;
    onChange(props);
  };

  /** Drag a handle: the distance moved, added to the current size, snapped to a step. */
  function startDrag(kind: HandleKind, e: React.PointerEvent) {
    const el = target();
    if (!el || !box) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const sizes = measureSteps(el);
    const startSize = kind === "padTop" ? box.padding.top : kind === "padBottom" ? box.padding.bottom : box.height;
    const sign = kind === "padTop" ? -1 : 1;
    let last = "";
    setDragging(kind);
    const move = (ev: PointerEvent) => {
      const px = Math.max(0, startSize + sign * (ev.clientY - startY));
      if (kind === "minHeight") {
        const vh = snapMinHeight(px, window.innerHeight);
        if (String(vh) !== last) {
          last = String(vh);
          write({ minHeight: vh });
        }
        return;
      }
      const step = snapSpace(px, sizes);
      if (step !== last) {
        last = step;
        write({ [kind]: step } as Partial<BlockStyle>);
      }
    };
    const end = () => {
      setDragging(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onKey(kind: HandleKind, e: React.KeyboardEvent) {
    const up = e.key === "ArrowUp" || e.key === "ArrowRight";
    const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
    if (!up && !down && e.key !== "Home") return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === "minHeight") {
      const next = e.key === "Home" ? 0 : Math.min(MIN_HEIGHT_MAX, Math.max(0, style.minHeight + (up ? MIN_HEIGHT_STEP : -MIN_HEIGHT_STEP)));
      write({ minHeight: next });
      return;
    }
    const current = style[kind] as SpaceStep;
    write({ [kind]: e.key === "Home" ? "" : stepSpace(current, up ? 1 : -1) } as Partial<BlockStyle>);
  }

  const spaceText = (step: string) => (step ? (SPACE_LABELS[step] ?? step) : t("builder.layout.auto"));

  const handle = (kind: HandleKind, top: number) => {
    const value = kind === "minHeight" ? style.minHeight : STEPS.indexOf(style[kind] as never) + 1;
    const text = kind === "minHeight" ? (style.minHeight ? `${style.minHeight}vh` : t("builder.layout.auto")) : spaceText(style[kind] as string);
    return (
      <div
        key={kind}
        role="slider"
        tabIndex={0}
        aria-label={t(`builder.container.handle.${kind}`)}
        aria-valuemin={0}
        aria-valuemax={kind === "minHeight" ? MIN_HEIGHT_MAX : STEPS.length}
        aria-valuenow={Math.max(0, value)}
        aria-valuetext={text}
        className={`jf-layout-overlay__handle jf-layout-overlay__handle--${kind}${dragging === kind ? " is-dragging" : ""}`}
        style={{ top, left: box!.left + box!.width / 2 }}
        title={`${t(`builder.container.handle.${kind}`)}: ${text}`}
        onPointerDown={(e) => startDrag(kind, e)}
        onKeyDown={(e) => onKey(kind, e)}
        onClick={(e) => e.stopPropagation()}
      >
        {dragging === kind && <span className="jf-layout-overlay__value">{text}</span>}
      </div>
    );
  };

  return (
    <div ref={layer} className="jf-layout-overlay" data-builder-chrome="true">
      {box && (
        <>
          <div aria-hidden="true" className="jf-layout-overlay__pad" style={{ top: box.top, left: box.left, width: box.width, height: box.padding.top }} />
          <div
            aria-hidden="true"
            className="jf-layout-overlay__pad"
            style={{ top: box.top + box.height - box.padding.bottom, left: box.left, width: box.width, height: box.padding.bottom }}
          />
          <div aria-hidden="true" className="jf-layout-overlay__pad" style={{ top: box.top, left: box.left, width: box.padding.left, height: box.height }} />
          <div
            aria-hidden="true"
            className="jf-layout-overlay__pad"
            style={{ top: box.top, left: box.left + box.width - box.padding.right, width: box.padding.right, height: box.height }}
          />
          {tracks && (
            <div
              aria-hidden="true"
              className="jf-layout-overlay__content"
              style={{ top: tracks.box.top, left: tracks.box.left, width: tracks.box.width, height: tracks.box.height }}
            >
              {tracks.columns.map((col, i) => (
                <span key={i} className="jf-layout-overlay__track" style={{ left: col.left, width: col.width }} />
              ))}
            </div>
          )}
          {allow.padding && handle("padTop", box.top + box.padding.top)}
          {allow.padding && handle("padBottom", box.top + box.height - box.padding.bottom)}
          {allow.minHeight && handle("minHeight", box.top + box.height)}
        </>
      )}
    </div>
  );
}
