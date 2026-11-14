// SPDX-License-Identifier: MIT
import { useEffect, useSyncExternalStore } from "react";
import type { BlockNode } from "../components/builder/types";

/**
 * The site's reusable blocks in the admin (justflows-ce#304): one shared
 * store, so the canvas preview of a reference, the inspector and the
 * reusable block editor agree after any save.
 */

export interface ReusableItem {
  id: string;
  name: string;
  updatedAt: string;
  /** The published tree, what every page renders. */
  blocks?: BlockNode[];
  revision?: number;
  /** Unpublished changes, shown in previews and the editor only. */
  draft?: { name: string; blocks: BlockNode[]; updatedAt: string };
}

export interface ReusableUsage {
  total: number;
  contentCount: number;
  content: Array<{ id: string; title: string; type: string; locale: string; status: string }>;
  hiddenContent: number;
  templateParts: string[];
  templates: string[];
  menus: string[];
  reusableBlocks: string[];
  patterns: string[];
  truncated: boolean;
}

interface State {
  items: ReusableItem[];
  loaded: boolean;
}

let state: State = { items: [], loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function loadReusableBlocks(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = fetch("/api/reusable-blocks")
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .then((body: { items?: ReusableItem[] }) => set({ items: Array.isArray(body?.items) ? body.items : [], loaded: true }))
    .catch(() => set({ loaded: true }));
  return loading;
}

export function useReusableStore(): State & { reload: () => void } {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!state.loaded) void loadReusableBlocks();
  }, []);
  return { ...snapshot, reload: () => void loadReusableBlocks(true) };
}

/** The tree the canvas shows for a reference: the draft when there is one, like a preview. */
export function reusablePreviewBlocks(item: ReusableItem): BlockNode[] {
  return item.draft?.blocks ?? item.blocks ?? [];
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status, body });
  return body;
}

export function fetchReusableUsage(id: string): Promise<ReusableUsage> {
  return fetch(`/api/reusable-blocks/${encodeURIComponent(id)}/usage`).then((r) => json<ReusableUsage>(r));
}

/** Where to edit a reusable block, with a way back to where the author came from. */
export function reusableEditPath(id: string, back?: string): string {
  const params = new URLSearchParams();
  if (back) params.set("back", back);
  const query = params.toString();
  return `/admin/reusable/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
}

/** Test hook: forget what was loaded. */
export function resetReusableStore(): void {
  state = { items: [], loaded: false };
  loading = null;
}
