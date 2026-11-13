import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBuilderHistory, type BuilderHistoryOptions } from "../../../src/components/builder/useBuilderHistory";

/** Drives the hook the way PageBuilder does: parent owns the value. */
function harness(initial: string[], options?: BuilderHistoryOptions) {
  let value = initial;
  const apply = vi.fn((next: string[]) => {
    value = next;
  });
  const view = renderHook(({ current }) => useBuilderHistory(current, apply, options), {
    initialProps: { current: value },
  });
  return {
    apply,
    result: view.result,
    get value() {
      return value;
    },
    edit(next: string[]) {
      act(() => {
        value = next;
        view.result.current.record(next);
      });
      view.rerender({ current: next });
    },
  };
}

describe("useBuilderHistory", () => {
  it("has nothing to undo before anything is edited", () => {
    const h = harness(["a"]);
    expect(h.result.current.canUndo).toBe(false);
    expect(h.result.current.canRedo).toBe(false);
  });

  it("steps back to the value before the edit", () => {
    const h = harness(["a"]);
    h.edit(["a", "b"]);
    expect(h.result.current.canUndo).toBe(true);
    act(() => h.result.current.undo());
    expect(h.apply).toHaveBeenCalledWith(["a"]);
  });

  it("steps forward again after undoing", () => {
    const h = harness(["a"]);
    h.edit(["a", "b"]);
    act(() => h.result.current.undo());
    expect(h.result.current.canRedo).toBe(true);
    act(() => h.result.current.redo());
    expect(h.apply).toHaveBeenLastCalledWith(["a", "b"]);
  });

  it("does not record the value it restored as a new step", () => {
    const h = harness(["a"]);
    h.edit(["a", "b"]);
    act(() => h.result.current.undo());
    act(() => h.result.current.record(["a"]));
    // The restore is not an edit, so there is still exactly one step forward.
    expect(h.result.current.canRedo).toBe(true);
    expect(h.result.current.canUndo).toBe(false);
  });

  it("drops the redo trail once a new edit happens", () => {
    const h = harness(["a"]);
    h.edit(["a", "b"]);
    act(() => h.result.current.undo());
    act(() => h.result.current.record(["a"]));
    h.edit(["a", "c"]);
    expect(h.result.current.canRedo).toBe(false);
  });

  it("collapses edits made in quick succession into one step", () => {
    const h = harness(["a"]);
    h.edit(["a", "b"]);
    h.edit(["a", "b", "c"]);
    act(() => h.result.current.undo());
    // Both edits belong to the same step, so one undo reaches the start.
    expect(h.apply).toHaveBeenLastCalledWith(["a"]);
  });

  it("separates edits that are far enough apart", () => {
    vi.useFakeTimers();
    try {
      const h = harness(["a"]);
      h.edit(["a", "b"]);
      vi.advanceTimersByTime(2000);
      h.edit(["a", "b", "c"]);
      act(() => h.result.current.undo());
      expect(h.apply).toHaveBeenLastCalledWith(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("undoes on the keyboard, but leaves a text field's own undo alone", () => {
    const h = harness(["a"]);
    h.edit(["a", "b"]);

    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    });
    expect(h.apply).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    });
    expect(h.apply).toHaveBeenCalledWith(["a"]);
    input.remove();
  });

  it("ignores the keyboard entirely when enableShortcut is false — for a second instance mounted alongside another", () => {
    const h = harness(["a"], { enableShortcut: false });
    h.edit(["a", "b"]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    });
    expect(h.apply).not.toHaveBeenCalled();
    // undo() itself still works as a direct call (e.g. from a toolbar button).
    act(() => h.result.current.undo());
    expect(h.apply).toHaveBeenCalledWith(["a"]);
  });
});

describe("useBuilderHistory keyed steps", () => {
  function keyed(initial: string[]) {
    let value = initial;
    const apply = vi.fn((next: string[]) => {
      value = next;
    });
    const view = renderHook(({ current }) => useBuilderHistory(current, apply), { initialProps: { current: value } });
    return {
      apply,
      result: view.result,
      edit(next: string[], coalesce: string | null) {
        act(() => {
          value = next;
          view.result.current.record(next, { coalesce });
        });
        view.rerender({ current: next });
      },
    };
  }

  it("merges quick edits to the same block into one step", () => {
    const h = keyed(["a"]);
    h.edit(["ab"], "props:p1");
    h.edit(["abc"], "props:p1");
    act(() => h.result.current.undo());
    expect(h.apply).toHaveBeenLastCalledWith(["a"]);
    expect(h.result.current.canUndo).toBe(false);
  });

  it("keeps a quick structural edit separate from typing before it", () => {
    const h = keyed(["a"]);
    h.edit(["ab"], "props:p1");
    h.edit(["ab", "new"], null);
    act(() => h.result.current.undo());
    expect(h.apply).toHaveBeenLastCalledWith(["ab"]);
    expect(h.result.current.canUndo).toBe(true);
  });

  it("never merges two structural edits, however fast", () => {
    const h = keyed(["a"]);
    h.edit(["a", "b"], null);
    h.edit(["a", "b", "c"], null);
    act(() => h.result.current.undo());
    expect(h.apply).toHaveBeenLastCalledWith(["a", "b"]);
  });

  it("starts a new step when typing moves to another block", () => {
    const h = keyed(["a"]);
    h.edit(["ab"], "props:p1");
    h.edit(["abz"], "props:p2");
    act(() => h.result.current.undo());
    expect(h.apply).toHaveBeenLastCalledWith(["ab"]);
  });
});
