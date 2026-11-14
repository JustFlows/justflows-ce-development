// SPDX-License-Identifier: MIT
import { createContext, useContext } from "react";

/** Modifier keys of the click or key press that selects a block. */
export interface SelectModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** Where to open the block actions menu, in viewport coordinates. */
export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * Multi-selection and the block actions menu (justflows-ce#298), shared by the
 * canvas and the Layers panel. Optional: a builder without it (an embedded
 * single-select editor) keeps plain click-to-select.
 */
export interface BuilderSelection {
  /** Every selected block id. One id for an ordinary selection. */
  selectedIds: ReadonlySet<string>;
  /**
   * Extend the selection from a click with Ctrl/Cmd (toggle) or Shift
   * (range). Returns false when the event has no such modifier, so the
   * caller falls back to a plain select.
   */
  extend: (id: string, modifiers: SelectModifiers) => boolean;
  /** Open the actions menu for `id`, selecting it first unless it is already part of the selection. */
  openMenu: (id: string, anchor: MenuAnchor) => void;
}

export const BuilderSelectionContext = createContext<BuilderSelection | null>(null);

export function useBuilderSelection(): BuilderSelection | null {
  return useContext(BuilderSelectionContext);
}

/**
 * Only the selection actions, which never change identity (justflows-ce#308).
 * Canvas rows and previews use this, so selecting a block does not redraw
 * every preview; rows get the selected ids as a prop and compare them.
 */
export type BuilderSelectionActions = Pick<BuilderSelection, "extend" | "openMenu">;

export const BuilderSelectionActionsContext = createContext<BuilderSelectionActions | null>(null);

export function useBuilderSelectionActions(): BuilderSelectionActions | null {
  return useContext(BuilderSelectionActionsContext);
}

/** Whether a click should extend the selection rather than replace it. */
export function isExtendClick(e: SelectModifiers): boolean {
  return e.shiftKey || e.metaKey || e.ctrlKey;
}

/** The menu anchor for an element: just below its start edge. */
export function anchorFor(el: Element | null): MenuAnchor {
  const rect = el?.getBoundingClientRect();
  if (!rect) return { x: 16, y: 16 };
  const rtl = el ? getComputedStyle(el).direction === "rtl" : false;
  return { x: rtl ? rect.right : rect.left, y: rect.top + Math.min(rect.height, 32) };
}
