import { useCallback, useEffect, useRef, useState } from "react";

const LIMIT = 60;
/** Edits closer together than this are one step, so typing does not fill history. */
const COALESCE_MS = 500;

export interface HistoryState<T> {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Call after every change that came from the editor, not from history.
   * Without options, edits closer together than the coalesce window share a
   * step. With `{ coalesce }`, only edits that share the same non-null key
   * (e.g. typing into one block) share a step; `null` always starts a new one.
   */
  record: (value: T, options?: RecordOptions) => void;
}

export interface RecordOptions {
  /** Edits with the same key inside the coalesce window are one undo step; `null` never coalesces. */
  coalesce: string | null;
}

/**
 * Undo/redo over a value the parent owns.
 *
 * History cannot live inside the state it tracks, because the same value also
 * flows in from the server on load and back out on save. So it observes: the
 * parent keeps calling `record` with what it just committed, and the hook only
 * takes over during an undo or redo, which it marks so its own write is not
 * recorded as a new step.
 */
export interface BuilderHistoryOptions {
  /** Set false when more than one `useBuilderHistory` instance can be mounted at once (e.g. a
   * mega-menu region's own builder nested inside a page that has its own history already) —
   * every instance's ⌘Z/⌘⇧Z listener is global, so more than one active at a time means a single
   * keypress undoes/redoes all of them. Defaults to true; `undo()`/`redo()` still work as calls. */
  enableShortcut?: boolean;
}

export function useBuilderHistory<T>(
  current: T,
  apply: (value: T) => void,
  options?: BuilderHistoryOptions,
): HistoryState<T> {
  const enableShortcut = options?.enableShortcut ?? true;
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastAt = useRef(0);
  /** Key of the last recorded edit; `undefined` means "time-based", the legacy behaviour. */
  const lastKey = useRef<string | null | undefined>(undefined);
  const travelling = useRef(false);
  const baseline = useRef<T>(current);
  const [, force] = useState(0);

  const rerender = useCallback(() => force((n) => n + 1), []);

  const record = useCallback((value: T, options?: RecordOptions) => {
    if (travelling.current) {
      travelling.current = false;
      baseline.current = value;
      return;
    }
    const now = Date.now();
    const key = options ? options.coalesce : undefined;
    const withinWindow = now - lastAt.current <= COALESCE_MS;
    /** Successive keystrokes collapse into the step they started from; a different kind of edit never does. */
    const continues = withinWindow && (key === undefined ? lastKey.current === undefined : key !== null && key === lastKey.current);
    lastKey.current = key;
    if (!continues) {
      past.current = [...past.current, baseline.current].slice(-LIMIT);
      future.current = [];
    }
    lastAt.current = now;
    baseline.current = value;
    rerender();
  }, [rerender]);

  const undo = useCallback(() => {
    const previous = past.current.at(-1);
    if (previous === undefined) return;
    past.current = past.current.slice(0, -1);
    future.current = [baseline.current, ...future.current].slice(0, LIMIT);
    travelling.current = true;
    lastAt.current = 0;
    lastKey.current = undefined;
    apply(previous);
    rerender();
  }, [apply, rerender]);

  const redo = useCallback(() => {
    const next = future.current[0];
    if (next === undefined) return;
    future.current = future.current.slice(1);
    past.current = [...past.current, baseline.current].slice(-LIMIT);
    travelling.current = true;
    lastAt.current = 0;
    lastKey.current = undefined;
    apply(next);
    rerender();
  }, [apply, rerender]);

  useEffect(() => {
    if (!enableShortcut) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      // A text field has its own undo stack and should keep it. The target is
      // not always an element — a key pressed with nothing focused arrives on
      // the document itself, which has no closest().
      const target = e.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo, enableShortcut]);

  return {
    undo,
    redo,
    record,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
