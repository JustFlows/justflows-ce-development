// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";

/** Canvas widths the shell can preview at. `desktop` fills the available space. */
export const BUILDER_BREAKPOINTS = ["desktop", "tablet", "mobile"] as const;
export type BuilderBreakpoint = (typeof BUILDER_BREAKPOINTS)[number];

/**
 * Frame width per preview breakpoint, in CSS pixels. Tablet and mobile sit
 * inside the device buckets in `@justflows/blocks` (`DEVICE_MAX_TABLET`,
 * `DEVICE_MAX_MOBILE`), so a width preset never straddles a bucket boundary.
 */
export const BREAKPOINT_WIDTH: Record<BuilderBreakpoint, number | null> = {
  desktop: null,
  tablet: 768,
  mobile: 390,
};

export const BUILDER_ZOOM_LEVELS = [50, 75, 100] as const;
export type BuilderZoom = (typeof BUILDER_ZOOM_LEVELS)[number];

export const INSPECTOR_TABS = ["content", "style", "layout", "responsive", "interactions", "advanced"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export const LEFT_PANEL_TABS = ["library", "site"] as const;
export type LeftPanelTab = (typeof LEFT_PANEL_TABS)[number];

/**
 * Non-sensitive editor preferences. Kept per user in this browser only; never
 * written into a document or sent to the server.
 */
export interface BuilderPrefs {
  leftOpen: boolean;
  /** Which left panel shows when the shell offers site navigation. */
  leftTab: LeftPanelTab;
  rightOpen: boolean;
  breakpoint: BuilderBreakpoint;
  zoom: BuilderZoom;
  inspectorTab: InspectorTab;
}

export const DEFAULT_BUILDER_PREFS: BuilderPrefs = {
  leftOpen: true,
  leftTab: "library",
  rightOpen: true,
  breakpoint: "desktop",
  zoom: 100,
  inspectorTab: "content",
};

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** Coerce whatever storage returned; anything unrecognised falls back to the default. */
export function parseBuilderPrefs(raw: unknown): BuilderPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_BUILDER_PREFS };
  const input = raw as Record<string, unknown>;
  return {
    leftOpen: typeof input.leftOpen === "boolean" ? input.leftOpen : DEFAULT_BUILDER_PREFS.leftOpen,
    leftTab: oneOf(input.leftTab, LEFT_PANEL_TABS, DEFAULT_BUILDER_PREFS.leftTab),
    rightOpen: typeof input.rightOpen === "boolean" ? input.rightOpen : DEFAULT_BUILDER_PREFS.rightOpen,
    breakpoint: oneOf(input.breakpoint, BUILDER_BREAKPOINTS, DEFAULT_BUILDER_PREFS.breakpoint),
    zoom: oneOf(input.zoom, BUILDER_ZOOM_LEVELS, DEFAULT_BUILDER_PREFS.zoom),
    inspectorTab: oneOf(input.inspectorTab, INSPECTOR_TABS, DEFAULT_BUILDER_PREFS.inspectorTab),
  };
}

export function builderPrefsKey(userId: string | null | undefined): string {
  return `jf-builder-prefs:${userId || "anon"}`;
}

function read(key: string): BuilderPrefs {
  try {
    const stored = localStorage.getItem(key);
    return parseBuilderPrefs(stored ? JSON.parse(stored) : null);
  } catch {
    /** Storage blocked or corrupt: start from defaults. */
    return { ...DEFAULT_BUILDER_PREFS };
  }
}

/**
 * The shell's remembered layout for one user. Writes are best effort: the
 * builder works the same when storage is unavailable.
 */
export function useBuilderPrefs(userId: string | null | undefined): [BuilderPrefs, (patch: Partial<BuilderPrefs>) => void] {
  const key = builderPrefsKey(userId);
  const [state, setState] = useState<{ key: string; prefs: BuilderPrefs }>(() => ({ key, prefs: read(key) }));
  const prefs = state.key === key ? state.prefs : read(key);

  const update = useCallback(
    (patch: Partial<BuilderPrefs>) => {
      setState((prev) => {
        const base = prev.key === key ? prev.prefs : read(key);
        const next = { ...base, ...patch };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /** Storage blocked: keep the change for this session only. */
        }
        return { key, prefs: next };
      });
    },
    [key],
  );

  return [prefs, update];
}
