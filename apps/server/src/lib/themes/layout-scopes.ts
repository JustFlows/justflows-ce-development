// SPDX-License-Identifier: MIT

import type { ThemeLayoutScope } from "@justflows/sdk";
import { ensurePluginRuntime, getRuntimeHooks } from "../plugins/plugin-runtime.js";

const ID = /^[a-z][a-z0-9-]{0,59}$/;
const BASE = /^[a-z0-9]+(?:[-_/][a-z0-9]+)*$/;

function cleanScope(raw: unknown): ThemeLayoutScope | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const label = typeof row.label === "string" ? row.label.trim().slice(0, 80) : "";
  const base = typeof row.base === "string" ? row.base : "";
  if (!ID.test(id) || !label || !BASE.test(base) || base.length > 120) return null;
  const indexRaw = row.index;
  let index: ThemeLayoutScope["index"];
  if (indexRaw && typeof indexRaw === "object") {
    const indexRow = indexRaw as Record<string, unknown>;
    const type = typeof indexRow.type === "string" ? indexRow.type : "";
    const slug = typeof indexRow.slug === "string" ? indexRow.slug : "";
    if (ID.test(type) && ID.test(slug)) index = { type, slug };
  }
  return index ? { id, label, base, index } : { id, label, base };
}

/** Layout targets registered by active plugins. Empty when none are active. */
export async function listLayoutScopes(siteId: string): Promise<ThemeLayoutScope[]> {
  await ensurePluginRuntime();
  const raw = await getRuntimeHooks().applyFilter(
    "theme.layoutScopes",
    [],
    { siteId },
    { siteId, source: "http" },
  );
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const scopes: ThemeLayoutScope[] = [];
  for (const item of raw) {
    const scope = cleanScope(item);
    if (!scope || seen.has(scope.id)) continue;
    seen.add(scope.id);
    scopes.push(scope);
  }
  return scopes;
}

const TYPE_BASE = /^[a-z0-9]+(?:[-_/][a-z0-9]+)*$/;

/** Stored bases, plus defaults an active plugin contributes for its own types. */
export async function resolveTypeBases(
  siteId: string,
  stored: Record<string, string>,
): Promise<Record<string, string>> {
  await ensurePluginRuntime();
  const raw = await getRuntimeHooks().applyFilter(
    "permalinks.typeBases",
    stored,
    { siteId },
    { siteId, source: "http" },
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return stored;
  const bases: Record<string, string> = {};
  for (const [type, base] of Object.entries(raw)) {
    if (!ID.test(type) || typeof base !== "string" || !TYPE_BASE.test(base) || base.length > 120) continue;
    bases[type] = base;
  }
  return bases;
}
