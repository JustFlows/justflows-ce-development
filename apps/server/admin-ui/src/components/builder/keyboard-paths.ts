/**
 * The keyboard way to do everything the builder offers by pointer
 * (justflows-ce#307). The Keyboard shortcuts dialog shows this list and
 * docs/BUILDER-ACCESSIBILITY.md mirrors it; a test keeps both in step.
 *
 * `keys` are written with `Mod` for Ctrl (⌘ on a Mac). An entry without keys
 * names the control to use instead, for actions whose keyboard path is a
 * button or field rather than a shortcut.
 */

export type KeyboardPathArea = "canvas" | "layers" | "library" | "text" | "layout" | "general";

export interface KeyboardPath {
  id: string;
  area: KeyboardPathArea;
  /** Key combinations; each inner array is one chord, any of them works. */
  keys: string[][];
}

export const KEYBOARD_PATHS: readonly KeyboardPath[] = [
  { id: "selectBlock", area: "canvas", keys: [["Tab"], ["Enter"]] },
  { id: "actionsMenu", area: "canvas", keys: [["Shift", "F10"], ["ContextMenu"]] },
  { id: "duplicate", area: "canvas", keys: [["Mod", "D"]] },
  { id: "group", area: "canvas", keys: [["Mod", "G"]] },
  { id: "ungroup", area: "canvas", keys: [["Mod", "Shift", "G"]] },
  { id: "remove", area: "canvas", keys: [["Delete"], ["Backspace"]] },
  { id: "copyPaste", area: "canvas", keys: [["Mod", "C"], ["Mod", "X"], ["Mod", "V"]] },
  { id: "undoRedo", area: "general", keys: [["Mod", "Z"], ["Mod", "Shift", "Z"]] },
  { id: "clearSelection", area: "canvas", keys: [["Escape"]] },
  { id: "moveBlock", area: "layers", keys: [["Alt", "ArrowUp"], ["Alt", "ArrowDown"]] },
  { id: "nestBlock", area: "layers", keys: [["Alt", "ArrowRight"], ["Alt", "ArrowLeft"]] },
  { id: "extendSelection", area: "layers", keys: [["Shift", "ArrowUp"], ["Shift", "ArrowDown"], ["Mod", "Space"]] },
  { id: "renameBlock", area: "layers", keys: [["F2"]] },
  { id: "moveTo", area: "layers", keys: [] },
  { id: "addBlock", area: "library", keys: [["Enter"], ["Space"]] },
  { id: "editText", area: "text", keys: [["Enter"], ["Escape"]] },
  { id: "replaceMedia", area: "text", keys: [["Enter"]] },
  { id: "resizeSpacing", area: "layout", keys: [["ArrowUp"], ["ArrowDown"], ["Shift", "ArrowUp"]] },
  { id: "gridPlacement", area: "layout", keys: [] },
  { id: "cancelDrag", area: "general", keys: [["Escape"]] },
  { id: "shortcuts", area: "general", keys: [["?"]] },
];

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** A key as the reader's keyboard labels it. */
export function keyLabel(key: string): string {
  if (key === "Mod") return MAC ? "⌘" : "Ctrl";
  if (key === "Alt") return MAC ? "⌥" : "Alt";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  return key;
}
