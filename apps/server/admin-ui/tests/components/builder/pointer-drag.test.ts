import { afterEach, describe, expect, it, vi } from "vitest";
import { autoScrollStep, startPointerDrag } from "../../../src/components/builder/pointer-drag";

function pointer(type: string, init: { x: number; y: number; id?: number }) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.assign(ev, { clientX: init.x, clientY: init.y, pointerId: init.id ?? 1 });
  return ev;
}

function begin() {
  const handle = document.createElement("div");
  document.body.appendChild(handle);
  const handlers = { onStart: vi.fn(), onTarget: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
  startPointerDrag(
    { pointerType: "touch", button: 0, pointerId: 1, clientX: 10, clientY: 10, currentTarget: handle } as unknown as React.PointerEvent,
    handlers,
  );
  return handlers;
}

describe("startPointerDrag", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("treats a tiny movement as a click, not a drag", () => {
    const h = begin();
    document.dispatchEvent(pointer("pointermove", { x: 12, y: 12 }));
    document.dispatchEvent(pointer("pointerup", { x: 12, y: 12 }));
    expect(h.onStart).not.toHaveBeenCalled();
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it("starts after the threshold and commits on release", () => {
    const h = begin();
    document.dispatchEvent(pointer("pointermove", { x: 40, y: 10 }));
    expect(h.onStart).toHaveBeenCalledOnce();
    document.dispatchEvent(pointer("pointerup", { x: 40, y: 10 }));
    expect(h.onCommit).toHaveBeenCalledOnce();
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("cancels instead of dropping when the pointer is cancelled", () => {
    const h = begin();
    document.dispatchEvent(pointer("pointermove", { x: 40, y: 10 }));
    document.dispatchEvent(pointer("pointercancel", { x: 40, y: 10 }));
    expect(h.onCancel).toHaveBeenCalledOnce();
    expect(h.onCommit).not.toHaveBeenCalled();
    document.dispatchEvent(pointer("pointerup", { x: 40, y: 10 }));
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    const h = begin();
    document.dispatchEvent(pointer("pointermove", { x: 40, y: 10 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.onCancel).toHaveBeenCalledOnce();
    document.dispatchEvent(pointer("pointerup", { x: 40, y: 10 }));
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it("ignores other pointers", () => {
    const h = begin();
    document.dispatchEvent(pointer("pointermove", { x: 40, y: 10, id: 2 }));
    expect(h.onStart).not.toHaveBeenCalled();
  });
});

describe("autoScrollStep", () => {
  it("scrolls up near the top, down near the bottom, and not in between", () => {
    expect(autoScrollStep(105, 100, 600)).toBeLessThan(0);
    expect(autoScrollStep(595, 100, 600)).toBeGreaterThan(0);
    expect(autoScrollStep(350, 100, 600)).toBe(0);
  });

  it("scrolls faster closer to the edge", () => {
    expect(Math.abs(autoScrollStep(101, 100, 600))).toBeGreaterThan(Math.abs(autoScrollStep(140, 100, 600)));
  });
});
