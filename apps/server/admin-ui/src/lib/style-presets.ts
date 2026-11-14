// SPDX-License-Identifier: MIT
import { useEffect, useSyncExternalStore } from "react";
import type { StylePreset } from "@justflows/blocks";

/**
 * The site's style presets in the admin (justflows-ce#301): one shared store,
 * so the inspector's preset chooser, the Styles panel and the canvas all see
 * the same list after a save. The list is the draft when there is one.
 */

export interface StylePresetUsage {
  content: Record<string, number>;
  templateParts: string[];
  templates: string[];
  reusableBlocks: number;
  patterns: number;
  total: number;
}

interface State {
  presets: StylePreset[];
  published: StylePreset[];
  hasDraft: boolean;
  loaded: boolean;
}

let state: State = { presets: [], published: [], hasDraft: false, loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

function apply(body: { items?: StylePreset[]; published?: StylePreset[]; hasDraft?: boolean }): void {
  set({
    presets: Array.isArray(body.items) ? body.items : [],
    published: Array.isArray(body.published) ? body.published : [],
    hasDraft: Boolean(body.hasDraft),
    loaded: true,
  });
}

export function loadStylePresets(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = fetch("/api/style-presets")
    .then((res) => json<{ items?: StylePreset[]; published?: StylePreset[]; hasDraft?: boolean }>(res))
    .then(apply)
    .catch(() => set({ loaded: true }));
  return loading;
}

export async function saveStylePreset(preset: { id: string; name: string; style: Record<string, unknown> }): Promise<StylePreset> {
  const body = await json<{ item: StylePreset }>(
    await fetch("/api/style-presets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preset) }),
  );
  await loadStylePresets(true);
  return body.item;
}

export async function deleteStylePreset(id: string): Promise<void> {
  await json(await fetch(`/api/style-presets/${encodeURIComponent(id)}`, { method: "DELETE" }));
  await loadStylePresets(true);
}

export async function publishStylePresets(): Promise<void> {
  apply(await json(await fetch("/api/style-presets/publish", { method: "POST" })));
}

export async function discardStylePresetDraft(): Promise<void> {
  apply(await json(await fetch("/api/style-presets/discard", { method: "POST" })));
}

export function fetchStylePresetUsage(id: string): Promise<StylePresetUsage> {
  return fetch(`/api/style-presets/${encodeURIComponent(id)}/usage`).then((res) => json<StylePresetUsage>(res));
}

export function useStylePresets(): State {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!state.loaded) void loadStylePresets();
  }, []);
  return snapshot;
}

/** A preset id from a name: lowercase, hyphens, and unique among `taken`. */
export function presetIdFromName(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 40) || "preset";
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/** Test hook: forget what was loaded. */
export function resetStylePresetStore(): void {
  state = { presets: [], published: [], hasDraft: false, loaded: false };
  loading = null;
}
