import { useEffect, useState } from "react";

/** A CSS custom property the active theme exposes for per-block overrides. */
export interface ThemeStyleToken {
  name: string;
  label: string;
  section: string;
  description?: string;
  type: string;
  value: string;
  /** The theme's own value, and whether the site changed it (justflows-ce#301). */
  defaultValue?: string;
  overridden?: boolean;
  presets?: { label: string; value: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface ThemeStyleTokenData {
  /** Display name of the active theme, so the inspector can say what it is editing. */
  theme: string;
  tokens: ThemeStyleToken[];
  /** block type → token names to surface as first-class inspector controls. */
  blockControls: Record<string, string[]>;
}

const EMPTY: ThemeStyleTokenData = { theme: "", tokens: [], blockControls: {} };

// Fetched once per admin session; the reference list is small and rarely changes
// while the builder is open.
let cache: Promise<ThemeStyleTokenData> | null = null;

function load(): Promise<ThemeStyleTokenData> {
  if (!cache) {
    cache = fetch("/api/themes/style-tokens")
      .then((r) => (r.ok ? r.json() : EMPTY))
      .then((d: Partial<ThemeStyleTokenData>) => ({
        theme: typeof d.theme === "string" ? d.theme : "",
        tokens: Array.isArray(d.tokens) ? d.tokens : [],
        blockControls:
          d.blockControls && typeof d.blockControls === "object" ? d.blockControls : {},
      }))
      .catch(() => EMPTY);
  }
  return cache;
}

export function useThemeStyleTokens(): ThemeStyleTokenData {
  const [data, setData] = useState<ThemeStyleTokenData>(EMPTY);
  useEffect(() => {
    let alive = true;
    void load().then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  return data;
}
